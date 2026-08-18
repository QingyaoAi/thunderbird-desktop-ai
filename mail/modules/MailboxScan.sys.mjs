/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * One walk of the mailbox, shared by everything that needs to read every
 * message.
 *
 * Counting tags and counting a VIP's unread mail both want the same thing --
 * every header in every folder -- and both are triggered by the folder pane
 * drawing its rows, so they ask within moments of each other. Run separately
 * that reads the large summaries twice, and re-reads them, since these passes
 * release the databases they open rather than leaving them in memory.
 *
 * Requests made close together are therefore collected and served by a single
 * traversal. Each folder's database is opened once, enumerated once, and every
 * interested consumer sees each header. A folder no consumer wants is never
 * opened at all, which is what keeps this affordable on a large account.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MailServices: "resource:///modules/MailServices.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

// Headers read between yields. The walk is chunked so a large account does
// not lock the interface up while it runs.
const SCAN_CHUNK = 500;

// How long a request waits for company before the walk starts. Long enough
// for the folder pane to finish drawing its rows, short enough not to be a
// visible delay before the first counts appear.
const BATCH_DELAY = 100;

/**
 * A consumer of the walk.
 *
 * @typedef {object} ScanConsumer
 * @property {function(nsIMsgFolder): boolean} wants - Whether this folder is
 *   worth reading. Returning false for every consumer means the folder's
 *   database is never opened.
 * @property {function(): void} [begin] - Called before the walk starts.
 * @property {function(nsIMsgDBHdr, nsIMsgFolder): void} onMessage
 * @property {function(): void} [finish] - Called once the walk is done.
 */

/** @returns {nsIMsgFolder[]} Every folder in every account. */
function allFolders() {
  const folders = [];
  for (const server of lazy.MailServices.accounts.allServers) {
    try {
      folders.push(...server.rootFolder.descendants);
    } catch (ex) {
      console.warn(`Could not list folders for ${server.prettyName}:`, ex);
    }
  }
  return folders;
}

/**
 * Read the given folders once, feeding every interested consumer.
 *
 * @param {ScanConsumer[]} consumers
 * @param {nsIMsgFolder[]} folders
 */
async function walk(consumers, folders) {
  for (const consumer of consumers) {
    consumer.begin?.();
  }

  let scanned = 0;
  for (const folder of folders) {
    const interested = consumers.filter(consumer => {
      try {
        return consumer.wants(folder);
      } catch (ex) {
        return false;
      }
    });
    if (!interested.length) {
      continue;
    }

    // Opening a folder's database keeps it in memory until something closes
    // it, so note whether it was already open and put back only what this
    // walk opened. Assigning null is what releases it -- close() drops the
    // handle held here but leaves the folder's own reference in place.
    const wasOpen = folder.databaseOpen;
    let database;
    try {
      database = folder.msgDatabase;
    } catch (ex) {
      // A folder whose summary is missing would have to be rebuilt, which
      // is too heavy a side effect for a count.
      continue;
    }
    if (!database) {
      continue;
    }

    try {
      for (const hdr of database.enumerateMessages()) {
        for (const consumer of interested) {
          try {
            consumer.onMessage(hdr, folder);
          } catch (ex) {
            // One consumer failing must not abandon the walk for the others.
          }
        }
        if (++scanned % SCAN_CHUNK == 0) {
          await new Promise(resolve => lazy.setTimeout(resolve, 0));
        }
      }
    } catch (ex) {
      console.warn(`Could not read messages in ${folder.URI}:`, ex);
    } finally {
      if (!wasOpen) {
        try {
          folder.msgDatabase = null;
        } catch (ex) {
          // Already released, or in use elsewhere.
        }
      }
    }
  }

  for (const consumer of consumers) {
    consumer.finish?.();
  }
}

export const MailboxScan = {
  /** @type {?number} */
  _batchTimer: null,
  /** @type {Array<{consumer: ScanConsumer, resolve: Function}>} */
  _waiting: [],
  _running: false,

  /**
   * Read every folder, sharing the walk with any other request made at about
   * the same time.
   *
   * @param {ScanConsumer} consumer
   * @returns {Promise<void>} Resolved once this consumer has seen everything.
   */
  scanAll(consumer) {
    return new Promise(resolve => {
      this._waiting.push({ consumer, resolve });
      if (this._batchTimer === null && !this._running) {
        this._batchTimer = lazy.setTimeout(() => this._flush(), BATCH_DELAY);
      }
    });
  },

  /**
   * Read particular folders for a single consumer, without waiting for
   * company. Used for the targeted recounts that follow a change, where
   * there is nothing to share with.
   *
   * @param {ScanConsumer} consumer
   * @param {nsIMsgFolder[]} folders
   * @returns {Promise<void>}
   */
  async scanFolders(consumer, folders) {
    await walk([consumer], folders);
  },

  async _flush() {
    this._batchTimer = null;
    if (this._running || !this._waiting.length) {
      return;
    }
    const batch = this._waiting;
    this._waiting = [];
    this._running = true;
    try {
      await walk(
        batch.map(entry => entry.consumer),
        allFolders()
      );
    } catch (ex) {
      console.error("Mailbox walk failed:", ex);
    } finally {
      this._running = false;
      for (const entry of batch) {
        entry.resolve();
      }
      // Anything that asked while this was running gets its own walk.
      if (this._waiting.length && this._batchTimer === null) {
        this._batchTimer = lazy.setTimeout(() => this._flush(), BATCH_DELAY);
      }
    }
  },
};
