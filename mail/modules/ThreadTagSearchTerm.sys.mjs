/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A search term matching a message when any message in its thread carries a
 * tag -- what the folder pane's tag folders search for.
 *
 * A tag folder used to be a saved search for "tag contains X", which lists
 * only the messages that carry the tag themselves. The reply that comes in to
 * a conversation you tagged does not carry it, so the folder showed the
 * conversation without its latest messages: the part you most want to see.
 * With this term a thread is listed whole as soon as any message in it is
 * tagged, the way a starred conversation works in Gmail.
 *
 * "Thread" is the message database's: messages in one folder that Thunderbird
 * threads together. A copy in another folder -- the Sent copy of your own
 * reply -- is judged by the thread it belongs to there.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MailServices: "resource:///modules/MailServices.sys.mjs",
});

/** The term's id, which is also how a saved search spells it. */
export const THREAD_TAG_TERM_ID = "thunderbird-ai#threadTag";

/**
 * How long a thread's answer is trusted without a notification to say it has
 * changed. Tags a server hands down arrive without one, so the cache cannot
 * rely on notifications alone; this is long enough to cover one search over
 * every folder and short enough that the next look at the folder is fresh.
 */
const CACHE_LIFETIME_MS = 10000;

/**
 * The search string for a tag folder.
 *
 * @param {string} key - The tag's key, e.g. "$label1".
 * @returns {string}
 */
export function threadTagSearchString(key) {
  return `AND (${THREAD_TAG_TERM_ID},contains,${key})`;
}

/**
 * Whether a message carries a tag. The whole keyword must match, as for the
 * built-in tag term, so "$label1" does not count as "$label12".
 *
 * @param {nsIMsgDBHdr} hdr
 * @param {string} key
 * @returns {boolean}
 */
function hasKeyword(hdr, key) {
  return (hdr.getStringProperty("keywords") ?? "").split(" ").includes(key);
}

export const ThreadTagSearchTerm = {
  /**
   * Whether a thread has the tag, by "folder URI, thread id, tag". A tag
   * folder's search asks about every message, and without this each message
   * in a thread would walk the whole thread again.
   *
   * @type {Map<string, boolean>}
   */
  _cache: new Map(),

  /** When the cache was last emptied, in ms since the epoch. */
  _cacheStarted: 0,

  _registered: false,

  /**
   * Make the term available to searches. Must happen before a tag folder is
   * first searched -- an unknown term matches nothing -- so this is done
   * before any window opens.
   */
  register() {
    if (this._registered) {
      return;
    }
    this._registered = true;
    if (!lazy.MailServices.filters.getCustomTerm(THREAD_TAG_TERM_ID)) {
      lazy.MailServices.filters.addCustomTerm(this);
    }
    // Anything that can change a thread's answer. Keywords changing is the
    // obvious one; messages arriving, leaving or moving can join threads up
    // or take the tagged message out of one.
    const mfn = lazy.MailServices.mfn;
    mfn.addListener(
      this,
      mfn.msgPropertyChanged |
        mfn.msgAdded |
        mfn.msgsDeleted |
        mfn.msgsMoveCopyCompleted |
        mfn.folderDeleted |
        mfn.folderMoveCopyCompleted |
        mfn.folderRenamed
    );
  },

  /**
   * Whether any message in `hdr`'s thread carries the tag `key`.
   *
   * @param {nsIMsgDBHdr} hdr
   * @param {string} key
   * @returns {boolean}
   */
  threadHasTag(hdr, key) {
    // Most matches, and every tagged message, are settled here.
    if (hasKeyword(hdr, key)) {
      return true;
    }
    const folder = hdr.folder;
    if (!folder) {
      return false;
    }

    if (Date.now() - this._cacheStarted > CACHE_LIFETIME_MS) {
      this._clearCache();
    }
    const cacheKey = `${folder.URI}\n${hdr.threadId}\n${key}`;
    let found = this._cache.get(cacheKey);
    if (found === undefined) {
      found = false;
      try {
        const thread = folder.msgDatabase.getThreadContainingMsgHdr(hdr);
        for (let i = 0; i < thread.numChildren && !found; i++) {
          found = hasKeyword(thread.getChildHdrAt(i), key);
        }
      } catch (ex) {
        // No database or no thread: the message stands alone, and was
        // checked above.
      }
      this._cache.set(cacheKey, found);
    }
    return found;
  },

  _clearCache() {
    this._cache.clear();
    this._cacheStarted = Date.now();
  },

  // -- nsIMsgSearchCustomTerm ---------------------------------------------

  id: THREAD_TAG_TERM_ID,

  // Only seen if the saved search behind a tag folder is opened for editing;
  // the folder pane shows the tag's own name.
  name: "Tag, anywhere in the thread",

  needsBody: false,

  getEnabled() {
    return true;
  },

  getAvailable(scope) {
    // Only what the search and filter editors offer; a search does not ask.
    // It reads the local database, so a search the server runs cannot use
    // it, and it is meant for saved searches rather than filters.
    return scope == Ci.nsMsgSearchScope.offlineMail;
  },

  getAvailableOperators() {
    return [Ci.nsMsgSearchOp.Contains, Ci.nsMsgSearchOp.DoesntContain];
  },

  match(msgHdr, searchValue, searchOp) {
    const found = this.threadHasTag(msgHdr, searchValue);
    return searchOp == Ci.nsMsgSearchOp.DoesntContain ? !found : found;
  },

  // -- nsIMsgFolderListener -----------------------------------------------

  msgPropertyChanged(msg, property) {
    if (property == "keywords") {
      this._clearCache();
    }
  },

  msgAdded() {
    this._clearCache();
  },

  msgsDeleted() {
    this._clearCache();
  },

  msgsMoveCopyCompleted() {
    this._clearCache();
  },

  folderDeleted() {
    this._clearCache();
  },

  folderMoveCopyCompleted() {
    this._clearCache();
  },

  folderRenamed() {
    this._clearCache();
  },

  QueryInterface: ChromeUtils.generateQI([
    "nsIMsgSearchCustomTerm",
    "nsIMsgFolderListener",
  ]),
};
