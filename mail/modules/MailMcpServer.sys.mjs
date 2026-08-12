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

/** Requests larger than this are refused rather than buffered. */
const MAX_REQUEST_BYTES = 1024 * 1024;

/** Cap on how much body text one message may contribute. */
const MAX_BODY_CHARS = 100000;

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
    folderName: hdr.folder.prettyName,
    read: Boolean(hdr.flags & Ci.nsMsgMessageFlags.Read),
    flagged: Boolean(hdr.flags & Ci.nsMsgMessageFlags.Marked),
    tags: (hdr.getStringProperty("keywords") || "").split(/\s+/).filter(Boolean),
    hasAttachments: Boolean(hdr.flags & Ci.nsMsgMessageFlags.Attachment),
    threadId: hdr.threadParent || hdr.messageKey,
  };
}

/**
 * The decoded body and attachment list for a message.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {Promise<{body: string, attachments: object[]}>}
 */
function bodyOf(hdr) {
  return new Promise(resolve => {
    // A message whose source cannot be fetched -- offline, deleted underneath
    // us -- should degrade to "no body" rather than hang the request.
    const timer = lazy.setTimeout(
      () => resolve({ body: "", attachments: [], truncated: false }),
      15000
    );
    try {
      lazy.MsgHdrToMimeMessage(
        hdr,
        null,
        (returnedHdr, mimeMsg) => {
          lazy.clearTimeout(timer);
          if (!mimeMsg) {
            resolve({ body: "", attachments: [], truncated: false });
            return;
          }
          let body = "";
          try {
            body = mimeMsg.coerceBodyToPlaintext(hdr.folder) ?? "";
          } catch (ex) {
            body = "";
          }
          const truncated = body.length > MAX_BODY_CHARS;
          resolve({
            body: truncated ? body.slice(0, MAX_BODY_CHARS) : body,
            truncated,
            attachments: (mimeMsg.allAttachments ?? []).map(a => ({
              name: a.name,
              contentType: a.contentType,
              size: a.size,
              url: a.url,
            })),
          });
        },
        true,
        { partsOnDemand: false, examineEncryptedParts: false }
      );
    } catch (ex) {
      resolve({ body: "", attachments: [], truncated: false });
    }
  });
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
   *   before, tag, unread, flagged, hasAttachment, limit}
   */
  async search(params) {
    const query = String(params?.query ?? "").trim();
    const limit = Math.min(Number(params?.limit) || 25, 200);
    const filters = buildFilters(params);

    let candidates = [];
    if (query) {
      const searcher = new lazy.GlodaMsgSearcher(null, query);
      // Over-fetch, because the filters run afterwards: asking for 25 and
      // then discarding most of them would quietly return far fewer than
      // were asked for.
      searcher.limit = filters.any ? Math.min(limit * 8, 500) : limit;

      const collection = await new Promise((resolve, reject) => {
        searcher.getCollection({
          onItemsAdded() {},
          onItemsModified() {},
          onItemsRemoved() {},
          onQueryCompleted(coll) {
            resolve(coll);
          },
        });
        lazy.setTimeout(() => reject(new Error("search timed out")), 30000);
      });
      for (const item of collection.items) {
        const hdr = item.folderMessage;
        if (hdr) {
          candidates.push({ hdr, snippet: item.indexedBodyText?.slice(0, 300) ?? "" });
        }
      }
    } else if (filters.folders.length) {
      // No text to rank by, so read the folders themselves, newest first.
      for (const folder of filters.folders) {
        let database;
        try {
          database = folder.msgDatabase;
        } catch (ex) {
          continue;
        }
        for (const hdr of database.enumerateMessages()) {
          candidates.push({ hdr, snippet: "" });
        }
      }
      candidates.sort((a, b) => (b.hdr.date ?? 0) - (a.hdr.date ?? 0));
    } else {
      throw new Error(
        "search needs a query, or a folder to filter within"
      );
    }

    const messages = [];
    for (const { hdr, snippet } of candidates) {
      if (!filters.matches(hdr)) {
        continue;
      }
      messages.push({ ...headerToJson(hdr), snippet });
      if (messages.length >= limit) {
        break;
      }
    }
    return { query, filters: filters.describe, count: messages.length, messages };
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
   * Every message in the same conversation, oldest first.
   *
   * @param {object} params - {id, includeBodies}
   */
  async getThread(params) {
    const hdr = hdrFromUri(String(params?.id ?? ""));
    const thread = hdr.folder.msgDatabase.getThreadContainingMsgHdr(hdr);
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
          name: folder.prettyName,
          account: server.prettyName,
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
      `From: ${identity.fullName ? `${identity.fullName} <${identity.email}>` : identity.email}`,
      params?.to ? `To: ${params.to}` : null,
      params?.cc ? `Cc: ${params.cc}` : null,
      params?.bcc ? `Bcc: ${params.bcc}` : null,
      params?.replyTo ? `Reply-To: ${params.replyTo}` : null,
      `Subject: ${subject}`,
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
      lazy.MailServices.copy.copyFileMessage(
        file,
        draftsFolder,
        null,
        true, // isDraft
        0,
        "",
        {
          OnStartCopy() {},
          OnProgress() {},
          SetMessageKey() {},
          GetMessageId() {},
          OnStopCopy(status) {
            file.remove(false);
            if (Components.isSuccessCode(status)) {
              resolve();
            } else {
              reject(new Error(`could not save the draft (${status})`));
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
  const folders = [];
  if (params?.folder) {
    const wanted = String(params.folder).toLowerCase();
    for (const server of lazy.MailServices.accounts.allServers) {
      for (const folder of server.rootFolder.descendants) {
        if (
          folder.URI.toLowerCase() == wanted ||
          folder.prettyName?.toLowerCase() == wanted ||
          folder.URI.toLowerCase().endsWith(`/${wanted}`)
        ) {
          folders.push(folder);
        }
      }
    }
    if (!folders.length) {
      throw new Error(`no folder matches: ${params.folder}`);
    }
  }

  const any = Boolean(
    from || to || subject || tag || after || before || folders.length ||
      unread !== undefined || flagged !== undefined ||
      hasAttachment !== undefined
  );

  return {
    any,
    folders,
    describe: {
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
  try {
    if (identity.draftFolder) {
      return lazy.MailServices.folderLookup.getFolderForURL(
        identity.draftFolder
      );
    }
  } catch (ex) {
    // Fall through to the account's own drafts folder.
  }
  for (const server of lazy.MailServices.accounts.allServers) {
    const drafts = server.rootFolder.getFolderWithFlags(
      Ci.nsMsgFolderFlags.Drafts
    );
    if (drafts) {
      return drafts;
    }
  }
  return null;
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
    // Port 0 lets the OS choose; `true` is loopback-only, so nothing outside
    // this machine can reach it even if a firewall is misconfigured.
    socket.init(-1, true, -1);
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
    const body = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(body);
    const head =
      `HTTP/1.1 ${status}\r\n` +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${bytes.length}\r\n` +
      "Connection: close\r\n\r\n";
    output.write(head, head.length);
    output.write(body, body.length);
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
      request = JSON.parse(body || "{}");
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
