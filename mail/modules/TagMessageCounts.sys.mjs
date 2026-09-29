/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * How many conversations carry each tag.
 *
 * Conversations rather than messages, because a tag folder lists a
 * conversation whole once any message in it is tagged (ThreadTagSearchTerm),
 * and its rows are conversations: a count of tagged messages matched neither
 * the rows nor the messages listed. A conversation is counted while at least
 * one of its messages carries the tag -- the same test the folder lists it by.
 *
 * The folder pane's tag rows are virtual folders, and a virtual folder only
 * knows how many messages it holds once its search has actually been run --
 * which happens when you open it. That makes the built-in total count
 * useless as an at-a-glance number: every tag reads 0 until clicked, and
 * clicking is the thing the count is meant to save you.
 *
 * So count the keywords directly instead. One pass over the message
 * databases at idle establishes the totals, and after that they are kept up
 * to date incrementally from tag, arrival and deletion notifications -- no
 * repeated scanning, and no search per tag.
 *
 * The set of folders counted matches the one a tag folder actually searches
 * when opened -- everything except Trash, Junk, Outbox and virtual folders,
 * ancestors included (see DBViewWrapper's handling of a "*" search scope).
 * Counting anything else would put a number on the row that disagrees with
 * the list you get when you click it.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MailServices: "resource:///modules/MailServices.sys.mjs",
  MailboxScan: "resource:///modules/MailboxScan.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** Sent when any count changes. Data is the tag key, or null for "several". */
export const TAG_COUNTS_CHANGED = "tag-message-counts-changed";

/** Notifications are coalesced over this long, in ms. */
const NOTIFY_DELAY = 250;

/**
 * Folders a tag search does not look in. Trash and Junk hold mail the user
 * has already dismissed, Outbox holds mail that has not been sent yet, and a
 * virtual folder holds nothing of its own -- counting one would tally the
 * messages it points at a second time.
 */
const UNCOUNTED_FOLDER_FLAGS =
  Ci.nsMsgFolderFlags.Trash |
  Ci.nsMsgFolderFlags.Junk |
  Ci.nsMsgFolderFlags.Queue |
  Ci.nsMsgFolderFlags.Virtual;

/**
 * Whether messages in a folder count towards the tag totals.
 *
 * @param {?nsIMsgFolder} folder
 * @returns {boolean}
 */
function isCounted(folder) {
  // Ancestors are checked too, so a subfolder of Trash is skipped as well.
  return Boolean(folder) && !folder.isSpecialFolder(UNCOUNTED_FOLDER_FLAGS, true);
}

/**
 * Whether a message reported as moved away will not be reported again.
 *
 * A moved message leaves its folder quietly -- it is deleted from the database
 * without msgsDeleted -- so the move itself is where it has to be taken out of
 * the count. Two kinds are exceptions, and taking them out here as well would
 * count them out twice, or out without their ever having been in:
 *
 *  - New mail that a filter moves as it arrives is never added to the folder
 *    it arrived in, so no msgAdded was sent for it there. It is still in the
 *    list of messages moved, but not in the source's database.
 *  - On an IMAP account set to mark deleted mail rather than remove it, the
 *    source stays where it was, struck through, and is reported by
 *    msgsDeleted when the folder is expunged.
 *
 * Every path that reports a move does so before it deletes the source, so a
 * header missing from its database at this point was never there.
 *
 * @param {nsIMsgDBHdr} msg
 * @returns {boolean}
 */
function leavesQuietly(msg) {
  const folder = msg.folder;
  try {
    const server = folder.server;
    if (
      server instanceof Ci.nsIImapIncomingServer &&
      server.deleteModel == Ci.nsMsgImapDeleteModels.IMAPDelete
    ) {
      return false;
    }
    // Only asked while the move is being reported, with the source open; a
    // closed database is not opened for this.
    return (
      !folder.databaseOpen || folder.msgDatabase.containsKey(msg.messageKey)
    );
  } catch (ex) {
    return true;
  }
}

/**
 * @param {?nsIMsgFolder} folder
 * @param {nsMsgKey} key
 * @returns {string} What TagMessageCounts._placeholders is keyed by.
 */
function placeholderId(folder, key) {
  return `${folder?.URI}#${key}`;
}

/**
 * Which conversation a message belongs to, for counting: the message that
 * started it, which is the first of its References, or for a message that
 * starts one, the message itself.
 *
 * Read from the message's own headers, so a reply in the Inbox and its copy
 * in Sent -- one row in a tag folder -- are one conversation here too, and a
 * message stays in the same one as other mail arrives and threads join up.
 * A reply sent without References is counted as a conversation of its own.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {string}
 */
function conversationOf(hdr) {
  if (hdr.numReferences > 0) {
    return hdr.getStringReference(0);
  }
  return hdr.messageId || placeholderId(hdr.folder, hdr.messageKey);
}

/**
 * The tag keys in a keywords string.
 *
 * @param {?string} keywords - Space-separated keywords, as stored on a header.
 * @returns {string[]}
 */
function keywordsToKeys(keywords) {
  return (keywords ?? "").split(/\s+/).filter(Boolean);
}

export const TagMessageCounts = {
  _started: false,
  _scanning: false,
  _notifyTimer: null,
  _pendingKey: undefined,

  /**
   * The conversations carrying each tag, by tag key, each with how many of
   * its messages carry it. A conversation stays counted until that reaches
   * zero, so taking the tag off one message of several changes nothing.
   *
   * @type {Map<string, Map<string, number>>}
   */
  _conversations: new Map(),

  /**
   * Placeholders an IMAP move has put in its destination, by
   * "<folder URI>#<key>", with the tags and conversation each was counted
   * under.
   *
   * A placeholder stands in for the moved message until the destination is
   * next synchronised, when the real header replaces it. That is reported as
   * msgKeyChanged followed by msgAdded for the real one -- never as
   * msgsDeleted for the placeholder, which is gone by then, keywords and all.
   * So what it was counted as is kept here, to be taken off again.
   *
   * @type {Map<string, {keys: string[], conversation: string}>}
   */
  _placeholders: new Map(),

  /**
   * Whether the first full scan has finished. Until it has, the counts are
   * incomplete and callers may prefer to show nothing over showing a number
   * that is about to jump.
   *
   * @type {boolean}
   */
  ready: false,

  start() {
    if (this._started) {
      return;
    }
    this._started = true;

    lazy.MailServices.mfn.addListener(
      this,
      lazy.MailServices.mfn.msgPropertyChanged |
        lazy.MailServices.mfn.msgAdded |
        lazy.MailServices.mfn.msgsDeleted |
        lazy.MailServices.mfn.msgsMoveCopyCompleted |
        lazy.MailServices.mfn.msgKeyChanged
    );

    // The counts are not scanned here. Nothing can see them until the
    // folder pane draws a tag row, and scanning at startup reads every
    // header in every folder to produce numbers that are usually never
    // looked at. ensureCounted() does it on first sight instead.
  },

  stop() {
    if (!this._started) {
      return;
    }
    this._started = false;
    lazy.MailServices.mfn.removeListener(this);
  },

  /**
   * Count everything, unless that has already been done or is under way.
   *
   * Called when a tag row is first drawn, so the walk over every folder
   * happens when the numbers are about to be shown rather than on every
   * launch whether or not anyone looks at them.
   *
   * @returns {Promise<void>}
   */
  async ensureCounted() {
    if (this.ready || this._scanning) {
      return;
    }
    await this.refresh().catch(ex =>
      console.error("Could not count tagged messages:", ex)
    );
  },

  /**
   * How many conversations carry a tag.
   *
   * @param {string} tagKey - e.g. "$label1".
   * @returns {integer}
   */
  get(tagKey) {
    return this._conversations.get(tagKey)?.size ?? 0;
  },

  /**
   * Count a message carrying a tag in or out, and let the UI know if that
   * changed how many conversations carry it.
   *
   * @param {string} tagKey
   * @param {string} conversation - From conversationOf().
   * @param {integer} delta - 1 for a message counted in, -1 for one out.
   */
  _bump(tagKey, conversation, delta) {
    let conversations = this._conversations.get(tagKey);
    if (!conversations) {
      conversations = new Map();
      this._conversations.set(tagKey, conversations);
    }
    const before = conversations.size;
    // Never below zero: a message can be deleted from a folder whose headers
    // were never scanned, and it was never counted in.
    const next = (conversations.get(conversation) ?? 0) + delta;
    if (next > 0) {
      conversations.set(conversation, next);
    } else {
      conversations.delete(conversation);
    }
    if (conversations.size != before) {
      this._notify(tagKey);
    }
  },

  /**
   * Announce a change, coalescing bursts -- tagging a selection of fifty
   * messages fires fifty notifications, and the folder pane only needs to
   * redraw once.
   *
   * @param {?string} tagKey - Which tag changed, or null if several did.
   */
  _notify(tagKey) {
    if (this._pendingKey === undefined) {
      this._pendingKey = tagKey;
    } else if (this._pendingKey !== tagKey) {
      this._pendingKey = null;
    }

    if (this._notifyTimer) {
      return;
    }
    this._notifyTimer = lazy.setTimeout(() => {
      this._notifyTimer = null;
      const key = this._pendingKey;
      this._pendingKey = undefined;
      Services.obs.notifyObservers(null, TAG_COUNTS_CHANGED, key);
    }, NOTIFY_DELAY);
  },

  // -- the full scan -------------------------------------------------------

  /**
   * Recount everything from scratch.
   *
   * @returns {Promise<void>}
   */
  async refresh() {
    if (this._scanning) {
      return;
    }
    this._scanning = true;

    // Shared with the other counters that need every header, so the large
    // summaries are read once between them rather than once each.
    let conversations = new Map();
    try {
      await lazy.MailboxScan.scanAll({
        wants: folder => isCounted(folder),
        begin: () => {
          conversations = new Map();
        },
        onMessage: hdr => {
          const keys = keywordsToKeys(hdr.getStringProperty("keywords"));
          if (!keys.length) {
            return;
          }
          const conversation = conversationOf(hdr);
          for (const key of keys) {
            let byConversation = conversations.get(key);
            if (!byConversation) {
              byConversation = new Map();
              conversations.set(key, byConversation);
            }
            byConversation.set(
              conversation,
              (byConversation.get(conversation) ?? 0) + 1
            );
          }
        },
      });
    } finally {
      this._scanning = false;
    }

    this._conversations = conversations;
    this.ready = true;
    this._notify(null);
  },

  // -- staying current -----------------------------------------------------

  msgPropertyChanged(msg, property, oldValue, newValue) {
    if (property != "keywords" || !isCounted(msg?.folder)) {
      return;
    }
    const before = new Set(keywordsToKeys(oldValue));
    const after = new Set(keywordsToKeys(newValue));
    // A placeholder tagged or untagged while it waits is taken off under
    // what it carries now, not what it arrived with.
    const id = placeholderId(msg.folder, msg.messageKey);
    const placeholder = this._placeholders.get(id);
    if (placeholder) {
      placeholder.keys = [...after];
    }
    const conversation = conversationOf(msg);
    for (const key of after) {
      if (!before.has(key)) {
        this._bump(key, conversation, 1);
      }
    }
    for (const key of before) {
      if (!after.has(key)) {
        this._bump(key, conversation, -1);
      }
    }
  },

  msgAdded(msg) {
    if (!isCounted(msg?.folder)) {
      return;
    }
    // Mail arriving from the server can already carry keywords, which is how
    // a tag applied on another device shows up here.
    for (const key of keywordsToKeys(msg.getStringProperty("keywords"))) {
      this._bump(key, conversationOf(msg), 1);
    }
  },

  msgsDeleted(messages) {
    for (const msg of messages) {
      if (!isCounted(msg?.folder)) {
        continue;
      }
      // Taken off here, so it must not be taken off again if a real header
      // is ever reported as replacing it.
      this._placeholders.delete(placeholderId(msg.folder, msg.messageKey));
      for (const key of keywordsToKeys(msg.getStringProperty("keywords"))) {
        this._bump(key, conversationOf(msg), -1);
      }
    }
  },

  msgKeyChanged(oldKey, newMsg) {
    // A placeholder has been replaced by the real header, which msgAdded is
    // about to count. Take the placeholder off under what it was counted as.
    const id = placeholderId(newMsg?.folder, oldKey);
    const placeholder = this._placeholders.get(id);
    if (!placeholder) {
      return;
    }
    this._placeholders.delete(id);
    for (const key of placeholder.keys) {
      this._bump(key, placeholder.conversation, -1);
    }
  },

  msgsMoveCopyCompleted(
    isMove,
    sourceMessages,
    destinationFolder,
    destinationMessages
  ) {
    // Every header is counted once as it enters a database and once as it
    // leaves, and a move or copy is where some of those are reported and
    // nowhere else. A moved source leaves quietly, so it is taken off here.
    // A local destination's new headers come only with this. An IMAP
    // destination gets placeholders here when the move can be undone, which
    // msgKeyChanged later swaps for the real headers, and otherwise gets
    // nothing until msgAdded reports the real ones.
    //
    // Watching msgAdded and msgsDeleted alone never took a moved source off,
    // so every move within an IMAP account -- archiving included -- left its
    // tags one too high, and a copy into a local folder was never counted.
    // Until the next launch, that is, since the full pass runs once.
    //
    // Still not right: a move into an IMAP folder on another account. That
    // path deletes each source as the next is copied, before this is sent,
    // so leavesQuietly() cannot tell those sources from mail a filter moved
    // on arrival, and they stay counted as they always were.
    if (isMove) {
      for (const msg of sourceMessages) {
        if (!isCounted(msg?.folder) || !leavesQuietly(msg)) {
          continue;
        }
        for (const key of keywordsToKeys(msg.getStringProperty("keywords"))) {
          this._bump(key, conversationOf(msg), -1);
        }
      }
    }
    if (isCounted(destinationFolder)) {
      for (const msg of destinationMessages ?? []) {
        const keys = keywordsToKeys(msg.getStringProperty("keywords"));
        const conversation = conversationOf(msg);
        for (const key of keys) {
          this._bump(key, conversation, 1);
        }
        if (msg.getUint32Property("pseudoHdr")) {
          this._placeholders.set(
            placeholderId(destinationFolder, msg.messageKey),
            { keys, conversation }
          );
        }
      }
    }
  },

  QueryInterface: ChromeUtils.generateQI(["nsIMsgFolderListener"]),
};
