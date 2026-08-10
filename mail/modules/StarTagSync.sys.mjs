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

/** How many messages to reconcile before yielding, so startup stays responsive. */
const RECONCILE_CHUNK = 200;

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

  start() {
    if (this._started) {
      return;
    }
    this._started = true;

    // Star changed -> tag. Covers stars arriving from the server, which is
    // the case that matters when flagging happens on a phone.
    lazy.MailServices.mailSession.AddFolderListener(
      this,
      Ci.nsIFolderListener.propertyFlagChanged
    );

    // Tag changed -> star. "keywords" is a message property, so this is the
    // global property notification rather than a flag one.
    lazy.MailServices.mfn.addListener(
      this,
      lazy.MailServices.mfn.msgPropertyChanged
    );

    // Existing mail predates the listeners, so bring it into line too.
    this.reconcileAll().catch(ex =>
      console.error("Could not reconcile stars and tags:", ex)
    );
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
    }
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
    }

    return { checked, fixed };
  },

  QueryInterface: ChromeUtils.generateQI([
    "nsIFolderListener",
    "nsIMsgFolderListener",
  ]),
};
