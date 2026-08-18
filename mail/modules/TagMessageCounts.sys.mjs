/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * How many messages carry each tag.
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
   * Message count by tag key. Absent means zero.
   *
   * @type {Map<string, number>}
   */
  _counts: new Map(),

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
        lazy.MailServices.mfn.msgsDeleted
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
   * How many messages carry a tag.
   *
   * @param {string} tagKey - e.g. "$label1".
   * @returns {integer}
   */
  get(tagKey) {
    return this._counts.get(tagKey) ?? 0;
  },

  /**
   * Adjust a tag's count, and let the UI know.
   *
   * @param {string} tagKey
   * @param {integer} delta
   */
  _bump(tagKey, delta) {
    if (!delta) {
      return;
    }
    // Clamped because a message can be deleted from a folder whose headers
    // were never scanned, which would otherwise drive the count negative.
    const next = Math.max(0, this.get(tagKey) + delta);
    if (next == this.get(tagKey)) {
      return;
    }
    this._counts.set(tagKey, next);
    this._notify(tagKey);
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
   * @returns {Promise<Map<string, number>>} The new counts.
   */
  async refresh() {
    if (this._scanning) {
      return this._counts;
    }
    this._scanning = true;

    // Shared with the other counters that need every header, so the large
    // summaries are read once between them rather than once each.
    let counts = new Map();
    try {
      await lazy.MailboxScan.scanAll({
        wants: folder => isCounted(folder),
        begin: () => {
          counts = new Map();
        },
        onMessage: hdr => {
          for (const key of keywordsToKeys(hdr.getStringProperty("keywords"))) {
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        },
      });
    } finally {
      this._scanning = false;
    }

    this._counts = counts;
    this.ready = true;
    this._notify(null);
    return counts;
  },

  // -- staying current -----------------------------------------------------

  msgPropertyChanged(msg, property, oldValue, newValue) {
    if (property != "keywords" || !isCounted(msg?.folder)) {
      return;
    }
    const before = new Set(keywordsToKeys(oldValue));
    const after = new Set(keywordsToKeys(newValue));
    for (const key of after) {
      if (!before.has(key)) {
        this._bump(key, 1);
      }
    }
    for (const key of before) {
      if (!after.has(key)) {
        this._bump(key, -1);
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
      this._bump(key, 1);
    }
  },

  msgsDeleted(messages) {
    for (const msg of messages) {
      if (!isCounted(msg?.folder)) {
        continue;
      }
      for (const key of keywordsToKeys(msg.getStringProperty("keywords"))) {
        this._bump(key, -1);
      }
    }
  },

  QueryInterface: ChromeUtils.generateQI(["nsIMsgFolderListener"]),
};
