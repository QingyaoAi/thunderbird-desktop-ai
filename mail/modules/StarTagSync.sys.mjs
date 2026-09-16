/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Keeps the star and the "Important" tag on a message in step.
 *
 * These are two different things in Thunderbird -- the star is the IMAP
 * \Flagged system flag, the tag is the IMAP keyword $label1 -- but they
 * mean the same thing to someone coming from Apple Mail, where flagging a
 * message is one action. Starring a message tags it, tagging it stars it,
 * and unsetting either unsets the other.
 *
 * Both changes are made through nsIMsgFolder, so they propagate to the
 * server like any other flag or tag change and show up on other clients.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MailServices: "resource:///modules/MailServices.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** The red "Important" tag: Thunderbird's first shipped tag. */
const IMPORTANT_TAG = "$label1";

/**
 * How long to wait before checking that a change took. Long enough for a
 * keyword set on IMAP to have gone to the server and come back, short enough
 * that a star put right is put right while you are still looking at it.
 */
const RETRY_DELAY_MS = 5000;

/** How many messages to reconcile before yielding, so startup stays responsive. */
const RECONCILE_CHUNK = 200;

/**
 * Which version of the one-off pass over existing mail has run. The version is
 * raised whenever a way for mail to fall out of step is closed, so the pass
 * runs once more and picks up what that gap left behind. Clear the pref to run
 * it again -- after importing an account, say.
 */
const RECONCILED_PREF = "mail.startagsync.reconciledVersion";

/** 2: messages that arrived already starred were never tagged. */
const RECONCILE_VERSION = 2;

/**
 * Whether a header carries the Important tag.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {boolean}
 */
function hasImportantTag(hdr) {
  const keywords = hdr.getStringProperty("keywords") ?? "";
  // Match the whole keyword, so "$label12" (were it ever to exist) or a
  // keyword merely containing this one does not count.
  return keywords.split(/\s+/).includes(IMPORTANT_TAG);
}

/**
 * @param {nsIMsgDBHdr} hdr
 * @returns {boolean}
 */
function isStarred(hdr) {
  return Boolean(hdr.flags & Ci.nsMsgMessageFlags.Marked);
}

export const StarTagSync = {
  _started: false,

  /**
   * Messages currently being brought into line, by "folderURI#key".
   *
   * Setting the tag fires a property change, and setting the star fires a
   * flag change, so without this each edit would immediately re-trigger the
   * other handler. The guard is released on a later turn because the
   * notifications it is guarding against are not all synchronous.
   *
   * @type {Set<string>}
   */
  _applying: new Set(),

  /**
   * Messages whose change has already been checked up on once, so a change
   * that will not take does not retry for ever.
   *
   * @type {Set<string>}
   */
  _retried: new Set(),

  /**
   * Start listening. Cheap, and wants to happen before the startup mail check
   * does: a star that comes in before the listeners exist is never tagged.
   */
  start() {
    if (this._started) {
      return;
    }
    this._started = true;

    // Star changed -> tag. Covers stars arriving from the server on messages
    // already here, which is most of flagging on a phone.
    lazy.MailServices.mailSession.AddFolderListener(
      this,
      Ci.nsIFolderListener.propertyFlagChanged
    );

    // Tag changed -> star, and messages that arrive already starred. "keywords"
    // is a message property, so this is the global notification rather than a
    // flag one.
    lazy.MailServices.mfn.addListener(
      this,
      lazy.MailServices.mfn.msgPropertyChanged |
        lazy.MailServices.mfn.msgAdded
    );
  },

  /**
   * Bring existing mail into line, if this version of the pass has not run.
   *
   * Only when it is due, because everything arriving afterwards is handled by
   * the listeners, and repeating the walk on every launch re-reads every
   * header in the account to discover that there is nothing to do.
   *
   * @returns {Promise}
   */
  async reconcileOnce() {
    if (Services.prefs.getIntPref(RECONCILED_PREF, 0) >= RECONCILE_VERSION) {
      return;
    }
    try {
      await this.reconcileAll();
      Services.prefs.setIntPref(RECONCILED_PREF, RECONCILE_VERSION);
    } catch (ex) {
      console.error("Could not reconcile stars and tags:", ex);
    }
  },

  stop() {
    if (!this._started) {
      return;
    }
    this._started = false;
    lazy.MailServices.mailSession.RemoveFolderListener(this);
    lazy.MailServices.mfn.removeListener(this);
  },

  /**
   * @param {nsIMsgDBHdr} hdr
   * @returns {string}
   */
  _guardKey(hdr) {
    return `${hdr.folder?.URI}#${hdr.messageKey}`;
  },

  /**
   * Make the star and the tag agree, using whichever one was just set.
   *
   * @param {nsIMsgDBHdr} hdr
   * @param {boolean} wanted - Whether both should be on.
   */
  _apply(hdr, wanted) {
    const folder = hdr?.folder;
    if (!folder) {
      return;
    }
    const key = this._guardKey(hdr);
    if (this._applying.has(key)) {
      return;
    }

    const starred = isStarred(hdr);
    const tagged = hasImportantTag(hdr);
    if (starred == wanted && tagged == wanted) {
      return;
    }

    this._applying.add(key);
    try {
      if (starred != wanted) {
        folder.markMessagesFlagged([hdr], wanted);
      }
      if (tagged != wanted) {
        if (wanted) {
          folder.addKeywordsToMessages([hdr], IMPORTANT_TAG);
        } else {
          folder.removeKeywordsFromMessages([hdr], IMPORTANT_TAG);
        }
      }
    } catch (ex) {
      console.warn("Could not sync star and Important tag:", ex);
    } finally {
      // Released next turn: some of the notifications this guards against
      // arrive after the calls above return.
      lazy.setTimeout(() => this._applying.delete(key), 0);
      this._checkItTook(hdr, wanted, key);
    }
  },

  /**
   * Look again later, and have one more go if it did not take.
   *
   * Setting a keyword on IMAP is a command queued on a connection, not a
   * local edit: it can fail, and it can be dropped when several are asked
   * for at once. Nothing was watching for that -- the failure path warned to
   * the console and left the message starred but untagged, which is exactly
   * what turned up in practice, four times in two thousand.
   *
   * One retry, and only one. If the second attempt does not hold either then
   * something is refusing the change rather than dropping it, and asking
   * again for ever would neither fix it nor be noticed.
   *
   * @param {nsIMsgDBHdr} hdr
   * @param {boolean} wanted
   * @param {string} key
   */
  _checkItTook(hdr, wanted, key) {
    if (this._retried.has(key)) {
      return;
    }
    lazy.setTimeout(() => {
      // Long enough for a queued IMAP command to have come back.
      if (isStarred(hdr) == wanted && hasImportantTag(hdr) == wanted) {
        this._retried.delete(key);
        return;
      }
      this._retried.add(key);
      this._apply(hdr, wanted);
      // Kept only long enough to stop this attempt starting another.
      lazy.setTimeout(() => this._retried.delete(key), RETRY_DELAY_MS);
    }, RETRY_DELAY_MS);
  },

  // -- nsIFolderListener: the star ----------------------------------------

  onFolderPropertyFlagChanged(msg, property, oldFlag, newFlag) {
    // "Flagged" is the star; this listener also reports "Keywords" and
    // "Status", which are handled elsewhere or not at all.
    if (property != "Flagged") {
      return;
    }
    const wasStarred = Boolean(oldFlag & Ci.nsMsgMessageFlags.Marked);
    const nowStarred = Boolean(newFlag & Ci.nsMsgMessageFlags.Marked);
    if (wasStarred != nowStarred) {
      this._apply(msg, nowStarred);
    }
  },

  onFolderAdded() {},
  onMessageAdded() {},
  onFolderRemoved() {},
  onMessageRemoved() {},
  onFolderPropertyChanged() {},
  onFolderIntPropertyChanged() {},
  onFolderBoolPropertyChanged() {},
  onFolderEvent() {},

  // -- nsIMsgFolderListener: the tag ---------------------------------------

  msgPropertyChanged(msg, property, oldValue, newValue) {
    if (property != "keywords") {
      return;
    }
    const had = (oldValue ?? "").split(/\s+/).includes(IMPORTANT_TAG);
    const has = (newValue ?? "").split(/\s+/).includes(IMPORTANT_TAG);
    if (had != has) {
      this._apply(msg, has);
    }
  },

  msgAdded(msg) {
    // A message starred on another device before this one had seen it arrives
    // with the star already set. IMAP puts the server's flags on the header
    // before adding it, so no flag change is ever reported for it.
    if (isStarred(msg) != hasImportantTag(msg)) {
      // Not from inside the notification, which is sent while the folder is
      // still taking in headers; setting a keyword queues a server command.
      // Either one set means "important", as in reconcileFolder.
      lazy.setTimeout(() => this._apply(msg, true), 0);
    }
  },

  // -- retroactive ---------------------------------------------------------

  /**
   * Bring every existing message into line, once.
   *
   * Only messages where the star and the tag disagree are touched, so this
   * is cheap on a mailbox that is already consistent and, importantly,
   * writes nothing to the server for them.
   *
   * @returns {Promise<{checked: number, fixed: number}>}
   */
  async reconcileAll() {
    let checked = 0;
    let fixed = 0;

    for (const server of lazy.MailServices.accounts.allServers) {
      let folders;
      try {
        folders = server.rootFolder.descendants;
      } catch (ex) {
        console.warn(`Could not list folders for ${server.prettyName}:`, ex);
        continue;
      }

      for (const folder of folders) {
        // Virtual folders hold no messages of their own, and the results
        // would be reconciled twice through their real folders.
        if (folder.getFlag(Ci.nsMsgFolderFlags.Virtual)) {
          continue;
        }
        const result = await this.reconcileFolder(folder);
        checked += result.checked;
        fixed += result.fixed;
      }
    }

    if (fixed) {
      console.info(
        `Star/Important tag: aligned ${fixed} of ${checked} messages.`
      );
    }
    return { checked, fixed };
  },

  /**
   * Reconcile one folder.
   *
   * @param {nsIMsgFolder} folder
   * @returns {Promise<{checked: number, fixed: number}>}
   */
  async reconcileFolder(folder) {
    let checked = 0;
    let fixed = 0;

    // Same care as TagMessageCounts: a database opened here stays in memory
    // until it is closed, and this walks every folder.
    const wasOpen = folder.databaseOpen;
    let database;
    try {
      database = folder.msgDatabase;
    } catch (ex) {
      // A folder whose summary is missing would have to be rebuilt, which
      // is too heavy a side effect for a background pass.
      return { checked, fixed };
    }
    if (!database) {
      return { checked, fixed };
    }

    try {
      for (const hdr of database.enumerateMessages()) {
        checked++;
        const starred = isStarred(hdr);
        const tagged = hasImportantTag(hdr);
        if (starred != tagged) {
          // Either one being set means the user meant "important", so the
          // union wins and nothing already marked is silently cleared.
          this._apply(hdr, true);
          fixed++;
        }
        if (checked % RECONCILE_CHUNK == 0) {
          // Let the UI breathe; a large mailbox is a lot of headers.
          await new Promise(resolve => lazy.setTimeout(resolve, 0));
        }
      }
    } catch (ex) {
      console.warn(`Could not reconcile ${folder.URI}:`, ex);
    } finally {
      if (!wasOpen) {
        try {
          // Assigning null commits -- which this pass needs, since it may
          // have written keywords -- and also clears the folder's own
          // reference. database.close() only released the handle held here,
          // leaving the summary in memory for the rest of the session.
          folder.msgDatabase = null;
        } catch (ex) {
          // Already released, or in use elsewhere.
        }
      }
    }

    return { checked, fixed };
  },

  QueryInterface: ChromeUtils.generateQI([
    "nsIFolderListener",
    "nsIMsgFolderListener",
  ]),
};
