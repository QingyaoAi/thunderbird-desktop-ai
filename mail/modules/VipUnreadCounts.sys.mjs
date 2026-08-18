/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * How much unread mail each VIP has sent.
 *
 * The folder pane's VIP rows are virtual folders, and a virtual folder's
 * unread count is only maintained while its own search results database is
 * open. Reading a VIP's mail from the inbox therefore leaves the number on
 * the row exactly where it was -- it is not stale by a moment, it is stale
 * until the folder is opened.
 *
 * So the messages are counted here instead, the same approach TagMessageCounts
 * takes for tags and for the same reason. One pass at first sight, then kept
 * current from notifications.
 *
 * Only unread is counted. How much someone has written in total says nothing
 * about whether any of it needs attention, which is the question a VIP row
 * exists to answer.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MailServices: "resource:///modules/MailServices.sys.mjs",
  VipAddresses: "resource:///modules/SmartMailboxUtils.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** Sent when a count changes. Data is the address, or null for "several". */
export const VIP_UNREAD_CHANGED = "vip-unread-counts-changed";

/** The key used for the aggregate row, which has no address of its own. */
export const ALL_VIPS = "*";

/** Messages scanned before yielding, so a first count stays out of the way. */
const SCAN_CHUNK = 500;

/** Notifications are coalesced over this long, in ms. */
const NOTIFY_DELAY = 250;

/**
 * Folders whose unread mail does not count: reading is the point, and mail
 * already thrown away or filed as junk is not waiting for anyone.
 */
const UNCOUNTED_FOLDER_FLAGS =
  Ci.nsMsgFolderFlags.Trash |
  Ci.nsMsgFolderFlags.Junk |
  Ci.nsMsgFolderFlags.Queue |
  Ci.nsMsgFolderFlags.Virtual;

/**
 * The address a message came from, lowercased, or "" if it cannot be read.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {string}
 */
function senderAddress(hdr) {
  try {
    const author = hdr.mime2DecodedAuthor ?? "";
    // "Name <a@b>" or a bare address; the angle brackets win when present.
    const angled = /<([^>]+)>/.exec(author);
    return (angled ? angled[1] : author).trim().toLowerCase();
  } catch (ex) {
    return "";
  }
}

/**
 * @param {nsIMsgDBHdr} hdr
 * @returns {boolean}
 */
function isUnread(hdr) {
  return !(hdr.flags & Ci.nsMsgMessageFlags.Read);
}

export const VipUnreadCounts = {
  _started: false,
  _scanning: false,
  _notifyTimer: null,
  _pendingKey: undefined,
  _recountTimer: null,
  /** Folders whose unread count changed since the last debounced recount. */
  _dirtyFolders: new Set(),
  /** Per-folder tallies, keyed by folder URI; totals are derived from these. */
  _perFolder: new Map(),

  /** @type {Map<string, number>} Address to unread count. */
  _counts: new Map(),

  /** Whether a full count has completed. */
  ready: false,

  start() {
    if (this._started) {
      return;
    }
    this._started = true;

    // Folders keep their own unread count correct -- that is how ordinary
    // folder rows stay right -- so the cheapest reliable signal that
    // something was read, arrived or was deleted is that count changing.
    // Reacting to the message notifications directly did not work: marking
    // messages read never reached the listener.
    lazy.MailServices.mailSession.AddFolderListener(
      this,
      Ci.nsIFolderListener.intPropertyChanged
    );

    // The VIP list changing invalidates everything counted so far.
    Services.prefs.addObserver("mail.vip.addresses", () => {
      this.ready = false;
      this.refresh().catch(console.error);
    });
  },

  stop() {
    if (!this._started) {
      return;
    }
    this._started = false;
    lazy.MailServices.mailSession.RemoveFolderListener(this);
  },

  /**
   * @param {string} address - A VIP address, or ALL_VIPS.
   * @returns {integer}
   */
  get(address) {
    return this._counts.get(String(address).toLowerCase()) ?? 0;
  },

  /** Count everything, unless that has been done or is under way. */
  async ensureCounted() {
    if (this.ready || this._scanning) {
      return;
    }
    await this.refresh().catch(ex =>
      console.error("Could not count unread VIP mail:", ex)
    );
  },

  /**
   * @param {?string} key
   */
  _notify(key) {
    if (this._pendingKey === undefined) {
      this._pendingKey = key;
    } else if (this._pendingKey !== key) {
      this._pendingKey = null;
    }
    if (this._notifyTimer) {
      return;
    }
    this._notifyTimer = lazy.setTimeout(() => {
      this._notifyTimer = null;
      const changed = this._pendingKey;
      this._pendingKey = undefined;
      Services.obs.notifyObservers(null, VIP_UNREAD_CHANGED, changed);
    }, NOTIFY_DELAY);
  },

  /** @returns {Set<string>} The VIP addresses, lowercased. */
  _addresses() {
    return new Set(lazy.VipAddresses.get().map(a => a.toLowerCase()));
  },

  /**
   * Count unread mail from each wanted address in one folder.
   *
   * @param {nsIMsgFolder} folder
   * @param {Set<string>} wanted
   * @returns {Promise<Map<string, number>>} Per-address counts for this
   *   folder alone. ALL_VIPS is not included; it is derived in _recompute.
   */
  async _countFolder(folder, wanted) {
    const counts = new Map();
    if (!wanted.size || folder.isSpecialFolder(UNCOUNTED_FOLDER_FLAGS, true)) {
      return counts;
    }
    // Nothing unread here, so nothing this pass cares about -- and this
    // avoids opening the database at all, which on a large account is the
    // whole cost.
    if (!folder.getNumUnread(false)) {
      return counts;
    }

    const wasOpen = folder.databaseOpen;
    let database;
    try {
      database = folder.msgDatabase;
    } catch (ex) {
      return counts;
    }
    let scanned = 0;
    try {
      for (const hdr of database.enumerateMessages()) {
        if (!isUnread(hdr)) {
          continue;
        }
        const from = senderAddress(hdr);
        if (wanted.has(from)) {
          counts.set(from, (counts.get(from) ?? 0) + 1);
        }
        if (++scanned % SCAN_CHUNK == 0) {
          await new Promise(r => lazy.setTimeout(r, 0));
        }
      }
    } catch (ex) {
      console.warn(`Could not count VIP mail in ${folder.URI}:`, ex);
    } finally {
      if (!wasOpen) {
        // Clear the folder's reference, not just the one held here:
        // database.close() leaves folder.msgDatabase set and the summary
        // stays in memory for the rest of the session.
        try {
          folder.msgDatabase = null;
        } catch (ex) {
          // Already released, or in use elsewhere.
        }
      }
    }
    return counts;
  },

  /**
   * Add the per-folder tallies up into the totals callers read, including
   * the ALL_VIPS aggregate. Totals are always derived from the per-folder
   * counts rather than adjusted in place, so repeated updates cannot drift
   * away from what a full recount would produce.
   */
  _recompute() {
    const totals = new Map();
    let all = 0;
    for (const perAddress of this._perFolder.values()) {
      for (const [address, n] of perAddress) {
        totals.set(address, (totals.get(address) ?? 0) + n);
        all += n;
      }
    }
    if (all) {
      totals.set(ALL_VIPS, all);
    }
    this._counts = totals;
  },

  /**
   * Recount from scratch.
   *
   * @returns {Promise<Map<string, number>>}
   */
  async refresh() {
    if (this._scanning) {
      return this._counts;
    }
    this._scanning = true;

    const wanted = this._addresses();
    const perFolder = new Map();

    try {
      if (wanted.size) {
        for (const server of lazy.MailServices.accounts.allServers) {
          let folders;
          try {
            folders = server.rootFolder.descendants;
          } catch (ex) {
            continue;
          }
          for (const folder of folders) {
            const counts = await this._countFolder(folder, wanted);
            if (counts.size) {
              perFolder.set(folder.URI, counts);
            }
          }
        }
      }
    } finally {
      this._scanning = false;
    }

    this._perFolder = perFolder;
    this._recompute();
    this.ready = true;
    this._notify(null);
    return this._counts;
  },

  // -- staying current -----------------------------------------------------

  onFolderIntPropertyChanged(folder, property) {
    if (property != "TotalUnreadMessages" || !this.ready) {
      return;
    }
    // The notification says how many unread messages the folder now has, not
    // which ones changed, so the folder is recounted rather than adjusted --
    // but only *that* folder. Rescanning every account here meant a run of
    // messages being read re-read every inbox on the machine, which is also
    // work that reopens summaries this fork otherwise takes care to release.
    // Debounced because reading a run of messages fires this for each one.
    this._dirtyFolders.add(folder);
    if (this._recountTimer) {
      lazy.clearTimeout(this._recountTimer);
    }
    this._recountTimer = lazy.setTimeout(() => {
      this._recountTimer = null;
      const dirty = [...this._dirtyFolders];
      this._dirtyFolders.clear();
      this._recountFolders(dirty).catch(ex =>
        console.warn("Could not recount unread VIP mail:", ex)
      );
    }, 400);
  },

  /**
   * Recount just the folders whose unread count moved, then re-derive the
   * totals. Exact, because each folder's contribution is replaced wholesale
   * rather than nudged.
   *
   * @param {nsIMsgFolder[]} folders
   */
  async _recountFolders(folders) {
    if (this._scanning) {
      // A full refresh is already under way and will supersede this.
      return;
    }
    const wanted = this._addresses();
    for (const folder of folders) {
      const counts = await this._countFolder(folder, wanted);
      if (counts.size) {
        this._perFolder.set(folder.URI, counts);
      } else {
        this._perFolder.delete(folder.URI);
      }
    }
    this._recompute();
    this._notify(null);
  },

  onFolderAdded() {},
  onMessageAdded() {},
  onFolderRemoved(_parent, child) {
    // Drop its contribution, so a removed folder's unread mail stops
    // counting towards the totals.
    if (child?.URI && this._perFolder.delete(child.URI)) {
      this._recompute();
      this._notify(null);
    }
  },
  onMessageRemoved() {},
  onFolderPropertyChanged() {},
  onFolderBoolPropertyChanged() {},
  onFolderPropertyFlagChanged() {},
  onFolderEvent() {},

  QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
};
