/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A local endpoint that lets an LLM read this mailbox and draft replies.
 *
 * The work all happens here rather than in an external process reading the
 * profile's database, because the useful parts of Thunderbird are its own
 * APIs: Gloda ranks a search the way the search box does, MsgHdrToMimeMessage
 * gives a decoded body and the attachment list, and nsIMsgDBHdr carries the
 * tags, flags and thread structure. None of that is recoverable from the
 * SQLite file alone.
 *
 * Shape of the thing:
 *
 *   - Listens on 127.0.0.1 only, on a port the OS picks, and refuses any
 *     connection that does not come from the loopback interface.
 *   - Every request must carry a token. Tokens are created on demand, stored
 *     with the mail passwords, and can be revoked individually.
 *   - Off unless `mail.mcp.enabled` is set. Nothing listens otherwise.
 *   - Reads mail and writes drafts. There is deliberately no method that
 *     sends, moves or deletes anything: a mistake by a model should cost a
 *     draft nobody sent, not a message nobody can get back.
 *
 * The endpoint speaks JSON over HTTP; `mail-mcp-bridge.js` translates
 * between it and MCP's stdio transport, so this file needs no knowledge of
 * the MCP framing.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  AttachmentInfo: "resource:///modules/AttachmentInfo.sys.mjs",
  DownloadPaths: "resource://gre/modules/DownloadPaths.sys.mjs",
  Gloda: "resource:///modules/gloda/GlodaPublic.sys.mjs",
  GlodaMsgSearcher: "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs",
  MailServices: "resource:///modules/MailServices.sys.mjs",
  MsgHdrToMimeMessage: "resource:///modules/gloda/MimeMessage.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** Where tokens live in the login manager. Not a real network origin. */
const TOKEN_ORIGIN = "chrome://messenger/mcp";

/** Enables the listener. Off means nothing binds a port at all. */
const ENABLED_PREF = "mail.mcp.enabled";

/**
 * The port to listen on. Fixed, so a client can be configured once instead
 * of rediscovering the port after every restart, and high and unusual enough
 * to be unlikely to collide with anything else. If it is taken, the OS picks
 * one instead and mcp-endpoint.json records what was actually used.
 */
const PORT_PREF = "mail.mcp.port";

/** Requests larger than this are refused rather than buffered. */
const MAX_REQUEST_BYTES = 1024 * 1024;

/** Cap on how much body text one message may contribute. */
const MAX_BODY_CHARS = 100000;

/**
 * Whether get_attachment may hand over attachments at all. Separate from
 * ENABLED_PREF because attachments are often the most private part of a
 * mailbox -- a CV, a contract, a review -- and access to bodies need not mean
 * access to those.
 */
const ATTACHMENTS_PREF = "mail.mcp.attachments.enabled";

/** Attachments larger than this are refused rather than written out. */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** How long a single attachment may take to fetch from the server. */
const ATTACHMENT_FETCH_TIMEOUT_MS = 60000;

/**
 * How long, in seconds, a handed-out attachment stays on disk after it was
 * last asked for. Long enough for a client to read a long document a few
 * pages at a time; short enough that a CV fetched for one question is not
 * left lying about for the days Thunderbird may run. Asking for it again
 * resets the clock, and asking after it has gone fetches it again.
 */
const ATTACHMENT_LIFETIME_PREF = "mail.mcp.attachments.lifetime_seconds";
const DEFAULT_ATTACHMENT_LIFETIME_SECONDS = 600;

/**
 * Attachments on disk, by attachment URL: where each was written and the
 * timer that deletes it. Also capped, since each is a whole file.
 *
 * @type {Map<string, {path: string, expires: number, timer: number}>}
 */
const writtenAttachments = new Map();
const WRITTEN_ATTACHMENTS_MAX = 50;

/**
 * Settles once the attachment directory has been cleared at start, so that
 * nothing is written into it while a clear-out is still running.
 *
 * @type {Promise}
 */
let attachmentDirReady = Promise.resolve();

/** Whether clearing the directory at shutdown has been arranged. */
let clearsAtShutdown = false;

/**
 * Tokens: create, list, revoke.
 *
 * A token is a password in every sense that matters, so it is kept where
 * Thunderbird keeps passwords -- encrypted at rest, covered by the primary
 * password if one is set -- rather than in a config file next to the mail.
 * The value is shown once, when it is created; afterwards only its label and
 * creation date can be listed, so a leaked token cannot be read back out of
 * the profile by something that merely gets to run JavaScript here.
 */
export const MailMcpTokens = {
  /**
   * Create a token and return it. This is the only time the value is
   * available.
   *
   * @param {string} label - What it is for, e.g. "Claude Desktop".
   * @returns {Promise<{label: string, token: string, created: string}>}
   */
  async create(label) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    // Base64url: safe in an Authorization header and in a shell argument.
    const token = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const created = new Date().toISOString();
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
      Ci.nsILoginInfo
    );
    // The username carries the label and the date so that `list` can report
    // them without ever touching the password field.
    login.init(
      TOKEN_ORIGIN,
      null,
      TOKEN_ORIGIN,
      `${created}|${label || "unnamed"}`,
      token,
      "",
      ""
    );
    await Services.logins.addLoginAsync(login);
    return { label: label || "unnamed", token, created };
  },

  /**
   * @returns {Promise<Array<{id: string, label: string, created: string}>>}
   */
  async list() {
    const logins = await Services.logins.searchLoginsAsync({
      origin: TOKEN_ORIGIN,
      httpRealm: TOKEN_ORIGIN,
    });
    return logins.map(login => {
      const [created, ...rest] = login.username.split("|");
      return { id: login.username, created, label: rest.join("|") };
    });
  },

  /**
   * @param {string} id - As returned by list().
   * @returns {Promise<boolean>} Whether anything was removed.
   */
  async revoke(id) {
    const logins = await Services.logins.searchLoginsAsync({
      origin: TOKEN_ORIGIN,
      httpRealm: TOKEN_ORIGIN,
    });
    let removed = false;
    for (const login of logins) {
      if (login.username == id) {
        await Services.logins.removeLoginAsync(login);
        removed = true;
      }
    }
    return removed;
  },

  /** Revoke every token. */
  async revokeAll() {
    for (const { id } of await this.list()) {
      await this.revoke(id);
    }
  },

  /**
   * Whether a presented token matches a stored one.
   *
   * @param {string} presented
   * @returns {Promise<boolean>}
   */
  async verify(presented) {
    if (!presented) {
      return false;
    }
    const logins = await Services.logins.searchLoginsAsync({
      origin: TOKEN_ORIGIN,
      httpRealm: TOKEN_ORIGIN,
    });
    let matched = false;
    for (const login of logins) {
      // Compared in full every time rather than returning on the first
      // match, so the time taken does not depend on how much of the token
      // is correct.
      if (constantTimeEquals(login.password, presented)) {
        matched = true;
      }
    }
    return matched;
  },
};

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEquals(a, b) {
  if (typeof a != "string" || typeof b != "string" || a.length != b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff == 0;
}

// -- turning Thunderbird's objects into JSON ------------------------------

/**
 * The name a folder shows in the folder pane.
 *
 * nsIMsgFolder has no prettyName. Reading one gives undefined, which
 * JSON.stringify drops, so a header's folderName never arrived at all and a
 * folder named the way the pane names it could not be found by that name.
 *
 * @param {nsIMsgFolder} folder
 * @returns {string}
 */
function folderDisplayName(folder) {
  try {
    return String(folder.localizedName || folder.name || "");
  } catch (ex) {
    return String(folder.name ?? "");
  }
}

/**
 * The parts of a message worth sending, without its body.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {object}
 */
function headerToJson(hdr) {
  return {
    id: hdr.folder.getUriForMsg(hdr),
    messageId: hdr.messageId,
    subject: hdr.mime2DecodedSubject,
    author: hdr.mime2DecodedAuthor,
    recipients: hdr.mime2DecodedRecipients,
    ccList: hdr.ccList,
    date: hdr.date ? new Date(hdr.date / 1000).toISOString() : null,
    folder: hdr.folder.URI,
    folderName: folderDisplayName(hdr.folder),
    read: Boolean(hdr.flags & Ci.nsMsgMessageFlags.Read),
    flagged: Boolean(hdr.flags & Ci.nsMsgMessageFlags.Marked),
    tags: (hdr.getStringProperty("keywords") || "").split(/\s+/).filter(Boolean),
    hasAttachments: Boolean(hdr.flags & Ci.nsMsgMessageFlags.Attachment),
    // The thread's own id. threadParent looked like it, but for the message
    // that starts a thread it is nsMsgKey_None -- 4294967295, which is not
    // falsy -- so every root reported that instead of anything it shared
    // with its replies.
    threadId: hdr.threadId,
  };
}

/**
 * A message parsed into its MIME parts, or null if it cannot be read.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {Promise<?object>} A MimeMessage.
 */
function mimeMessageOf(hdr) {
  // Gloda registers the emitter this parse reports through. It is loaded
  // anyway in a running application, but the endpoint should not depend on
  // something else having done it first.
  void lazy.Gloda;
  return new Promise(resolve => {
    // A message whose source cannot be fetched -- offline, deleted underneath
    // us -- should degrade to nothing rather than hang the request.
    const timer = lazy.setTimeout(() => resolve(null), 15000);
    try {
      lazy.MsgHdrToMimeMessage(
        hdr,
        null,
        (returnedHdr, mimeMsg) => {
          lazy.clearTimeout(timer);
          resolve(mimeMsg ?? null);
        },
        true,
        { partsOnDemand: false, examineEncryptedParts: false }
      );
    } catch (ex) {
      lazy.clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * The decoded body and attachment list for a message.
 *
 * Each attachment carries its `index` in the list, which is how get_attachment
 * is told which one to fetch.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {Promise<{body: string, attachments: object[]}>}
 */
async function bodyOf(hdr) {
  const mimeMsg = await mimeMessageOf(hdr);
  if (!mimeMsg) {
    return { body: "", attachments: [], truncated: false };
  }
  let body = "";
  try {
    body = mimeMsg.coerceBodyToPlaintext(hdr.folder) ?? "";
  } catch (ex) {
    body = "";
  }
  const truncated = body.length > MAX_BODY_CHARS;
  return {
    body: truncated ? body.slice(0, MAX_BODY_CHARS) : body,
    truncated,
    attachments: (mimeMsg.allAttachments ?? []).map((a, index) => ({
      index,
      name: a.name,
      contentType: a.contentType,
      size: a.size,
      url: a.url,
    })),
  };
}

/**
 * The attachment a get_attachment request means: by index, by name, or the
 * only one there is. An error names what the message does hold, so a caller
 * that guessed wrong can put it right in one more call.
 *
 * @param {object[]} attachments - MimeMessageAttachments, in listed order.
 * @param {object} params - {index, name}
 * @returns {{attachment: object, index: number}}
 */
function pickAttachment(attachments, params) {
  if (!attachments.length) {
    throw new Error("the message has no attachments");
  }
  const held = () => attachments.map((a, i) => `${i}: ${a.name}`).join(", ");

  if (params?.index !== undefined && params?.index !== null) {
    const index = Number(params.index);
    if (!Number.isInteger(index) || !attachments[index]) {
      throw new Error(
        `no attachment at index ${params.index}; the message has: ${held()}`
      );
    }
    return { attachment: attachments[index], index };
  }

  if (params?.name) {
    const matches = attachments
      .map((attachment, index) => ({ attachment, index }))
      .filter(({ attachment }) => attachment.name == params.name);
    if (matches.length == 1) {
      return matches[0];
    }
    throw new Error(
      matches.length
        ? `${matches.length} attachments are named "${params.name}"; ` +
            `pass index instead: ${held()}`
        : `no attachment named "${params.name}"; the message has: ${held()}`
    );
  }

  if (attachments.length == 1) {
    return { attachment: attachments[0], index: 0 };
  }
  throw new Error(`say which attachment, by index or name: ${held()}`);
}

/**
 * Whether an attachment is stored in the message itself.
 *
 * A message can call an attachment detached and point it at a file:// path,
 * or make it a link to a web address, through part headers that any sender
 * can write. Serving those would let an email choose which local file, or
 * which URL, this reads. A part that really is in the message is addressed
 * by the same kind of URL as the message itself -- imap://, mailbox:// and
 * so on -- so the scheme has to match, and the part must not be marked
 * external.
 *
 * @param {object} attachment - A MimeMessageAttachment.
 * @param {nsIMsgDBHdr} hdr - The message it came from.
 * @returns {boolean}
 */
function isStoredInMessage(attachment, hdr) {
  if (attachment.isExternal) {
    return false;
  }
  try {
    const messageUri = hdr.folder.getUriForMsg(hdr);
    const messageUrl =
      lazy.MailServices.messageServiceFromURI(messageUri).getUrlForUri(
        messageUri
      );
    return Services.io.newURI(attachment.url).scheme == messageUrl.scheme;
  } catch (ex) {
    return false;
  }
}

/**
 * Where handed-out attachments are written.
 *
 * A directory of the endpoint's own, in this profile's cache directory
 * rather than the system's temporary one. Only one Thunderbird can have a
 * profile open, so clearing it at start cannot take files from under another
 * instance, as clearing a shared directory could; and backups leave
 * ~/Library/Caches alone, so these files never end up in one.
 *
 * @returns {string}
 */
function attachmentDir() {
  return PathUtils.join(
    Services.dirsvc.get("ProfLDS", Ci.nsIFile).path,
    "mcp-attachments"
  );
}

/**
 * A new file for an attachment, readable by this user only, in a directory
 * readable by this user only.
 *
 * @param {string} name - The attachment's name.
 * @returns {Promise<string>} The path.
 */
async function newAttachmentFile(name) {
  await attachmentDirReady;
  const dir = attachmentDir();
  await IOUtils.makeDirectory(dir, { permissions: 0o700 });
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(
    PathUtils.join(dir, lazy.DownloadPaths.sanitize(name) || "attachment")
  );
  file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
  return file.path;
}

/**
 * Delete a handed-out attachment now.
 *
 * @param {string} url - The attachment's URL.
 */
function forgetAttachment(url) {
  const entry = writtenAttachments.get(url);
  if (!entry) {
    return;
  }
  writtenAttachments.delete(url);
  lazy.clearTimeout(entry.timer);
  IOUtils.remove(entry.path, { ignoreAbsent: true }).catch(ex =>
    console.warn("Could not delete a handed-out attachment:", ex)
  );
}

/**
 * Keep a handed-out attachment for another lifetime from now, and delete it
 * when that runs out.
 *
 * @param {string} url - The attachment's URL.
 * @param {string} path - Where it was written.
 * @returns {number} When it will be deleted, in milliseconds since the epoch.
 */
function keepAttachment(url, path) {
  const earlier = writtenAttachments.get(url);
  if (earlier) {
    // The same file, kept longer: only the timer goes. Removed and set again
    // so that the map stays in order of last use for the cap below.
    lazy.clearTimeout(earlier.timer);
    writtenAttachments.delete(url);
  } else if (writtenAttachments.size >= WRITTEN_ATTACHMENTS_MAX) {
    forgetAttachment(writtenAttachments.keys().next().value);
  }
  const lifetime =
    Services.prefs.getIntPref(
      ATTACHMENT_LIFETIME_PREF,
      DEFAULT_ATTACHMENT_LIFETIME_SECONDS
    ) * 1000;
  const expires = Date.now() + lifetime;
  const timer = lazy.setTimeout(() => forgetAttachment(url), lifetime);
  writtenAttachments.set(url, { path, expires, timer });
  return expires;
}

/**
 * Delete every handed-out attachment, and whatever else is in their
 * directory -- which after a crash is files no timer is left to delete.
 *
 * @returns {Promise}
 */
function clearAttachments() {
  for (const entry of writtenAttachments.values()) {
    lazy.clearTimeout(entry.timer);
  }
  writtenAttachments.clear();
  return IOUtils.remove(attachmentDir(), {
    recursive: true,
    ignoreAbsent: true,
  }).catch(ex => console.warn("Could not clear handed-out attachments:", ex));
}

/**
 * @param {string} uri - A message URI, as returned in `id`.
 * @returns {nsIMsgDBHdr}
 */
function hdrFromUri(uri) {
  const service = lazy.MailServices.messageServiceFromURI(uri);
  return service.messageURIToMsgHdr(uri);
}

// -- the methods ----------------------------------------------------------

const Methods = {
  /**
   * Search, by text and/or by field.
   *
   * `query` is full text, ranked by Gloda exactly as the search box ranks it.
   * The filters narrow whatever that returns -- or, with no query at all,
   * narrow a folder directly, which is how "everything from her since March"
   * is answered without inventing search terms for it.
   *
   * @param {object} params - {query, from, to, subject, folder, after,
   *   before, tag, unread, flagged, hasAttachment, limit, sort}
   */
  async search(params) {
    const query = String(params?.query ?? "").trim();
    const limit = Math.min(Number(params?.limit) || 25, 200);
    const sort = String(params?.sort ?? "relevance").toLowerCase();
    if (!["relevance", "date"].includes(sort)) {
      throw new Error(
        `sort must be "relevance" or "date", not "${params.sort}"`
      );
    }
    const filters = buildFilters(params);

    let candidates = [];
    if (query) {
      // The searcher retrieves up to mailnews.database.global.search.msg.limit
      // matches -- a thousand -- whatever is asked of it: its retrieval limit
      // is a pref-backed getter with no setter. The filters run on what
      // comes back, and `limit` is applied last.
      const searcher = new lazy.GlodaMsgSearcher(null, query);

      const collection = await new Promise((resolve, reject) => {
        const timer = lazy.setTimeout(
          () => reject(new Error("search timed out")),
          30000
        );
        searcher.getCollection({
          onItemsAdded() {},
          onItemsModified() {},
          onItemsRemoved() {},
          onQueryCompleted(coll) {
            lazy.clearTimeout(timer);
            resolve(coll);
          },
        });
      });

      // Ranked here, not by the query. Gloda's score decides which thousand
      // rows pass its inner LIMIT, but the outer SELECT has no ORDER BY, so
      // the collection arrives in whatever order SQLite produced it. Taking
      // the first `limit` of that dropped the newest mail outright: a query
      // with seven hits from this week returned none of them among two
      // hundred. Search Messages pairs each item with the searcher's score
      // the same way (glodaFacetView.js, fullSet) -- the scores are computed
      // per batch in collection order, so the two line up by index.
      const scores = searcher.scores ?? [];
      const ranked = collection.items.map((item, index) => ({
        item,
        score: scores[index] ?? 0,
      }));
      const newestFirst = (a, b) => (b.item.date ?? 0) - (a.item.date ?? 0);
      ranked.sort(
        sort == "date"
          ? newestFirst
          : (a, b) => b.score - a.score || newestFirst(a, b)
      );
      for (const { item } of ranked) {
        const hdr = item.folderMessage;
        if (hdr) {
          candidates.push({
            hdr,
            snippet: item.indexedBodyText?.slice(0, 300) ?? "",
          });
        }
      }
    } else if (filters.folders.length) {
      // No text to rank by, so read the folders themselves, newest first.
      for (const folder of filters.folders) {
        // Reading .msgDatabase opens the summary; put it back afterwards if
        // it wasn't already open, so listing a folder doesn't pin it for
        // the session.
        const dbWasOpen = folder.databaseOpen;
        let database;
        try {
          database = folder.msgDatabase;
        } catch (ex) {
          continue;
        }
        try {
          // Collect the headers themselves rather than a wrapper object per
          // message: on a folder with tens of thousands of messages the
          // wrappers were the bulk of the allocation, and the snippet they
          // carried was always empty on this path anyway.
          for (const hdr of database.enumerateMessages()) {
            candidates.push(hdr);
          }
        } finally {
          if (!dbWasOpen) {
            try {
              folder.msgDatabase = null;
            } catch (ex) {
              // Already released, or in use elsewhere.
            }
          }
        }
      }
      candidates.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
      // Match the shape the gloda branch produces before the shared tail.
      candidates = candidates.map(hdr => ({ hdr, snippet: "" }));
    } else {
      throw new Error(
        "search needs a query, or a folder to filter within"
      );
    }

    const cheaplyMatched = candidates.filter(({ hdr }) => filters.matches(hdr));
    const surviving = await filterByHeaders(
      cheaplyMatched,
      filters.headers,
      limit
    );

    const messages = surviving
      .slice(0, limit)
      .map(({ hdr, snippet }) => ({ ...headerToJson(hdr), snippet }));
    return {
      query,
      // A folder read has nothing to rank by, so it is always newest first.
      sort: query ? sort : "date",
      filters: filters.describe,
      count: messages.length,
      messages,
    };
  },

  /**
   * One message, with its body and attachment list.
   *
   * @param {object} params - {id, includeBody}
   */
  async getMessage(params) {
    const hdr = hdrFromUri(String(params?.id ?? ""));
    const json = headerToJson(hdr);
    if (params?.includeBody === false) {
      return json;
    }
    return { ...json, ...(await bodyOf(hdr)) };
  },

  /**
   * One attachment, written to a private file whose path is returned, for a
   * client on this machine to read.
   *
   * The file is deleted when its lifetime runs out -- ten minutes after it
   * was last asked for -- and in any case when access is turned off or
   * Thunderbird quits; see attachmentDir(). Only a part stored in the
   * message is served -- see isStoredInMessage().
   *
   * @param {object} params - {id, index, name}
   */
  async getAttachment(params) {
    if (!Services.prefs.getBoolPref(ATTACHMENTS_PREF, true)) {
      throw new Error(
        `attachment access is turned off (${ATTACHMENTS_PREF} is false)`
      );
    }
    const hdr = hdrFromUri(String(params?.id ?? ""));
    const mimeMsg = await mimeMessageOf(hdr);
    if (!mimeMsg) {
      throw new Error("the message could not be read");
    }
    const { attachment, index } = pickAttachment(
      mimeMsg.allAttachments ?? [],
      params
    );

    if (attachment.contentType == "text/x-moz-deleted") {
      throw new Error(`"${attachment.name}" was deleted from the message`);
    }
    if (!isStoredInMessage(attachment, hdr)) {
      throw new Error(
        `"${attachment.name}" is not stored in the message -- it is ` +
          `detached or a link -- so it is not served`
      );
    }
    if (attachment.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `"${attachment.name}" is ${attachment.size} bytes, over the ` +
          `${MAX_ATTACHMENT_BYTES}-byte limit`
      );
    }

    const describe = (path, size, expires) => ({
      id: hdr.folder.getUriForMsg(hdr),
      index,
      name: attachment.name,
      contentType: attachment.contentType,
      size,
      path,
      // So a client knows the file will go, and when to ask again.
      expires: new Date(expires).toISOString(),
    });

    const earlier = writtenAttachments.get(attachment.url);
    if (earlier) {
      const stat = await IOUtils.stat(earlier.path).catch(() => null);
      if (stat) {
        return describe(
          earlier.path,
          stat.size,
          keepAttachment(attachment.url, earlier.path)
        );
      }
      forgetAttachment(attachment.url);
    }

    const info = new lazy.AttachmentInfo({
      contentType: attachment.contentType,
      url: attachment.url,
      name: attachment.name,
      uri: hdr.folder.getUriForMsg(hdr),
      isExternalAttachment: false,
      message: hdr,
    });
    // A server that stops answering must not hold the request for ever.
    let timer;
    const buffer = await Promise.race([
      info.fetchAttachment(),
      new Promise((resolve, reject) => {
        timer = lazy.setTimeout(
          () => reject(new Error(`fetching "${attachment.name}" timed out`)),
          ATTACHMENT_FETCH_TIMEOUT_MS
        );
      }),
    ]).finally(() => lazy.clearTimeout(timer));
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `"${attachment.name}" is ${buffer.byteLength} bytes, over the ` +
          `${MAX_ATTACHMENT_BYTES}-byte limit`
      );
    }

    const path = await newAttachmentFile(attachment.name);
    await IOUtils.write(path, new Uint8Array(buffer));
    return describe(
      path,
      buffer.byteLength,
      keepAttachment(attachment.url, path)
    );
  },

  /**
   * Every message in the same conversation, oldest first.
   *
   * @param {object} params - {id, includeBodies}
   */
  async getThread(params) {
    const hdr = hdrFromUri(String(params?.id ?? ""));
    // Reading .msgDatabase opens the folder's summary; release it again if
    // this call is what opened it, so a tool call doesn't pin a large
    // folder in memory for the rest of the session.
    const folder = hdr.folder;
    const dbWasOpen = folder.databaseOpen;
    const thread = folder.msgDatabase.getThreadContainingMsgHdr(hdr);
    const messages = [];
    for (let i = 0; i < thread.numChildren; i++) {
      const child = thread.getChildHdrAt(i);
      if (!child) {
        continue;
      }
      const json = headerToJson(child);
      messages.push(
        params?.includeBodies === false ? json : { ...json, ...(await bodyOf(child)) }
      );
    }
    if (!dbWasOpen) {
      try {
        folder.msgDatabase = null;
      } catch (ex) {
        // Already released, or in use elsewhere.
      }
    }
    messages.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    return { count: messages.length, messages };
  },

  /** Every folder, so a caller can name one in a search. */
  async listFolders() {
    const folders = [];
    for (const server of lazy.MailServices.accounts.allServers) {
      for (const folder of server.rootFolder.descendants) {
        folders.push({
          uri: folder.URI,
          name: folderDisplayName(folder),
          account: String(server.prettyName ?? ""),
          messages: folder.getTotalMessages(false),
          unread: folder.getNumUnread(false),
        });
      }
    }
    return { count: folders.length, folders };
  },

  /**
   * Write a draft. Nothing is sent: the draft lands in the Drafts folder for
   * the account, to be reviewed and sent by hand.
   *
   * @param {object} params - {to, cc, bcc, subject, body, from, replyTo,
   *   inReplyTo}
   */
  async createDraft(params) {
    const identity = pickIdentity(params?.from);
    if (!identity) {
      throw new Error("no identity to send from");
    }

    // Reply headers, if this is a reply to something we can find.
    let references = "";
    let inReplyTo = "";
    let subject = params?.subject ?? "";
    if (params?.inReplyTo) {
      const original = hdrFromUri(String(params.inReplyTo));
      inReplyTo = original.messageId ? `<${original.messageId}>` : "";
      references = [original.getStringProperty("references"), inReplyTo]
        .filter(Boolean)
        .join(" ");
      if (!subject) {
        const original_subject = original.mime2DecodedSubject ?? "";
        subject = /^re:/i.test(original_subject)
          ? original_subject
          : `Re: ${original_subject}`;
      }
    }

    const headers = [
      headerLine(
        "From",
        identity.fullName
          ? `${identity.fullName} <${identity.email}>`
          : identity.email,
        true
      ),
      params?.to ? headerLine("To", params.to, true) : null,
      params?.cc ? headerLine("Cc", params.cc, true) : null,
      params?.bcc ? headerLine("Bcc", params.bcc, true) : null,
      params?.replyTo ? headerLine("Reply-To", params.replyTo, true) : null,
      headerLine("Subject", subject),
      `Date: ${new Date().toUTCString()}`,
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
      references ? `References: ${references}` : null,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset=UTF-8',
      "Content-Transfer-Encoding: 8bit",
      "X-Mozilla-Draft-Info: internal/draft",
    ].filter(Boolean);

    const source = `${headers.join("\r\n")}\r\n\r\n${params?.body ?? ""}\r\n`;

    const draftsFolder = draftsFolderFor(identity);
    if (!draftsFolder) {
      throw new Error("no drafts folder for that identity");
    }

    const file = Services.dirsvc.get("TmpD", Ci.nsIFile);
    file.append(`mcp-draft-${Date.now()}.eml`);
    file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
    await IOUtils.write(file.path, new TextEncoder().encode(source));

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          file.remove(false);
        } catch (ex) {
          // Already gone, or never written.
        }
        fn(value);
      };

      // Saving to an IMAP folder is a round trip to the server, which can
      // hang for as long as the connection does. Better to say so than to
      // leave the caller waiting on a socket that will never answer.
      const deadline = lazy.setTimeout(
        () =>
          finish(
            reject,
            new Error(
              "the draft was not confirmed saved within 45 seconds; the " +
                "server may still be working on it"
            )
          ),
        45000
      );

      lazy.MailServices.copy.copyFileMessage(
        file,
        draftsFolder,
        null,
        true, // isDraft
        0,
        "",
        {
          // Without this XPConnect cannot hand the callbacks back to us, so
          // OnStopCopy never arrives and the request hangs until it is timed
          // out at the far end.
          QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
          onStartCopy() {},
          onProgress() {},
          setMessageKey() {},
          getMessageId() {
            return "";
          },
          onStopCopy(status) {
            lazy.clearTimeout(deadline);
            if (Components.isSuccessCode(status)) {
              finish(resolve);
            } else {
              finish(
                reject,
                new Error(`could not save the draft (status ${status})`)
              );
            }
          },
        },
        null
      );
    });

    return {
      saved: true,
      folder: draftsFolder.URI,
      subject,
      from: identity.email,
    };
  },

  /** So a caller can see which addresses it may write as. */
  async listIdentities() {
    const identities = [];
    for (const identity of lazy.MailServices.accounts.allIdentities) {
      identities.push({
        key: identity.key,
        email: identity.email,
        fullName: identity.fullName,
        isDefault: identity == defaultIdentity(),
      });
    }
    return { identities };
  },
};

/**
 * Header fields that are already on nsIMsgDBHdr, so they can be tested
 * without fetching the message. Anything not here falls back to reading the
 * message's own headers, which costs a fetch per message.
 */
const HEADER_SHORTCUTS = {
  subject: hdr => hdr.mime2DecodedSubject,
  from: hdr => hdr.mime2DecodedAuthor,
  sender: hdr => hdr.mime2DecodedAuthor,
  to: hdr => hdr.mime2DecodedRecipients,
  cc: hdr => hdr.ccList,
  bcc: hdr => hdr.bccList,
  "message-id": hdr => hdr.messageId,
  references: hdr => hdr.getStringProperty("references"),
  keywords: hdr => hdr.getStringProperty("keywords"),
};

/**
 * The named header of a message, from the message itself.
 *
 * @param {nsIMsgDBHdr} hdr
 * @param {string} name - Lowercase header name.
 * @returns {Promise<string>} Empty if the message has no such header.
 */
function headerFromMessage(hdr, name) {
  return new Promise(resolve => {
    const timer = lazy.setTimeout(() => resolve(""), 10000);
    try {
      lazy.MsgHdrToMimeMessage(
        hdr,
        null,
        (returnedHdr, mimeMsg) => {
          lazy.clearTimeout(timer);
          const value = mimeMsg?.headers?.[name];
          resolve(Array.isArray(value) ? value.join(" ") : String(value ?? ""));
        },
        true,
        { partsOnDemand: true, examineEncryptedParts: false }
      );
    } catch (ex) {
      resolve("");
    }
  });
}

/**
 * Apply the `headers` filter, which matches keywords against any named
 * header. Runs after the cheap filters and only on what survived them,
 * because a header not already in the database costs one message fetch to
 * read -- so this is bounded rather than allowed to walk a whole mailbox.
 *
 * @param {Array<{hdr: nsIMsgDBHdr, snippet: string}>} candidates
 * @param {object} wanted - Header name to keyword.
 * @param {number} limit - How many results are actually needed.
 * @returns {Promise<Array>}
 */
async function filterByHeaders(candidates, wanted, limit) {
  const names = Object.keys(wanted);
  if (!names.length) {
    return candidates;
  }
  const MAX_FETCHES = 300;
  let fetches = 0;
  const kept = [];

  for (const candidate of candidates) {
    let matched = true;
    for (const name of names) {
      const needle = String(wanted[name]).toLowerCase();
      const shortcut = HEADER_SHORTCUTS[name];
      let value = shortcut ? shortcut(candidate.hdr) ?? "" : null;
      if (value === null) {
        if (fetches >= MAX_FETCHES) {
          // Out of budget: stop rather than quietly returning results that
          // were never tested against the filter.
          matched = false;
          break;
        }
        fetches++;
        value = await headerFromMessage(candidate.hdr, name);
      }
      if (!String(value).toLowerCase().includes(needle)) {
        matched = false;
        break;
      }
    }
    if (matched) {
      kept.push(candidate);
      if (kept.length >= limit) {
        break;
      }
    }
  }
  return kept;
}

/**
 * Every folder a caller could mean by a name: a URI, the name shown in the
 * folder pane, the folder's own name, or the last segment of its path.
 *
 * Compared as typed rather than as escaped: a local folder's URI has its
 * spaces and non-ASCII percent-encoded ("Unsent%20Messages"), an IMAP
 * folder's does not, and nobody types a name that way.
 *
 * @param {string} name
 * @returns {nsIMsgFolder[]}
 */
function foldersNamed(name) {
  const wanted = name.toLowerCase();
  const decoded = uri => {
    try {
      return decodeURIComponent(uri);
    } catch (ex) {
      return uri;
    }
  };
  const folders = [];
  for (const server of lazy.MailServices.accounts.allServers) {
    for (const folder of server.rootFolder.descendants) {
      const uri = decoded(folder.URI).toLowerCase();
      if (
        uri == wanted ||
        uri.endsWith(`/${wanted}`) ||
        String(folder.name ?? "").toLowerCase() == wanted ||
        folderDisplayName(folder).toLowerCase() == wanted
      ) {
        folders.push(folder);
      }
    }
  }
  return folders;
}

/**
 * Turn the filter parameters into something that can test a header.
 *
 * Substring, case-insensitive, on the decoded fields -- so "liu" finds
 * "Yiqun Liu <yiqunliu@example.com>" whether the caller knows the display
 * name or the address.
 *
 * @param {object} params
 * @returns {{any: boolean, folders: nsIMsgFolder[], describe: object,
 *   matches: function(nsIMsgDBHdr): boolean}}
 */
function buildFilters(params) {
  const text = key => {
    const value = params?.[key];
    return value ? String(value).toLowerCase() : null;
  };
  const from = text("from");
  const to = text("to");
  const subject = text("subject");
  const tag = text("tag");

  const stamp = key => {
    if (!params?.[key]) {
      return null;
    }
    const when = new Date(params[key]);
    if (isNaN(when.getTime())) {
      throw new Error(`${key} is not a date: ${params[key]}`);
    }
    // nsIMsgDBHdr.date is microseconds.
    return when.getTime() * 1000;
  };
  const after = stamp("after");
  const before = stamp("before");

  const unread = params?.unread;
  const flagged = params?.flagged;
  const hasAttachment = params?.hasAttachment;

  // A folder may be named by URI or by name, and a name may match several.
  const folders = params?.folder ? foldersNamed(String(params.folder)) : [];
  if (params?.folder && !folders.length) {
    throw new Error(`no folder matches: ${params.folder}`);
  }

  // Any header, by name, matched on a keyword: {"list-id": "ntcir"}.
  const headers = {};
  for (const [name, value] of Object.entries(params?.headers ?? {})) {
    if (value !== null && value !== undefined && String(value).trim()) {
      headers[String(name).toLowerCase()] = String(value);
    }
  }

  const any = Boolean(
    from || to || subject || tag || after || before || folders.length ||
      Object.keys(headers).length ||
      unread !== undefined || flagged !== undefined ||
      hasAttachment !== undefined
  );

  return {
    any,
    folders,
    headers,
    describe: {
      headers: Object.keys(headers).length ? headers : null,
      from: params?.from ?? null,
      to: params?.to ?? null,
      subject: params?.subject ?? null,
      folder: params?.folder ?? null,
      after: params?.after ?? null,
      before: params?.before ?? null,
      tag: params?.tag ?? null,
      unread: unread ?? null,
      flagged: flagged ?? null,
      hasAttachment: hasAttachment ?? null,
    },
    matches(hdr) {
      if (from && !(hdr.mime2DecodedAuthor ?? "").toLowerCase().includes(from)) {
        return false;
      }
      if (to) {
        const recipients = `${hdr.mime2DecodedRecipients ?? ""} ${hdr.ccList ?? ""}`;
        if (!recipients.toLowerCase().includes(to)) {
          return false;
        }
      }
      if (
        subject &&
        !(hdr.mime2DecodedSubject ?? "").toLowerCase().includes(subject)
      ) {
        return false;
      }
      if (after !== null && !(hdr.date > after)) {
        return false;
      }
      if (before !== null && !(hdr.date < before)) {
        return false;
      }
      if (tag) {
        const keywords = (hdr.getStringProperty("keywords") || "").toLowerCase();
        if (!keywords.split(/\s+/).includes(tag)) {
          return false;
        }
      }
      if (unread !== undefined && unread !== null) {
        const isRead = Boolean(hdr.flags & Ci.nsMsgMessageFlags.Read);
        if (Boolean(unread) == isRead) {
          return false;
        }
      }
      if (flagged !== undefined && flagged !== null) {
        const isFlagged = Boolean(hdr.flags & Ci.nsMsgMessageFlags.Marked);
        if (Boolean(flagged) != isFlagged) {
          return false;
        }
      }
      if (hasAttachment !== undefined && hasAttachment !== null) {
        const has = Boolean(hdr.flags & Ci.nsMsgMessageFlags.Attachment);
        if (Boolean(hasAttachment) != has) {
          return false;
        }
      }
      if (folders.length && !folders.some(f => f.URI == hdr.folder.URI)) {
        return false;
      }
      return true;
    },
  };
}

/**
 * @returns {?nsIMsgIdentity}
 */
function defaultIdentity() {
  try {
    return lazy.MailServices.accounts.defaultAccount?.defaultIdentity ?? null;
  } catch (ex) {
    return null;
  }
}

/**
 * @param {?string} wanted - An email address, or nothing for the default.
 * @returns {?nsIMsgIdentity}
 */
function pickIdentity(wanted) {
  if (!wanted) {
    return defaultIdentity();
  }
  const needle = String(wanted).toLowerCase();
  for (const identity of lazy.MailServices.accounts.allIdentities) {
    if (
      identity.email?.toLowerCase() == needle ||
      identity.key == wanted
    ) {
      return identity;
    }
  }
  return null;
}

/**
 * One header line, with anything outside ASCII put into RFC 2047 encoded
 * words. A header carrying raw UTF-8 is read back by whatever single-byte
 * charset the reader assumes, which turns a Chinese subject into mojibake.
 *
 * @param {string} name - Field name, without the colon.
 * @param {string} value
 * @param {boolean} [addressing] - True for From, To, Cc, Bcc and Reply-To, so
 *   that display names are encoded and the addresses beside them are left be.
 * @returns {string}
 */
function headerLine(name, value, addressing = false) {
  const encoded = lazy.MailServices.mimeConverter.encodeMimePartIIStr_UTF8(
    value,
    addressing,
    name.length + 2,
    Ci.nsIMimeConverter.MIME_ENCODED_WORD_SIZE
  );
  return `${name}: ${encoded}`;
}

/**
 * @param {nsIMsgIdentity} identity
 * @returns {?nsIMsgFolder}
 */
function draftsFolderFor(identity) {
  // The same call the compose window makes, so a draft saved here lands where
  // one saved by hand would. Resolving it by hand is what put drafts in the
  // first account's Drafts folder regardless of which identity was asked for.
  return identity.getOrCreateDraftsFolder();
}

// -- the listener ---------------------------------------------------------

export const MailMcpServer = {
  _socket: null,

  /** @returns {boolean} */
  get running() {
    return Boolean(this._socket);
  },

  /** @returns {number} The bound port, or -1. */
  get port() {
    return this._socket?.port ?? -1;
  },

  /**
   * Start listening, if the pref allows it.
   *
   * @returns {number} The port, or -1 if disabled.
   */
  start() {
    if (this._socket) {
      return this.port;
    }
    if (!Services.prefs.getBoolPref(ENABLED_PREF, false)) {
      return -1;
    }

    const socket = Cc["@mozilla.org/network/server-socket;1"].createInstance(
      Ci.nsIServerSocket
    );
    // `true` is loopback-only, so nothing outside this machine can reach it
    // even if a firewall is misconfigured.
    const wanted = Services.prefs.getIntPref(PORT_PREF, 47821);
    try {
      socket.init(wanted, true, -1);
    } catch (ex) {
      // Something else has it. Better to run on another port -- recorded in
      // mcp-endpoint.json -- than not to run at all.
      console.warn(
        `Port ${wanted} is in use; letting the system choose one instead.`
      );
      socket.init(-1, true, -1);
    }
    // Whatever a previous run left -- after a crash, files no timer is left
    // to delete -- goes before anything new is written.
    attachmentDirReady = attachmentDirReady.then(clearAttachments);
    if (!clearsAtShutdown) {
      clearsAtShutdown = true;
      try {
        lazy.AsyncShutdown.profileBeforeChange.addBlocker(
          "Mail MCP: delete handed-out attachments",
          () => clearAttachments()
        );
      } catch (ex) {
        // Already shutting down; the next start clears up instead.
      }
    }

    socket.asyncListen({
      onSocketAccepted: (_socket, transport) => {
        // Belt and braces: init(loopback) should make this impossible, but a
        // mailbox is not the place to rely on one check.
        if (transport.host != "127.0.0.1" && transport.host != "::1") {
          transport.close(Cr.NS_ERROR_ABORT);
          return;
        }
        handleConnection(transport).catch(ex =>
          console.error("MCP connection failed:", ex)
        );
      },
      onStopListening() {},
    });
    this._socket = socket;

    // The bridge needs the port, and the port changes every start.
    IOUtils.writeJSON(
      PathUtils.join(PathUtils.profileDir, "mcp-endpoint.json"),
      { port: socket.port, url: `http://127.0.0.1:${socket.port}/rpc` }
    ).catch(ex => console.warn("Could not record the MCP port:", ex));

    console.info(`Mail MCP endpoint listening on 127.0.0.1:${socket.port}`);
    return socket.port;
  },

  stop() {
    this._socket?.close();
    this._socket = null;
    // Access turned off means nothing handed out stays behind either.
    attachmentDirReady = attachmentDirReady.then(clearAttachments);
  },

  /** Apply the pref: start or stop to match it. */
  refresh() {
    if (Services.prefs.getBoolPref(ENABLED_PREF, false)) {
      this.start();
    } else {
      this.stop();
    }
  },
};

/**
 * Read one HTTP request, answer it, close.
 *
 * Deliberately minimal: one request per connection, no keep-alive, no
 * chunked encoding. The only client is the bridge.
 *
 * @param {nsISocketTransport} transport
 */
async function handleConnection(transport) {
  const input = transport.openInputStream(0, 0, 0);
  const output = transport.openOutputStream(0, 0, 0);
  const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
    Ci.nsIBinaryInputStream
  );
  binary.setInputStream(input);

  const respond = (status, payload) => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    // Written one byte per character. nsIOutputStream.write counts what it
    // is given in characters, so handing it a JS string promises
    // Content-Length bytes and delivers fewer as soon as the response holds
    // anything outside ASCII -- a folder named in Chinese, a subject with an
    // accent -- and the client waits for the remainder that never comes.
    let encoded = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      encoded += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const head =
      `HTTP/1.1 ${status}\r\n` +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${bytes.length}\r\n` +
      "Connection: close\r\n\r\n";
    output.write(head, head.length);
    output.write(encoded, encoded.length);
    output.close();
    input.close();
  };

  try {
    let text = "";
    let headerEnd = -1;
    // A request arrives in as many pieces as the network cares to deliver,
    // so an empty read means "not yet", not "finished". Wait and try again
    // rather than treating a half-arrived request as malformed -- which made
    // requests fail or succeed purely on timing. Never blocks the main
    // thread; gives up after the deadline.
    const deadline = Date.now() + 5000;
    while (text.length < MAX_REQUEST_BYTES && Date.now() < deadline) {
      const available = binary.available();
      if (!available) {
        await new Promise(resolve => lazy.setTimeout(resolve, 5));
        continue;
      }
      text += binary.readBytes(available);
      headerEnd = text.indexOf("\r\n\r\n");
      if (headerEnd > -1) {
        const head = text.slice(0, headerEnd);
        const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
        if (text.length >= headerEnd + 4 + length) {
          break;
        }
      }
    }

    if (headerEnd < 0) {
      respond("400 Bad Request", { error: "malformed request" });
      return;
    }
    const head = text.slice(0, headerEnd);
    const body = text.slice(headerEnd + 4);

    const token = /authorization:\s*bearer\s+(\S+)/i.exec(head)?.[1] ?? "";
    if (!(await MailMcpTokens.verify(token))) {
      // Same answer whether the token is absent, malformed or simply wrong.
      respond("401 Unauthorized", { error: "a valid token is required" });
      return;
    }

    let request;
    try {
      // readBytes returns one character per byte, which is what Content-Length
      // above is counted in and so is right for the framing, but it leaves the
      // body as UTF-8 lying in a byte string. Decoding it is what turns those
      // bytes back into the characters they were sent as; without this a
      // Chinese subject arrives as mojibake and is saved that way. The
      // response side has always done the mirror of this.
      request = JSON.parse(
        body
          ? new TextDecoder().decode(Uint8Array.from(body, c => c.charCodeAt(0)))
          : "{}"
      );
    } catch (ex) {
      respond("400 Bad Request", { error: "body must be JSON" });
      return;
    }

    const method = Methods[request.method];
    if (!method) {
      respond("404 Not Found", {
        error: `no such method: ${request.method}`,
        methods: Object.keys(Methods),
      });
      return;
    }

    try {
      const result = await method(request.params ?? {});
      respond("200 OK", { result });
    } catch (ex) {
      // The message is useful to whoever is driving this; the stack is not.
      respond("500 Internal Server Error", { error: String(ex.message ?? ex) });
    }
  } catch (ex) {
    try {
      respond("500 Internal Server Error", { error: "request failed" });
    } catch (ignored) {
      // The peer is gone; nothing to report to.
    }
  }
}

/**
 * The Tools menu entry for managing access.
 *
 * Deliberately built out of the stock prompts rather than a dialog of its
 * own: the whole job is four questions, and a token that can be read back
 * out of a text field is a token that can be copied, which is the one thing
 * this has to get right.
 *
 * Strings are written here rather than in a .ftl file. This is a fork's own
 * feature and is not translated; putting them in the localisation files
 * would imply otherwise.
 */
export const MailMcpUI = {
  /**
   * @param {Window} win - The window to parent the prompts to.
   */
  async manage(win) {
    const title = "Mail access for AI";
    const enabled = Services.prefs.getBoolPref(ENABLED_PREF, false);
    const tokens = await MailMcpTokens.list();
    const port = MailMcpServer.port;

    const status =
      (enabled
        ? `Access is ON, listening on 127.0.0.1:${port > 0 ? port : "?"}.`
        : "Access is OFF. Nothing is listening.") +
      `\n${tokens.length} password${tokens.length == 1 ? "" : "s"} stored.` +
      "\n\nAn AI tool needs one of these passwords to read your mail and " +
      "write drafts. It can never send, move or delete anything.";

    const actions = [
      enabled ? "Turn access OFF" : "Turn access ON",
      "Create a new password",
      "Show stored passwords",
      "Delete a password",
      "Delete all passwords",
    ];

    const chosen = { value: 0 };
    if (!Services.prompt.select(win, title, status, actions, chosen)) {
      return;
    }

    switch (chosen.value) {
      case 0: {
        Services.prefs.setBoolPref(ENABLED_PREF, !enabled);
        MailMcpServer.refresh();
        const nowOn = Services.prefs.getBoolPref(ENABLED_PREF, false);
        Services.prompt.alert(
          win,
          title,
          nowOn
            ? `Access is on, listening on 127.0.0.1:${MailMcpServer.port}. ` +
                "Only programs on this computer can reach it, and only with " +
                "a password."
            : "Access is off. Nothing is listening."
        );
        break;
      }

      case 1: {
        const label = { value: "" };
        if (
          !Services.prompt.prompt(
            win,
            title,
            "What is this password for? (e.g. Claude Desktop)",
            label,
            null,
            {}
          )
        ) {
          return;
        }
        const { token } = await MailMcpTokens.create(label.value.trim());
        try {
          Cc["@mozilla.org/widget/clipboardhelper;1"]
            .getService(Ci.nsIClipboardHelper)
            .copyString(token);
        } catch (ex) {
          // Not fatal: it is still on screen to copy by hand.
        }
        // Shown in an editable field so it can be selected and copied. This
        // is the only time it can be read; afterwards only its label is kept.
        Services.prompt.prompt(
          win,
          title,
          "Here is the password. It has been copied to the clipboard, and " +
            "cannot be shown again.",
          { value: token },
          null,
          {}
        );
        break;
      }

      case 2: {
        const text = tokens.length
          ? tokens
              .map(t => `${t.label} -- created ${t.created.slice(0, 16).replace("T", " ")}`)
              .join("\n")
          : "No passwords stored.";
        Services.prompt.alert(win, title, text);
        break;
      }

      case 3: {
        if (!tokens.length) {
          Services.prompt.alert(win, title, "No passwords stored.");
          return;
        }
        const which = { value: 0 };
        const names = tokens.map(
          t => `${t.label} (${t.created.slice(0, 10)})`
        );
        if (
          !Services.prompt.select(
            win,
            title,
            "Which password should stop working?",
            names,
            which
          )
        ) {
          return;
        }
        await MailMcpTokens.revoke(tokens[which.value].id);
        Services.prompt.alert(win, title, "That password no longer works.");
        break;
      }

      case 4: {
        if (
          Services.prompt.confirm(
            win,
            title,
            `Delete all ${tokens.length} passwords? Anything using them will ` +
              "stop working."
          )
        ) {
          await MailMcpTokens.revokeAll();
          Services.prompt.alert(win, title, "All passwords deleted.");
        }
        break;
      }
    }
  },
};
