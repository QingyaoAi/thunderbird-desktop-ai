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
 *   - Reads mail, writes drafts and tags messages. There is deliberately no
 *     method that sends anything, or that moves or deletes a message: a
 *     mistake by a model should cost a draft nobody sent or a tag to take
 *     off, not a message nobody can get back. The one thing it removes is the
 *     version of a draft it has been asked to change, and that goes to the
 *     Trash.
 *
 * Two ways in. `/rpc` is plain JSON over HTTP, which `mail-mcp-bridge.js`
 * translates to MCP's stdio transport for clients that start servers as
 * programs. `/mcp` is MCP itself over Streamable HTTP, for clients that can
 * be given a URL -- the harness the AI panel starts is one.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  AttachmentInfo: "resource:///modules/AttachmentInfo.sys.mjs",
  DownloadPaths: "resource://gre/modules/DownloadPaths.sys.mjs",
  Gloda: "resource:///modules/gloda/GlodaPublic.sys.mjs",
  GlodaMsgSearcher: "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs",
  MailServices: "resource:///modules/MailServices.sys.mjs",
  // The message the compose window writes out when it saves, as opposed to
  // gloda's MimeMessage below, which is a message read back.
  MimeMessage: "resource:///modules/MimeMessage.sys.mjs",
  MimeParser: "resource:///modules/mimeParser.sys.mjs",
  MsgHdrToMimeMessage: "resource:///modules/gloda/MimeMessage.sys.mjs",
  MsgUtils: "resource:///modules/MimeMessageUtils.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  jsmime: "resource:///modules/jsmime.sys.mjs",
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
 * The files attached to one draft may come to no more than this together. A
 * draft is a whole message, held in memory while it is put together and then
 * sent to the server in one piece, and few servers take a larger one anyway.
 */
const MAX_DRAFT_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 * How long saving a draft may take before the caller is told it was not
 * confirmed: this long, and longer for a large one at DRAFT_SAVE_BYTES_PER_MS,
 * but never more than DRAFT_SAVE_TIMEOUT_MAX_MS.
 */
const DRAFT_SAVE_TIMEOUT_MS = 45000;
const DRAFT_SAVE_BYTES_PER_MS = 100;
const DRAFT_SAVE_TIMEOUT_MAX_MS = 300000;

/** How long to wait for a saved draft to appear in its folder's database. */
const DRAFT_APPEAR_TIMEOUT_MS = 10000;

/** nsMsgKey_None: the key of no message. */
const NO_KEY = 0xffffffff;

/** The priorities a draft can be given, by the names a caller gives them. */
const PRIORITIES = ["highest", "high", "normal", "low", "lowest"];

/** The formats a draft can be sent in, by the names a caller gives them. */
const SEND_FORMATS = ["auto", "plain", "html", "both"];

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
    const token = newToken();
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
   * Tokens that exist only in memory, for a program Thunderbird starts itself
   * and hands the token to directly. Nothing is stored, so nothing outlives
   * the program or this session, and nothing appears in the list of
   * passwords the user manages.
   *
   * @type {Set<string>}
   */
  _ephemeral: new Set(),

  /**
   * Create an in-memory token. Revoke it when the program it was given to
   * stops; it is gone at shutdown regardless.
   *
   * @returns {string}
   */
  createEphemeral() {
    const token = newToken();
    this._ephemeral.add(token);
    return token;
  },

  /**
   * @param {string} token - As returned by createEphemeral().
   */
  revokeEphemeral(token) {
    this._ephemeral.delete(token);
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
    for (const candidate of [
      ...logins.map(login => login.password),
      ...this._ephemeral,
    ]) {
      // Compared in full every time rather than returning on the first
      // match, so the time taken does not depend on how much of the token
      // is correct.
      if (constantTimeEquals(candidate, presented)) {
        matched = true;
      }
    }
    return matched;
  },
};

/**
 * A new random token: 32 bytes, base64url, which is safe in an Authorization
 * header and in a shell argument.
 *
 * @returns {string}
 */
function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

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
   * The body is given as text. Asked for, it is given as HTML as well, which
   * is how a draft's text can be changed and its formatting kept: the HTML
   * is read, changed, and handed to updateDraft.
   *
   * @param {object} params - {id, includeBody, html}
   */
  async getMessage(params) {
    const hdr = hdrFromUri(String(params?.id ?? ""));
    const json = headerToJson(hdr);
    if (params?.includeBody === false) {
      return json;
    }
    return {
      ...json,
      ...(await bodyOf(hdr)),
      ...(isSet(params?.html) ? await htmlOf(hdr) : {}),
    };
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
   * It is written the way the compose window would have written it -- in the
   * format the identity composes in, with its signature and the addresses it
   * always copies -- so that opening it to send is like opening any other
   * draft. It used to be a plain-text message put together here, which opened
   * in the plain-text editor whatever the identity normally used.
   *
   * @param {object} params - {to, cc, bcc, subject, body, html, from, replyTo,
   *   inReplyTo, attachments, priority, returnReceipt,
   *   deliveryStatusNotification, deliveryFormat, attachmentReminder,
   *   attachVCard}
   */
  async createDraft(params) {
    const identity = pickIdentity(params?.from);
    if (!identity) {
      throw new Error("no identity to send from");
    }

    // Reply headers, if this is a reply to something we can find.
    let references = "";
    let subject = String(params?.subject ?? "");
    let original = null;
    if (params?.inReplyTo) {
      const replied = hdrFromUri(String(params.inReplyTo));
      const inReplyTo = replied.messageId ? `<${replied.messageId}>` : "";
      references = [replied.getStringProperty("references"), inReplyTo]
        .filter(Boolean)
        .join(" ");
      if (!subject) {
        const original_subject = replied.mime2DecodedSubject ?? "";
        subject = /^re:/i.test(original_subject)
          ? original_subject
          : `Re: ${original_subject}`;
      }
      original = { uri: String(params.inReplyTo), disposition: "replied" };
    }

    const folder = draftsFolderFor(identity);
    if (!folder) {
      throw new Error("no drafts folder for that identity");
    }
    // What the compose window sets for the identity when a message is begun,
    // unless something else is asked for.
    const options = draftOptions(params, {
      priority: "",
      returnReceipt: identity.requestReturnReceipt,
      receiptHeaderType: identity.receiptHeaderType,
      DSN: identity.requestDSN,
      attachVCard: identity.attachVCard,
      attachmentReminder: false,
      deliveryFormat: Ci.nsIMsgCompSendFormat.Unset,
    });

    const written = [];
    try {
      return await saveDraft(
        {
          identity,
          to: String(params?.to ?? ""),
          // What the compose window fills in for the identity, likewise. A
          // draft is opened as it was saved, so they would not be added
          // later.
          cc: withIdentityAddresses(
            params?.cc,
            identity.doCc ? identity.doCcList : ""
          ),
          bcc: withIdentityAddresses(
            params?.bcc,
            identity.doBcc ? identity.doBccList : ""
          ),
          replyTo: withIdentityAddresses(params?.replyTo, identity.replyTo),
          subject,
          references,
          ...(await writtenBody(identity, params, Boolean(original), written)),
          attachments: filesToAttach(params?.attachments),
          options,
          original,
        },
        folder
      );
    } finally {
      removeFiles(written);
    }
  },

  /**
   * Change a draft: save it again with what was asked for changed and the
   * rest as it was, then put the version it replaces in the Trash.
   *
   * A message on the server cannot be edited, so this is what the compose
   * window does when a draft is saved a second time. The earlier version is
   * deleted only once the new one is confirmed saved, and to the Trash rather
   * than for good: the draft may be one the user wrote.
   *
   * @param {object} params - {id, to, cc, bcc, subject, body, html, from,
   *   replyTo, attachments, removeAttachments, priority, returnReceipt,
   *   deliveryStatusNotification, deliveryFormat, attachmentReminder,
   *   attachVCard}
   */
  async updateDraft(params) {
    const id = String(params?.id ?? "");
    let earlier;
    try {
      earlier = hdrFromUri(id);
    } catch (ex) {
      earlier = null;
    }
    if (!earlier) {
      throw new Error(`no draft with id ${id}`);
    }
    // The check that keeps this from deleting anything but a draft.
    if (!isDraftsFolder(earlier.folder)) {
      throw new Error(
        "that message is not in a Drafts folder, and only a draft can be " +
          "changed"
      );
    }

    const was = await readDraft(earlier);
    const identity = params?.from
      ? pickIdentity(params.from)
      : identityOfDraft(was.headers);
    if (!identity) {
      throw new Error("no identity to send from");
    }
    const folder = params?.from ? draftsFolderFor(identity) : earlier.folder;
    if (!folder) {
      throw new Error("no drafts folder for that identity");
    }

    // A field that was not given stays; one given empty is cleared.
    const given = name => params?.[name] !== undefined && params[name] !== null;
    const field = (name, header = name) =>
      given(name) ? String(params[name]) : decodedHeader(was.headers, header);
    const references = (was.headers.getRawHeader("references") ?? []).join(" ");

    const options = draftOptions(params, optionsOfDraft(was.headers, identity));
    const staying = attachmentsLeft(was, params?.removeAttachments);
    const added = filesToAttach(params?.attachments);

    // The parts being carried over are in the earlier version, which is
    // about to go, so they are written out to be attached again from files.
    const written = [];
    try {
      const carried = async part => {
        const path = await newAttachmentFile(part.name);
        written.push(path);
        await IOUtils.write(path, part.bytes);
        return attachmentOf(path, part);
      };
      const kept = [];
      for (const part of staying) {
        kept.push(await carried(part));
      }

      // Pictures set in the text belong to the text they are set in: all of
      // them stay with text that stays, and with new text the ones it still
      // shows, along with any it brings.
      const rewritten = given("body") || given("html");
      const body = rewritten
        ? await writtenBody(identity, params, Boolean(references), written)
        : { ...keptBody(was, identity), embedded: [] };
      const shown = new Set(
        Array.from(body.body.matchAll(/\bcid:([^"'\s)>]+)/g), match => match[1])
      );
      const embedded = [...body.embedded];
      for (const part of was.embedded) {
        if (!rewritten || shown.has(part.contentId)) {
          embedded.push(await carried(part));
        }
      }

      const originalUri = earlier.getStringProperty("origURIs");
      const result = await saveDraft(
        {
          identity,
          to: field("to"),
          cc: field("cc"),
          bcc: field("bcc"),
          replyTo: field("replyTo", "reply-to"),
          subject: given("subject")
            ? String(params.subject)
            : String(was.headers.get("subject") ?? ""),
          references,
          ...body,
          attachments: [...kept, ...added],
          embedded,
          fcc: (was.headers.getRawHeader("fcc") ?? [])[0] ?? "",
          options,
          original: originalUri
            ? {
                uri: originalUri,
                disposition: earlier.getStringProperty("queuedDisposition"),
              }
            : null,
        },
        folder,
        earlier
      );
      return { ...result, replaced: id };
    } finally {
      removeFiles(written);
    }
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

  /** The tags a message can be given, with the names the user sees. */
  async listTags() {
    return {
      tags: lazy.MailServices.tags.getAllTags().map(tag => ({
        key: tag.key,
        name: tag.tag,
        color: tag.color,
      })),
    };
  },

  /**
   * Add tags to messages, or take them off. Nothing else about a message can
   * be changed here, and a tag is undone by taking it off again.
   *
   * @param {object} params - {ids, add, remove}: message ids from search,
   *   and tags by key or by name.
   */
  async tagMessages(params) {
    const ids = [params?.ids ?? params?.id].flat().filter(Boolean);
    if (!ids.length) {
      throw new Error("ids is required: message ids from search_mail");
    }
    if (ids.length > MAX_TAGGED_MESSAGES) {
      throw new Error(
        `at most ${MAX_TAGGED_MESSAGES} messages at a time; split the list`
      );
    }
    const add = resolveTags(params?.add);
    const remove = resolveTags(params?.remove);
    if (!add.length && !remove.length) {
      throw new Error("give tags to add, to remove, or both");
    }

    const byFolder = new Map();
    const hdrs = [];
    for (const id of ids) {
      let hdr;
      try {
        hdr = hdrFromUri(String(id));
      } catch (ex) {
        hdr = null;
      }
      if (!hdr) {
        throw new Error(`no message with id ${id}`);
      }
      hdrs.push(hdr);
      const list = byFolder.get(hdr.folder) ?? [];
      list.push(hdr);
      byFolder.set(hdr.folder, list);
    }

    for (const [folder, messages] of byFolder) {
      if (add.length) {
        folder.addKeywordsToMessages(messages, add.join(" "));
      }
      if (remove.length) {
        folder.removeKeywordsFromMessages(messages, remove.join(" "));
      }
    }
    return { messages: hdrs.map(headerToJson) };
  },
};

/** How many messages one tagging call may touch. */
const MAX_TAGGED_MESSAGES = 500;

/**
 * Tag keys for what a caller named, by key or by the name the user sees.
 * An unknown name is an error rather than a new tag: making tags is the
 * user's business, and a misspelling should not quietly add one.
 *
 * @param {?(string|string[])} wanted
 * @returns {string[]}
 */
function resolveTags(wanted) {
  const tags = lazy.MailServices.tags.getAllTags();
  return [wanted ?? []].flat().map(name => {
    const text = String(name).trim();
    const tag =
      tags.find(t => t.key == text) ??
      tags.find(t => t.tag.toLowerCase() == text.toLowerCase());
    if (!tag) {
      throw new Error(
        `no tag named "${text}"; the tags are: ` +
          tags.map(t => `${t.tag} (${t.key})`).join(", ")
      );
    }
    return tag.key;
  });
}

// -- MCP over Streamable HTTP ---------------------------------------------

/**
 * What create_draft and update_draft both take for a draft's text and for
 * what is chosen in the compose window's Options menu.
 */
const DRAFT_PROPERTIES = {
  body: {
    type: "string",
    description:
      "The text, plain, with a blank line between paragraphs. No Markdown, " +
      "and not the user's signature, which is added. For text that needs " +
      "formatting, give html instead.",
  },
  html: {
    type: "string",
    description:
      "The text as HTML, instead of body, when it needs formatting: bold, " +
      "colour, lists, links, tables. Only what goes in the body, not a " +
      "whole page. A picture is set in the text with an <img> whose src is " +
      "a file's full path. Leave the user's signature out, unless it is in " +
      "HTML you read from the draft.",
  },
  priority: { type: "string", enum: PRIORITIES },
  returnReceipt: {
    type: "boolean",
    description: "Ask for a receipt when the message is read",
  },
  deliveryStatusNotification: {
    type: "boolean",
    description: "Ask the mail server to report the message's delivery",
  },
  deliveryFormat: {
    type: "string",
    enum: SEND_FORMATS,
    description:
      "What the message is sent as: auto (plain text unless it has " +
      "formatting), plain, html, or both",
  },
  attachmentReminder: {
    type: "boolean",
    description: "Remind the user to attach something before it is sent",
  },
  attachVCard: {
    type: "boolean",
    description: "Send the user's contact card with the message",
  },
};

/**
 * The tools offered over `/mcp`, each with the method above that does its
 * work. `mail-mcp-bridge.js` keeps its own copy of the first eight for the
 * stdio route; a change to one of those belongs in both.
 */
const MCP_TOOLS = [
  {
    name: "search_mail",
    method: "search",
    description:
      "Search the user's mailbox. `query` is full-text and ranked the way " +
      "Thunderbird's own search ranks it. The other fields narrow the " +
      "results, and may be used without a query as long as a folder is " +
      "given. Dates are ISO 8601. Search when the task is about the " +
      "user's mail, or when you have been asked to look there -- not for " +
      "background to work on files or documents, such as instructions, " +
      "comments or someone's details, that nobody said came by email.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Full-text search terms" },
        from: { type: "string", description: "Sender, name or address" },
        to: { type: "string", description: "Recipient, name or address" },
        subject: { type: "string" },
        folder: { type: "string", description: "Folder name or URI" },
        after: { type: "string", description: "Only messages after this date" },
        before: {
          type: "string",
          description: "Only messages before this date",
        },
        tag: { type: "string", description: "Tag key, e.g. $label1" },
        unread: { type: "boolean" },
        flagged: { type: "boolean" },
        hasAttachment: { type: "boolean" },
        headers: {
          type: "object",
          description:
            "Match keywords against any named header, e.g. " +
            '{"list-id": "ntcir"}. Headers the database already holds are ' +
            "free; others cost one message read each, so this is applied " +
            "after the other filters and is bounded.",
          additionalProperties: { type: "string" },
        },
        sort: {
          type: "string",
          enum: ["relevance", "date"],
          description:
            "Order of a text search. relevance (the default) is " +
            "Thunderbird's own ranking, newest first among equal matches; " +
            "date is newest first regardless. Use date for questions about " +
            "the latest or most recent mail. A folder read with no query is " +
            "always newest first.",
        },
        limit: { type: "number", description: "Default 25, maximum 200" },
      },
    },
  },
  {
    name: "get_message",
    method: "getMessage",
    description:
      "One message in full: headers, decoded body and the list of its " +
      "attachments. Takes an id from search_mail.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        includeBody: { type: "boolean" },
        html: {
          type: "boolean",
          description:
            "Also return the body as HTML -- for a draft whose formatted " +
            "text is to be changed with update_draft",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_attachment",
    method: "getAttachment",
    description:
      "Save one attachment of a message to a private temporary file and " +
      "return its path, to read with a file tool -- PDFs and images " +
      "included. Takes the message id and the attachment's index from " +
      "get_message, or its name; with only one attachment, neither is " +
      "needed. Only files stored in the message are served, not detached " +
      "files or links. The file is deleted ten minutes after it was last " +
      "asked for (the result says when); ask again to keep it, or to get " +
      "it back once it has gone.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        index: {
          type: "number",
          description: "Position in get_message's attachments list",
        },
        name: { type: "string", description: "The attachment's file name" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_thread",
    method: "getThread",
    description:
      "Every message in the same conversation as the given one, oldest " +
      "first.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        includeBodies: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_folders",
    method: "listFolders",
    description: "Every mail folder, with message and unread counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_identities",
    method: "listIdentities",
    description: "The addresses the user can write as.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_draft",
    method: "createDraft",
    description:
      "Save a draft for the user to review and send by hand. Nothing is " +
      "sent. Pass inReplyTo with a message id to draft a reply, which fills " +
      "in the reply headers and subject. The draft is saved in the format " +
      "the user writes mail in, with their signature after the text and " +
      "the addresses they always copy. Everything the compose window sets " +
      "can be set: formatted text, pictures in it, attachments, priority, " +
      "receipts. Returns the draft's id: link the draft with it, and to " +
      "change the draft pass it to update_draft rather than writing another.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        cc: { type: "string" },
        bcc: { type: "string" },
        subject: { type: "string" },
        ...DRAFT_PROPERTIES,
        from: { type: "string", description: "Which identity to write as" },
        replyTo: { type: "string" },
        inReplyTo: {
          type: "string",
          description: "Message id being replied to",
        },
        attachments: {
          type: "array",
          items: { type: "string" },
          description:
            "Files on this computer to attach, each by its full path -- " +
            "one from get_attachment included",
        },
      },
    },
  },
  {
    name: "update_draft",
    method: "updateDraft",
    description:
      "Change a draft where it is: one create_draft saved, or any other " +
      "message in a Drafts folder. Give its id and only what is to change; " +
      "everything else stays as it was -- text, formatting, attachments " +
      "and settings. A field given as an empty string is cleared. New text " +
      "replaces the whole text: to change part of a draft and keep its " +
      "formatting, read it with get_message and html: true, change that " +
      "HTML, and give all of it back as html. The draft is saved again, so " +
      "it has a new id, which is returned, and the version it replaces " +
      "goes to the Trash. Nothing is sent.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The draft's id" },
        to: { type: "string" },
        cc: { type: "string" },
        bcc: { type: "string" },
        subject: { type: "string" },
        ...DRAFT_PROPERTIES,
        from: { type: "string", description: "Which identity to write as" },
        replyTo: { type: "string" },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: "Files to add, each by its full path",
        },
        removeAttachments: {
          type: "array",
          items: { type: "string" },
          description: "Attachments to take off, by name",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "list_tags",
    method: "listTags",
    description:
      "The tags the user has, with the names they see, their keys and " +
      "colours. Use a name or a key from here with tag_messages or with " +
      "search_mail's tag filter.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tag_messages",
    method: "tagMessages",
    description:
      "Add tags to messages, or take them off -- the one change to a " +
      "message this allows. Tags are named by name or key, from list_tags; " +
      "an unknown name is an error, not a new tag. Tagging a message " +
      "Important also stars it, and taking Important off unstars it. " +
      "Returns each message as it now is.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Message ids from search_mail, at most 500",
        },
        add: {
          type: "array",
          items: { type: "string" },
          description: "Tags to add, by name or key",
        },
        remove: {
          type: "array",
          items: { type: "string" },
          description: "Tags to take off, by name or key",
        },
      },
      required: ["ids"],
    },
  },
];

/**
 * What a client is told about this server: mostly how to point the user at a
 * message, since a message's id is its URI and the AI panel shows the message
 * when a link to one is clicked. Clients that honour server instructions put
 * this in front of the model. dsh does not, for a server its client attaches,
 * so the AI panel's dsh is given the same rule in its persona (DshAgent).
 */
const MCP_INSTRUCTIONS =
  "This is the user's own mailbox in Thunderbird. A message's id -- as " +
  "search_mail, get_message and get_thread return it -- is also a link to " +
  "that message in Thunderbird. Whenever an answer mentions a particular " +
  "message, link it in Markdown with its id in angle brackets as the target: " +
  "[short subject or description](<id>). The user can click it to open the " +
  "message. Copy ids exactly as given, and never write one that did not come " +
  "from a tool result.";

/** MCP protocol revisions this endpoint answers to, newest first. */
const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * MCP's JSON-RPC, one message at a time: the part of an MCP server that does
 * not care how the messages arrive.
 */
export const McpProtocol = {
  /**
   * @param {object} message - One JSON-RPC message.
   * @returns {Promise<?object>} The response, or null for a notification.
   */
  async handle(message) {
    // JSON-RPC allows an id of 0, so only its absence makes a notification.
    const isRequest = message?.id !== undefined && message?.id !== null;
    const reply = result => ({ jsonrpc: "2.0", id: message.id, result });
    const fail = (code, text) => ({
      jsonrpc: "2.0",
      id: message?.id ?? null,
      error: { code, message: text },
    });

    switch (message?.method) {
      case "initialize": {
        const wanted = message.params?.protocolVersion;
        return reply({
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(wanted)
            ? wanted
            : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "thunderbird-mail", version: "1.0.0" },
          instructions: MCP_INSTRUCTIONS,
        });
      }

      case "ping":
        return reply({});

      case "tools/list":
        return reply({
          tools: MCP_TOOLS.map(({ method: _method, ...tool }) => tool),
        });

      case "tools/call": {
        const tool = MCP_TOOLS.find(t => t.name == message.params?.name);
        if (!tool) {
          return fail(-32602, `no such tool: ${message.params?.name}`);
        }
        try {
          const result = await Methods[tool.method](
            message.params?.arguments ?? {}
          );
          return reply({
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          });
        } catch (ex) {
          // A tool result rather than a protocol error, so the model can
          // read what went wrong and try something else.
          return reply({
            content: [{ type: "text", text: `Error: ${ex.message ?? ex}` }],
            isError: true,
          });
        }
      }

      default:
        return isRequest
          ? fail(-32601, `unknown method: ${message?.method}`)
          : null;
    }
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
 * @param {nsIMsgIdentity} identity
 * @returns {?nsIMsgFolder}
 */
function draftsFolderFor(identity) {
  // The same call the compose window makes, so a draft saved here lands where
  // one saved by hand would. Resolving it by hand is what put drafts in the
  // first account's Drafts folder regardless of which identity was asked for.
  return identity.getOrCreateDraftsFolder();
}

/**
 * Whether a folder is one drafts are kept in.
 *
 * @param {nsIMsgFolder} folder
 * @returns {boolean}
 */
function isDraftsFolder(folder) {
  return (
    folder.getFlag(Ci.nsMsgFolderFlags.Drafts) ||
    lazy.MailServices.accounts.allIdentities.some(
      identity => identity.draftsFolderURI == folder.URI
    )
  );
}

/**
 * A list of addresses with the ones an identity always adds put first, the
 * way the compose window fills in the Cc, Bcc and Reply-To of a new message.
 *
 * @param {?string} given - What the caller asked for.
 * @param {?string} automatic - What the identity adds, if anything.
 * @returns {string}
 */
function withIdentityAddresses(given, automatic) {
  const theirs = String(given ?? "").trim();
  const mine = String(automatic ?? "").trim();
  if (!mine) {
    return theirs;
  }
  const rest = theirs
    ? lazy.MailServices.headerParser.removeDuplicateAddresses(theirs, mine)
    : "";
  return rest ? `${mine}, ${rest}` : mine;
}

/**
 * A file as an attachment a message can be built with.
 *
 * @param {string} path
 * @param {object} part
 * @param {?string} part.name - The file's own name, if none is given.
 * @param {?string} part.contentType - Worked out from the file, if not given.
 * @param {?string} part.contentId - For a picture set in the text.
 * @returns {nsIMsgAttachment}
 */
function attachmentOf(path, { name, contentType, contentId }) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  const attachment = Cc[
    "@mozilla.org/messengercompose/attachment;1"
  ].createInstance(Ci.nsIMsgAttachment);
  attachment.url = Services.io.newFileURI(file).spec;
  attachment.name = name || file.leafName;
  attachment.size = file.fileSize;
  if (contentType) {
    attachment.contentType = contentType;
  }
  if (contentId) {
    attachment.contentId = contentId;
  }
  return attachment;
}

/**
 * The files a caller wants attached to a draft.
 *
 * They are read by Thunderbird, not by the caller, so this reaches whatever
 * Thunderbird may read -- and what is attached can be read back with
 * get_attachment. That is no more than a program holding a password to the
 * whole mailbox can usually read for itself, but it is why only an ordinary
 * file named by its full path is taken: nothing relative to a directory the
 * caller cannot see, no directory, no device.
 *
 * @param {?Array<string|{path: string, name: ?string}>} wanted
 * @returns {nsIMsgAttachment[]}
 */
function filesToAttach(wanted) {
  const attachments = [];
  let total = 0;
  for (const entry of [wanted ?? []].flat()) {
    const named = typeof entry == "object" && entry !== null;
    const file = fileAt(String((named ? entry.path : entry) ?? ""));
    total += file.fileSize;
    if (total > MAX_DRAFT_ATTACHMENT_BYTES) {
      throw new Error(
        `the attachments come to more than the ` +
          `${MAX_DRAFT_ATTACHMENT_BYTES}-byte limit for one draft`
      );
    }
    attachments.push(
      attachmentOf(file.path, { name: named ? String(entry.name ?? "") : "" })
    );
  }
  return attachments;
}

/**
 * The file a caller named, if it is one that can go into a draft.
 *
 * @param {string} named - Its full path, which may begin with ~/.
 * @returns {nsIFile}
 */
function fileAt(named) {
  let path = named.trim();
  if (path.startsWith("~/")) {
    path = Services.dirsvc.get("Home", Ci.nsIFile).path + path.slice(1);
  }
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  try {
    file.initWithPath(path);
  } catch (ex) {
    throw new Error(
      `"${path}" is not the full path of a file on this computer`
    );
  }
  if (!file.exists()) {
    throw new Error(`there is no file at ${path}`);
  }
  if (!file.isFile()) {
    throw new Error(`${path} is not a file`);
  }
  if (!file.isReadable()) {
    throw new Error(`${path} cannot be read`);
  }
  return file;
}

/**
 * Delete files written for the making of a draft, now that it is made.
 *
 * @param {string[]} paths
 */
function removeFiles(paths) {
  for (const path of paths) {
    IOUtils.remove(path, { ignoreAbsent: true }).catch(() => {});
  }
}

/**
 * Whether a caller turned something on. A client may send a yes as the word
 * for it, and the word for no must not count as one.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isSet(value) {
  return value === true || String(value).toLowerCase() == "true";
}

/**
 * What is chosen for a draft in the compose window's Options menu, after a
 * request has changed what it asks to change.
 *
 * @param {object} params - The request.
 * @param {object} standing - What holds where the request says nothing:
 *   {priority, returnReceipt, receiptHeaderType, DSN, attachVCard,
 *   attachmentReminder, deliveryFormat}.
 * @returns {object} The same, as it now is.
 */
function draftOptions(params, standing) {
  const options = { ...standing };
  const given = name => params?.[name] !== undefined && params[name] !== null;
  const choice = (name, choices) => {
    const chosen = String(params[name]).toLowerCase();
    if (!choices.includes(chosen)) {
      throw new Error(
        `${name} must be one of ${choices.join(", ")}, not "${params[name]}"`
      );
    }
    return chosen;
  };

  if (given("priority")) {
    // Normal is what a message is without a priority, so it is not given one.
    const priority = choice("priority", PRIORITIES);
    options.priority = priority == "normal" ? "" : priority;
  }
  if (given("deliveryFormat")) {
    options.deliveryFormat = {
      auto: Ci.nsIMsgCompSendFormat.Auto,
      plain: Ci.nsIMsgCompSendFormat.PlainText,
      html: Ci.nsIMsgCompSendFormat.HTML,
      both: Ci.nsIMsgCompSendFormat.Both,
    }[choice("deliveryFormat", SEND_FORMATS)];
  }
  for (const [name, option] of [
    ["returnReceipt", "returnReceipt"],
    ["deliveryStatusNotification", "DSN"],
    ["attachVCard", "attachVCard"],
    ["attachmentReminder", "attachmentReminder"],
  ]) {
    if (given(name)) {
      options[option] = isSet(params[name]);
    }
  }
  return options;
}

/**
 * What was chosen for a draft when it was saved, which it records in its
 * headers for the compose window to take up again.
 *
 * @param {object} headers - The draft's headers, from readDraft.
 * @param {nsIMsgIdentity} identity
 * @returns {object} As draftOptions takes it.
 */
function optionsOfDraft(headers, identity) {
  const info = (headers.getRawHeader("x-mozilla-draft-info") ?? [])[0] ?? "";
  const setting = name => {
    const found = new RegExp(`\\b${name}=(\\d+)`, "i").exec(info);
    return found ? Number(found[1]) : null;
  };
  // Which header a receipt is asked for with, plus one; nought for none.
  const receipt = setting("receipt") ?? 0;
  return {
    // As the header has it -- "1 (Highest)" -- which is read as well as the
    // name alone.
    priority: (headers.getRawHeader("x-priority") ?? [])[0] ?? "",
    returnReceipt: receipt > 0,
    receiptHeaderType: receipt > 0 ? receipt - 1 : identity.receiptHeaderType,
    DSN: setting("DSN") > 0,
    attachVCard: setting("vcard") > 0,
    attachmentReminder: setting("attachmentreminder") > 0,
    deliveryFormat: setting("deliveryformat") ?? Ci.nsIMsgCompSendFormat.Unset,
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Plain text as the HTML the compose window makes of the same text typed
 * into it: a paragraph for each block set off by a blank line and a line
 * break for each line within one -- or line breaks alone, where writing in
 * paragraphs is turned off. Spaces that HTML would run together are kept.
 *
 * @param {string} text
 * @returns {string}
 */
function textToHtml(text) {
  const line = source => {
    const indent = /^[ \t]*/.exec(source)[0];
    return (
      "&nbsp;".repeat(indent.replace(/\t/g, "    ").length) +
      escapeHtml(source.slice(indent.length)).replace(
        / {2,}/g,
        spaces => " " + "&nbsp;".repeat(spaces.length - 1)
      )
    );
  };
  const lines = block => block.split("\n").map(line).join("<br>\n");
  const normalized = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\s+$/g, "");

  if (!Services.prefs.getBoolPref("mail.compose.default_to_paragraph", false)) {
    return normalized ? lines(normalized) : "<br>";
  }
  if (!normalized) {
    return "<p><br></p>";
  }
  return normalized
    .split(/\n{2,}/)
    .map(block => `<p>${lines(block)}</p>`)
    .join("\n");
}

/**
 * A message body's HTML as the whole document a draft holds.
 *
 * @param {string} content
 * @returns {string}
 */
function htmlDocument(content) {
  return (
    "<!DOCTYPE html>\n<html>\n  <head>\n" +
    '    <meta http-equiv="content-type" content="text/html; charset=UTF-8">\n' +
    `  </head>\n  <body>\n${content}\n  </body>\n</html>\n`
  );
}

/**
 * The signature an identity puts on a message, if it has one.
 *
 * A signature that is a picture is left out: it would have to be embedded in
 * the message, and the compose window, changing identity, can still add it.
 *
 * @param {nsIMsgIdentity} identity
 * @param {boolean} isReply
 * @returns {Promise<?{content: string, isHtml: boolean, text: string}>} With
 *   `text` being what it reads as, whichever way it is written.
 */
async function signatureOf(identity, isReply) {
  if (isReply && !identity.sigOnReply) {
    return null;
  }
  let content = "";
  let isHtml = false;
  if (identity.attachSignature) {
    const file = identity.signature;
    try {
      const type = Cc["@mozilla.org/mime;1"]
        .getService(Ci.nsIMIMEService)
        .getTypeFromFile(file);
      if (!type.startsWith("image/")) {
        content = await IOUtils.readUTF8(file.path);
        isHtml = type == "text/html";
      }
    } catch (ex) {
      // No file, or one that cannot be read: no signature, as in the window.
    }
  } else {
    content = identity.htmlSigText;
    isHtml = identity.htmlSigFormat;
  }
  if (!content.trim()) {
    return null;
  }
  return {
    content,
    isHtml,
    text: (isHtml ? lazy.MsgUtils.convertToPlainText(content, false) : content)
      .replace(/\r\n?/g, "\n")
      .replace(/\s+$/, ""),
  };
}

/**
 * Whether a signature is to be set off by the usual "-- " line: not where
 * the identity has turned that off, nor where the signature has its own.
 *
 * @param {nsIMsgIdentity} identity
 * @param {object} signature - From signatureOf.
 * @returns {boolean}
 */
function signatureNeedsSeparator(identity, signature) {
  return !identity.suppressSigSep && !/(^|\n)-- (\n|$)/.test(signature.text);
}

/**
 * Text with the signature taken off its end, if it ends with it.
 *
 * The signature is added to what is written, so one written out as well
 * would be there twice -- and a caller rewriting a draft it has just read
 * sends the signature back with the rest, since it is part of what it read.
 *
 * @param {string} text
 * @param {string} signature - As text.
 * @returns {string}
 */
function withoutSignature(text, signature) {
  const trimmed = lines => lines.map(line => line.trim());
  const written = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  const signed = trimmed(signature.trim().split("\n"));
  if (
    signed.length > written.length ||
    trimmed(written.slice(-signed.length)).join("\n") != signed.join("\n")
  ) {
    return text;
  }
  const kept = written.slice(0, -signed.length);
  // And the line that set it off, with the blank lines around that.
  while (kept.length && /^(--)?$/.test(kept.at(-1).trim())) {
    kept.pop();
  }
  return kept.join("\n");
}

/**
 * A signature as it is put after a message's text in HTML: the markup the
 * compose window gives one, which is also how it finds a signature to
 * replace when the identity is changed.
 *
 * @param {nsIMsgIdentity} identity
 * @param {object} signature - From signatureOf.
 * @returns {string}
 */
function signatureMarkup(identity, signature) {
  const separated = signatureNeedsSeparator(identity, signature);
  const paragraphs = Services.prefs.getBoolPref(
    "mail.compose.default_to_paragraph",
    false
  );
  return (
    (paragraphs ? "\n" : "<br>\n") +
    (signature.isHtml
      ? `<div class="moz-signature">${separated ? "-- <br>" : ""}` +
        `${signature.content}</div>`
      : `<pre class="moz-signature" cols="` +
        `${Services.prefs.getIntPref("mailnews.wraplength", 72)}">` +
        `${separated ? "-- \n" : ""}${escapeHtml(signature.text)}</pre>`)
  );
}

/**
 * A picture named in HTML a caller wrote, as a part of the message for the
 * HTML to show: a file on this computer, or one written into the HTML
 * itself. A picture on the web, or one already in the message, is no
 * business of this and is left as it is named.
 *
 * @param {string} source - The picture's src.
 * @param {nsIMsgIdentity} identity
 * @param {number} number - Which of the message's pictures this is, from 1.
 * @param {string[]} written - Takes the path of a file written here, for the
 *   caller to delete once the message is made.
 * @returns {Promise<?nsIMsgAttachment>} Null for a picture that is left.
 */
async function pictureToEmbed(source, identity, number, written) {
  const contentId = lazy.MsgUtils.makeContentId(identity, number);
  const inline = /^data:(image\/[\w.+-]+);base64,(.*)$/is.exec(source);
  if (inline) {
    let bytes;
    try {
      bytes = Uint8Array.from(atob(inline[2].replace(/\s+/g, "")), c =>
        c.charCodeAt(0)
      );
    } catch (ex) {
      return null;
    }
    const contentType = inline[1].toLowerCase();
    const name = `image.${contentType.replace(/^image\/|\+.*$/g, "")}`;
    const path = await newAttachmentFile(name);
    written.push(path);
    await IOUtils.write(path, bytes);
    return attachmentOf(path, { name, contentType, contentId });
  }

  let path;
  if (/^file:/i.test(source)) {
    try {
      path = Services.io.newURI(source).QueryInterface(Ci.nsIFileURL).file.path;
    } catch (ex) {
      return null;
    }
  } else if (/^(\/|~\/)/.test(source)) {
    path = source;
  } else {
    return null;
  }
  const file = fileAt(path);
  if (file.fileSize > MAX_DRAFT_ATTACHMENT_BYTES) {
    throw new Error(`${path} is too large to set in a draft's text`);
  }
  let contentType = "";
  try {
    contentType = Cc["@mozilla.org/mime;1"]
      .getService(Ci.nsIMIMEService)
      .getTypeFromFile(file);
  } catch (ex) {
    // A file of no known kind is not one of a picture's kinds.
  }
  if (!contentType.startsWith("image/")) {
    throw new Error(
      `${path} is not a picture, so it cannot be set in the text; attach it`
    );
  }
  return attachmentOf(file.path, { contentType, contentId });
}

/**
 * HTML a caller wrote, as a draft's body: with nothing in it that runs or
 * submits, the pictures it names made part of the message, and the
 * identity's signature after it unless it is signed already -- as it is when
 * it is a draft's own HTML, read and changed.
 *
 * @param {nsIMsgIdentity} identity
 * @param {string} html - What goes in the body; a whole page is taken for
 *   its body.
 * @param {?object} signature - From signatureOf.
 * @param {string[]} written - As for pictureToEmbed.
 * @returns {Promise<{bodyType: string, body: string,
 *   embedded: nsIMsgAttachment[]}>}
 */
async function formattedBody(identity, html, signature, written) {
  const parserUtils = Cc["@mozilla.org/parserutils;1"].getService(
    Ci.nsIParserUtils
  );
  const doc = new DOMParser().parseFromString("", "text/html");
  const holder = doc.createElement("div");
  // The formatting stays, style and all; scripts, handlers and forms go. The
  // compose window would not run them, but whoever is sent them might.
  holder.append(
    parserUtils.parseFragment(
      html,
      parserUtils.SanitizerAllowStyle | parserUtils.SanitizerDropForms,
      false,
      null,
      doc.body
    )
  );

  const embedded = [];
  for (const image of holder.querySelectorAll("img[src]")) {
    const picture = await pictureToEmbed(
      image.getAttribute("src"),
      identity,
      embedded.length + 1,
      written
    );
    if (picture) {
      embedded.push(picture);
      image.setAttribute("src", `cid:${picture.contentId}`);
    }
  }

  let content = holder.innerHTML;
  if (signature && !holder.querySelector(".moz-signature")) {
    const text = lazy.MsgUtils.convertToPlainText(content, false);
    if (withoutSignature(text, signature.text) == text) {
      content += signatureMarkup(identity, signature);
    }
  }
  return { bodyType: "text/html", body: htmlDocument(content), embedded };
}

/**
 * What a caller wrote, as the body the compose window would have saved for
 * it. Plain text becomes HTML where the identity writes HTML; HTML is kept
 * as HTML. Either way the identity's signature comes after it.
 *
 * @param {nsIMsgIdentity} identity
 * @param {?object} params - The request: `body` for plain text, or `html`.
 * @param {boolean} isReply
 * @param {string[]} written - As for pictureToEmbed.
 * @returns {Promise<{bodyType: string, body: string,
 *   embedded: nsIMsgAttachment[]}>}
 */
async function writtenBody(identity, params, isReply, written) {
  const signature = await signatureOf(identity, isReply);
  const given = name => params?.[name] !== undefined && params[name] !== null;
  if (given("html")) {
    if (given("body")) {
      throw new Error("give the text as body or as html, not as both");
    }
    return formattedBody(identity, String(params.html), signature, written);
  }

  const text = String(params?.body ?? "");
  const typed = signature ? withoutSignature(text, signature.text) : text;
  if (identity.composeHtml) {
    return {
      bodyType: "text/html",
      body: htmlDocument(
        textToHtml(typed) +
          (signature ? signatureMarkup(identity, signature) : "")
      ),
      embedded: [],
    };
  }

  const separated = signature && signatureNeedsSeparator(identity, signature);
  let body = typed.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (signature) {
    body += `\n\n${separated ? "-- \n" : ""}${signature.text}`;
  }
  if (Services.prefs.getBoolPref("mailnews.send_plaintext_flowed", true)) {
    // The message will say its text is flowed, in which a line ending in a
    // space runs on into the next and a line starting with one loses it.
    body = body
      .split("\n")
      .map(line => (line == "-- " ? line : line.replace(/ +$/, "")))
      .map(line => (/^( |From )/.test(line) ? ` ${line}` : line))
      .join("\n");
  }
  return { bodyType: "text/plain", body: `${body}\n`, embedded: [] };
}

/**
 * A message as it is stored, headers and all.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {Promise<string>} One character per byte.
 */
function sourceOf(hdr) {
  const uri = hdr.folder.getUriForMsg(hdr);
  return new Promise((resolve, reject) => {
    // A server that stops answering must not hold the request for ever.
    const timer = lazy.setTimeout(
      () => reject(new Error("reading the draft timed out")),
      ATTACHMENT_FETCH_TIMEOUT_MS
    );
    let stream = null;
    let source = "";
    lazy.MailServices.messageServiceFromURI(uri).streamMessage(
      uri,
      {
        QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
        onStartRequest() {},
        onDataAvailable(request, input, offset, count) {
          if (!stream) {
            stream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
              Ci.nsIBinaryInputStream
            );
            stream.setInputStream(input);
          }
          source += stream.readBytes(count);
        },
        onStopRequest(request, status) {
          lazy.clearTimeout(timer);
          if (Components.isSuccessCode(status) && source) {
            resolve(source);
          } else {
            reject(new Error("the draft could not be read"));
          }
        },
      },
      null,
      null,
      false,
      ""
    );
  });
}

/**
 * A draft taken apart into what a compose window would show of it: its
 * headers, its text, and the files attached to it.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {Promise<{headers: object, bodyType: string, body: string,
 *   flowed: boolean, attachments: object[], embedded: object[]}>} The parts
 *   are each {name, contentType, contentId, bytes}; `embedded` are the
 *   pictures set in the text, which it refers to by their contentId.
 */
async function readDraft(hdr) {
  // Read whole: every part is wanted, and a part's own bytes are what must
  // be attached again -- not text put through a change of charset.
  if (hdr.messageSize > 2 * MAX_DRAFT_ATTACHMENT_BYTES) {
    throw new Error("the draft is too large to be changed here");
  }
  const parts = [];
  lazy.MimeParser.parseSync(
    await sourceOf(hdr),
    {
      startPart(number, headers) {
        parts.push({ number, headers, chunks: [] });
      },
      deliverPartData(number, data) {
        parts.findLast(part => part.number == number)?.chunks.push(data);
      },
    },
    { bodyformat: "decode", strformat: "typedarray", decodeSubMessages: false }
  );
  if (!parts.length) {
    throw new Error("the draft could not be read");
  }

  const typeOf = part => part.headers.contentType.type;
  const within = (part, container) =>
    container.number == "" || part.number.startsWith(`${container.number}.`);
  const containers = parts.filter(
    part => part.headers.contentType.mediatype == "multipart"
  );
  const leaves = parts.filter(part => !containers.includes(part));
  if (containers.some(part => typeOf(part) == "multipart/encrypted")) {
    throw new Error("the draft is encrypted, and cannot be changed here");
  }

  const dispositionOf = part =>
    (part.headers.getRawHeader("content-disposition") ?? [])[0] ?? "";
  const isText = part =>
    ["text/html", "text/plain"].includes(typeOf(part)) &&
    !/^\s*attachment/i.test(dispositionOf(part));
  // The text is the first part that can be one. Where it is one of several
  // versions of the same text, the HTML is kept and the others go.
  let text = leaves.find(isText);
  const versions = [];
  const alternative =
    text &&
    containers.findLast(
      part => typeOf(part) == "multipart/alternative" && within(text, part)
    );
  if (alternative) {
    versions.push(...leaves.filter(p => isText(p) && within(p, alternative)));
    text = versions.find(part => typeOf(part) == "text/html") ?? text;
  }

  const bytesOf = part => {
    const bytes = new Uint8Array(
      part.chunks.reduce((size, chunk) => size + chunk.length, 0)
    );
    let at = 0;
    for (const chunk of part.chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return bytes;
  };
  const attachments = [];
  const embedded = [];
  for (const part of leaves) {
    if (part == text || versions.includes(part)) {
      continue;
    }
    const contentId = (part.headers.getRawHeader("content-id") ?? [])[0]
      ?.trim()
      .replace(/^<|>$/g, "");
    const contentType = part.headers.contentType;
    const described = {
      name:
        lazy.MimeParser.getParameter(dispositionOf(part), "filename") ||
        (contentType.has("name") ? contentType.get("name") : "") ||
        "attachment",
      contentType: contentType.type,
      contentId,
      bytes: bytesOf(part),
    };
    const related = containers.some(
      container =>
        typeOf(container) == "multipart/related" && within(part, container)
    );
    (contentId && related ? embedded : attachments).push(described);
  }

  let body = "";
  if (text) {
    const charset = text.headers.contentType.has("charset")
      ? text.headers.contentType.get("charset")
      : "utf-8";
    let decoder;
    try {
      decoder = new TextDecoder(charset);
    } catch (ex) {
      decoder = new TextDecoder();
    }
    body = decoder.decode(bytesOf(text));
  }
  return {
    headers: parts[0].headers,
    bodyType: text ? typeOf(text) : "text/html",
    body,
    flowed:
      Boolean(text) &&
      text.headers.contentType.has("format") &&
      /flowed/i.test(text.headers.contentType.get("format")),
    attachments,
    embedded,
  };
}

/**
 * A message's text as HTML, for a caller that means to change a draft and
 * keep its formatting.
 *
 * Only what is in the body: the page around it is put back when a draft is
 * saved. Pictures set in the text are named as the message names them, and
 * are found again by those names when the HTML comes back.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {Promise<{html: ?string, htmlTruncated: ?boolean}>} With `html`
 *   null for a message whose text is not HTML, or that cannot be read.
 */
async function htmlOf(hdr) {
  let message;
  try {
    message = await readDraft(hdr);
  } catch (ex) {
    return { html: null };
  }
  if (message.bodyType != "text/html") {
    return { html: null };
  }
  const html = new DOMParser().parseFromString(message.body, "text/html").body
    .innerHTML;
  return html.length > MAX_BODY_CHARS
    ? { html: html.slice(0, MAX_BODY_CHARS), htmlTruncated: true }
    : { html };
}

/**
 * The body of a draft whose text is not being changed.
 *
 * @param {object} was - The draft, from readDraft.
 * @param {nsIMsgIdentity} identity
 * @returns {{bodyType: string, body: string}}
 */
function keptBody(was, identity) {
  if (was.bodyType == "text/plain" && !was.flowed && identity.composeHtml) {
    // What this endpoint wrote before it wrote HTML. Saved again as it was,
    // it would go on opening in the plain-text editor.
    return { bodyType: "text/html", body: htmlDocument(textToHtml(was.body)) };
  }
  return { bodyType: was.bodyType, body: was.body };
}

/**
 * The attachments of a draft that stay when some are taken off by name. A
 * name the draft does not have is an error, which says what it does have.
 *
 * @param {object} was - The draft, from readDraft.
 * @param {?(string|string[])} removed - Names.
 * @returns {object[]}
 */
function attachmentsLeft(was, removed) {
  const names = [removed ?? []].flat().map(String);
  for (const name of names) {
    if (!was.attachments.some(part => part.name == name)) {
      throw new Error(
        `the draft has no attachment named "${name}"; it has: ` +
          (was.attachments.map(part => part.name).join(", ") || "none")
      );
    }
  }
  return was.attachments.filter(part => !names.includes(part.name));
}

/**
 * The identity a draft is written as: the one it names, else whichever has
 * the address it is from.
 *
 * @param {object} headers - The draft's headers, from readDraft.
 * @returns {?nsIMsgIdentity}
 */
function identityOfDraft(headers) {
  const key = (headers.getRawHeader("x-identity-key") ?? [])[0]?.trim();
  const from = headers.get("from")?.[0]?.email;
  return (
    lazy.MailServices.accounts.allIdentities.find(i => i.key == key) ??
    (from ? pickIdentity(from) : null) ??
    defaultIdentity()
  );
}

/**
 * A header of a draft as it would be typed, rather than as it is encoded.
 *
 * @param {object} headers - The draft's headers, from readDraft.
 * @param {string} name
 * @returns {string}
 */
function decodedHeader(headers, name) {
  const raw = (headers.getRawHeader(name) ?? []).join(", ");
  return raw
    ? lazy.MailServices.mimeConverter.decodeMimeHeader(raw, null, false, true)
    : "";
}

/**
 * Put together a draft and save it, as the compose window would.
 *
 * The message is built by the code the compose window saves with, so it has
 * the headers a draft needs to open as one -- which identity it is written
 * as, where the sent copy goes -- and its attachments are encoded as any
 * others are.
 *
 * @param {object} draft - {identity, to, cc, bcc, replyTo, subject,
 *   references, bodyType, body, attachments, embedded, fcc, options,
 *   original}, where `options` is as draftOptions gives it and `original`
 *   is {uri, disposition} for a message this answers.
 * @param {nsIMsgFolder} folder - The folder to save into.
 * @param {?nsIMsgDBHdr} [replaced] - An earlier version, deleted once this
 *   one is saved.
 * @returns {Promise<object>} What the caller is told.
 */
async function saveDraft(draft, folder, replaced = null) {
  const { identity } = draft;
  const fields = Cc[
    "@mozilla.org/messengercompose/composefields;1"
  ].createInstance(Ci.nsIMsgCompFields);
  fields.from = lazy.MailServices.headerParser
    .makeMailboxObject(identity.fullName, identity.email)
    .toString();
  fields.to = draft.to;
  fields.cc = draft.cc;
  fields.bcc = draft.bcc;
  fields.replyTo = draft.replyTo;
  fields.subject = draft.subject;
  if (draft.references) {
    fields.references = draft.references;
  }
  if (identity.organization) {
    fields.organization = identity.organization;
  }
  if (draft.fcc) {
    fields.fcc = draft.fcc;
  }
  // What is chosen in the compose window's Options menu. A draft records
  // most of it in a header of its own, to be taken up when it is opened.
  const { options } = draft;
  fields.priority = options.priority;
  fields.returnReceipt = options.returnReceipt;
  fields.receiptHeaderType = options.receiptHeaderType;
  fields.DSN = options.DSN;
  fields.attachVCard = options.attachVCard;
  fields.attachmentReminder = options.attachmentReminder;
  fields.deliveryFormat = options.deliveryFormat;
  for (const attachment of draft.attachments) {
    fields.addAttachment(attachment);
  }

  const originalUri = draft.original?.uri ?? "";
  const type =
    draft.original?.disposition == "replied"
      ? Ci.nsIMsgCompType.Reply
      : Ci.nsIMsgCompType.New;
  const message = new lazy.MimeMessage(
    identity,
    fields,
    lazy.MsgUtils.getFcc(identity, fields, originalUri, type),
    draft.bodyType,
    // As bytes, one to a character, which is how it takes an attachment too.
    lazy.jsmime.mimeutils.typedArrayToString(
      new TextEncoder().encode(draft.body)
    ),
    Ci.nsIMsgSend.nsMsgSaveAsDraft,
    originalUri,
    type,
    draft.embedded,
    null
  );
  let file;
  try {
    file = await message.createMessageFile();
  } catch (ex) {
    throw new Error(
      ex.data?.name
        ? `"${ex.data.name}" could not be read to attach it`
        : `the draft could not be put together: ${ex.message ?? ex}`
    );
  }

  const key = await copyToFolder(file, folder, fields.messageId);
  const hdr = await headerOnceSaved(folder, key, fields.messageId);
  if (hdr && originalUri) {
    // So that sending the draft marks the message it answers as answered,
    // which the compose window arranges in the same way.
    hdr.setStringProperty("origURIs", originalUri);
    hdr.setStringProperty("queuedDisposition", draft.original.disposition);
  }
  if (replaced) {
    await discard(replaced);
  }

  return {
    saved: true,
    id: hdr ? folder.getUriForMsg(hdr) : null,
    folder: folder.URI,
    subject: draft.subject,
    from: identity.email,
    attachments: draft.attachments.map(attachment => attachment.name),
    // The draft is saved all the same; its folder has just not shown it yet.
    ...(hdr
      ? {}
      : { note: "saved, but its id is not known yet; look in the folder" }),
  };
}

/**
 * Copy a message file into a folder as a draft, and delete the file.
 *
 * @param {nsIFile} file
 * @param {nsIMsgFolder} folder
 * @param {string} messageId - The message's Message-ID, which a server that
 *   does not report the new message's key is searched for.
 * @returns {Promise<number>} The new message's key, or NO_KEY if unknown.
 */
function copyToFolder(file, folder, messageId) {
  return new Promise((resolve, reject) => {
    let key = NO_KEY;
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
    const allowed = Math.min(
      DRAFT_SAVE_TIMEOUT_MS + file.fileSize / DRAFT_SAVE_BYTES_PER_MS,
      DRAFT_SAVE_TIMEOUT_MAX_MS
    );
    const deadline = lazy.setTimeout(
      () =>
        finish(
          reject,
          new Error(
            `the draft was not confirmed saved within ` +
              `${Math.round(allowed / 1000)} seconds; the server may still ` +
              `be working on it`
          )
        ),
      allowed
    );

    lazy.MailServices.copy.copyFileMessage(
      file,
      folder,
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
        setMessageKey(newKey) {
          key = newKey;
        },
        getMessageId() {
          return messageId;
        },
        onStopCopy(status) {
          lazy.clearTimeout(deadline);
          if (Components.isSuccessCode(status)) {
            finish(resolve, key);
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
}

/**
 * The header of a draft just saved, once its folder has it.
 *
 * A folder on a server learns of a new message when it next looks, so it is
 * asked to look, and given a little while. A caller told a draft's id will
 * use it straight away -- to read the draft back, or to change it.
 *
 * @param {nsIMsgFolder} folder
 * @param {number} key - The message's key, or NO_KEY.
 * @param {string} messageId - Its Message-ID, to find it by without a key.
 * @returns {Promise<?nsIMsgDBHdr>}
 */
async function headerOnceSaved(folder, key, messageId) {
  const bareId = messageId.replace(/^<|>$/g, "");
  const find = () => {
    try {
      const database = folder.msgDatabase;
      // The key is taken on trust only as far as the message it leads to is
      // this one. A server that does not report the key is searched for the
      // message instead, and one that answers that search loosely names
      // another draft -- which, when a draft is being changed, is the one
      // about to be deleted.
      if (key != NO_KEY && database.containsKey(key)) {
        const hdr = database.getMsgHdrForKey(key);
        if (hdr.messageId == bareId) {
          return hdr;
        }
      }
      return database.getMsgHdrForMessageID(bareId);
    } catch (ex) {
      return null;
    }
  };
  let hdr = find();
  if (!hdr) {
    try {
      folder.updateFolder(null);
    } catch (ex) {
      // Offline, or busy; it may still turn up.
    }
    const deadline = Date.now() + DRAFT_APPEAR_TIMEOUT_MS;
    while (!hdr && Date.now() < deadline) {
      await new Promise(resolve => lazy.setTimeout(resolve, 250));
      hdr = find();
    }
  }
  return hdr;
}

/**
 * Put a draft that has been replaced in the Trash -- or wherever the account
 * puts what the user deletes.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {Promise} Settles when it has gone, or has been given long enough.
 */
function discard(hdr) {
  return new Promise(resolve => {
    const timer = lazy.setTimeout(resolve, DRAFT_APPEAR_TIMEOUT_MS);
    const done = () => {
      lazy.clearTimeout(timer);
      resolve();
    };
    try {
      hdr.folder.deleteMessages(
        [hdr],
        null,
        false, // deleteStorage: no, it is to be got back if this was a mistake
        false,
        {
          QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
          onStartCopy() {},
          onProgress() {},
          setMessageKey() {},
          getMessageId() {
            return "";
          },
          onStopCopy: done,
        },
        false
      );
    } catch (ex) {
      console.warn("Could not remove the earlier version of a draft:", ex);
      done();
    }
  });
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
      {
        port: socket.port,
        url: `http://127.0.0.1:${socket.port}/rpc`,
        mcpUrl: `http://127.0.0.1:${socket.port}/mcp`,
      }
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
 * chunked encoding. Its clients are the bridge, on `/rpc` (or any path but
 * `/mcp`, as before there were two), and MCP clients on `/mcp`.
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

  /**
   * @param {string} status - e.g. "200 OK".
   * @param {*} [payload] - Sent as JSON; nothing is sent if undefined.
   * @param {string} [extraHeaders] - Whole header lines, each ending CRLF.
   */
  const respond = (status, payload, extraHeaders = "") => {
    const bytes =
      payload === undefined
        ? new Uint8Array(0)
        : new TextEncoder().encode(JSON.stringify(payload));
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
      (bytes.length
        ? "Content-Type: application/json; charset=utf-8\r\n"
        : "") +
      `Content-Length: ${bytes.length}\r\n` +
      extraHeaders +
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
    const [httpMethod = "", target = ""] = head
      .slice(0, head.indexOf("\r\n") >>> 0)
      .split(" ");

    const token = /authorization:\s*bearer\s+(\S+)/i.exec(head)?.[1] ?? "";
    if (!(await MailMcpTokens.verify(token))) {
      // Same answer whether the token is absent, malformed or simply wrong.
      respond("401 Unauthorized", { error: "a valid token is required" });
      return;
    }

    if (/^\/mcp(?:[/?]|$)/.test(target)) {
      await answerMcp(httpMethod, body, respond);
      return;
    }

    let request;
    try {
      request = JSON.parse(decodeBody(body) || "{}");
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
 * The body of a request as the text it was sent as.
 *
 * readBytes returns one character per byte, which is what Content-Length is
 * counted in and so is right for the framing, but it leaves the body as UTF-8
 * lying in a byte string. Decoding it is what turns those bytes back into the
 * characters they were sent as; without this a Chinese subject arrives as
 * mojibake and is saved that way. The response side does the mirror of this.
 *
 * @param {string} body - One character per byte.
 * @returns {string}
 */
function decodeBody(body) {
  return new TextDecoder().decode(Uint8Array.from(body, c => c.charCodeAt(0)));
}

/**
 * Answer an MCP request made over Streamable HTTP.
 *
 * Only the parts a tools-only server needs: every response comes back as a
 * plain JSON body, never as an event stream, and there are no sessions, so a
 * client asking to open a stream of its own (GET) or to end a session
 * (DELETE) is told the method is not supported -- which the protocol has
 * clients take in their stride.
 *
 * @param {string} httpMethod
 * @param {string} body - One character per byte.
 * @param {Function} respond - As in handleConnection.
 */
async function answerMcp(httpMethod, body, respond) {
  if (httpMethod != "POST") {
    respond("405 Method Not Allowed", undefined, "Allow: POST\r\n");
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(decodeBody(body));
  } catch (ex) {
    respond("400 Bad Request", {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "body must be JSON" },
    });
    return;
  }

  // Older revisions of the protocol let a client send several messages in
  // one body. Answered in order, since a later call may depend on an
  // earlier one.
  const responses = [];
  for (const message of [parsed].flat()) {
    const response = await McpProtocol.handle(message);
    if (response) {
      responses.push(response);
    }
  }

  if (!responses.length) {
    // Notifications and responses only: accepted, nothing to say back.
    respond("202 Accepted");
  } else {
    respond("200 OK", Array.isArray(parsed) ? responses : responses[0]);
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
      "\n\nAn AI tool needs one of these passwords to read your mail, " +
      "write drafts and tag messages. It can never send anything, and " +
      "never moves or deletes a message -- only the earlier version of a " +
      "draft it changes, which goes to the Trash.";

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
