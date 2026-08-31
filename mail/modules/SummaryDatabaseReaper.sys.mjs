/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Gives back the folder summaries nothing is looking at any more.
 *
 * A folder's summary is opened the first time anything reads the folder and
 * then stays in memory for as long as something holds a reference to it.
 * Nothing in the tree ever takes one back. The database service keeps a list
 * of what is open -- nsMsgDatabase's m_dbCache -- but that list is a
 * registry, not a cache: it has no eviction of its own, and the idle limit
 * that used to drive one went away with the old reaper, along with the
 * mail.db.idle_limit and mail.db.max_open preferences that tuned it. What is
 * left is a session whose memory follows the high-water mark of folders
 * visited. Open a ninety thousand message archive once to find something and
 * its summary is resident until the application quits.
 *
 * So: walk the open summaries every so often and drop the *folder's*
 * reference to any that has gone untouched.
 *
 * Dropping the reference is deliberately weaker than closing the database,
 * and the weakness is the point. Assigning null to nsIMsgFolder.msgDatabase
 * releases only the reference the folder itself holds; a summary that a view
 * is displaying, or that an IMAP sync is still writing to, survives on the
 * strength of that other reference and is freed later, when its real user
 * lets go. forceClosed() would instead take it away mid-use, which is how a
 * reaper of this kind turns into a crash.
 *
 * The whole cost of reaping something that turns out to be wanted again is
 * therefore one msf re-parse, which is why the idle limit below can be as
 * short as it is.
 *
 * There is one case where dropping the reference is not free, and it is why
 * this bothers to look at the front end at all. SetMsgDatabase(nullptr) also
 * stops the folder listening to the database. If the database then stays
 * open because a view holds it, messages read through that view no longer
 * reach the folder, and the unread count in the folder pane drifts until
 * something reopens it. Folders backing an open view are skipped for that
 * reason -- not because reaping them would be unsafe, but because it would
 * be visibly wrong.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
});

/**
 * How long a summary must go untouched before its folder gives up the
 * reference. Thunderbird's own reaper used five minutes back when it had
 * one, and the figure still holds for the same reason: long enough that
 * clicking between two folders re-reads neither, short enough that a folder
 * opened once to search it does not stay for the rest of the session.
 */
const IDLE_LIMIT_MS = 5 * 60 * 1000;

/**
 * How often to look. The walk is over the open summaries only -- tens of
 * entries at worst, most of which are skipped on a timestamp comparison --
 * so this is cheap enough to run this often and rare enough that running it
 * costs nothing worth measuring.
 */
const SWEEP_INTERVAL_MS = 60 * 1000;

/** @returns {nsIMsgDBService} */
function dbService() {
  return Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
}

export const SummaryDatabaseReaper = {
  /** @type {?number} */
  _timer: null,
  _started: false,

  start() {
    if (this._started) {
      return;
    }
    this._started = true;
    this._timer = lazy.setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Under real pressure, idleness stops being the question -- anything a
    // view is not actively holding is worth giving back now.
    Services.obs.addObserver(this, "memory-pressure");
  },

  stop() {
    if (!this._started) {
      return;
    }
    this._started = false;
    if (this._timer !== null) {
      lazy.clearInterval(this._timer);
      this._timer = null;
    }
    Services.obs.removeObserver(this, "memory-pressure");
  },

  observe(subject, topic) {
    if (topic == "memory-pressure") {
      this.sweep(0);
    }
  },

  /**
   * The folders whose summaries a window is relying on: the folder each tab
   * is showing, and -- for a virtual or unified folder, where they are not
   * the same thing -- every folder its view searches across.
   *
   * @returns {Set<string>} Folder URIs.
   */
  _foldersInUse() {
    const inUse = new Set();

    const note = folder => {
      if (folder) {
        inUse.add(folder.URI);
      }
    };

    for (const win of Services.wm.getEnumerator("mail:3pane")) {
      for (const tabInfo of win.gTabmail?.tabInfo ?? []) {
        let about3Pane;
        try {
          about3Pane = tabInfo.chromeBrowser?.contentWindow;
        } catch (ex) {
          // A tab still loading has no content window to ask.
          continue;
        }
        if (!about3Pane) {
          continue;
        }
        note(about3Pane.gFolder);
        for (const folder of about3Pane.gViewWrapper?._underlyingFolders ??
          []) {
          note(folder);
        }
      }
    }

    // A message opened in its own window keeps its folder's summary open the
    // same way a tab does, and is reached differently.
    for (const win of Services.wm.getEnumerator("mail:messageWindow")) {
      try {
        note(win.gMessage?.folder);
      } catch (ex) {
        // Nothing displayed yet.
      }
    }

    return inUse;
  },

  /**
   * Release every summary that has gone untouched for longer than the given
   * limit and that no window is relying on.
   *
   * @param {integer} [idleLimit] - Milliseconds a summary must have been
   *   idle to be taken. Zero takes everything not in use.
   * @returns {integer} How many references were released.
   */
  sweep(idleLimit = IDLE_LIMIT_MS) {
    let open;
    try {
      // An Array, not a live enumerator, so closing as we go is safe.
      open = dbService().openDBs;
    } catch (ex) {
      console.warn("Could not list the open summaries:", ex);
      return 0;
    }

    // lastUseTime is a PRTime -- microseconds.
    const cutoff = (Date.now() - idleLimit) * 1000;
    const inUse = this._foldersInUse();
    let released = 0;

    for (const database of open) {
      let folder;
      try {
        if (database.lastUseTime > cutoff) {
          continue;
        }
        folder = database.folder;
      } catch (ex) {
        // A database mid-close has neither to offer.
        continue;
      }

      if (!folder || inUse.has(folder.URI)) {
        continue;
      }

      try {
        // Nothing to give back if the folder is not the one holding it.
        if (!folder.databaseOpen) {
          continue;
        }
        folder.msgDatabase = null;
        released++;
      } catch (ex) {
        // In use somewhere this cannot see, which is its own answer.
      }
    }

    return released;
  },
};
