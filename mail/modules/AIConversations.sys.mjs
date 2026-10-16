/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The AI panel's conversations, kept so that an earlier one can be read again
 * and carried on.
 *
 * Each is a file of its own in `<profile>/ai-conversations/`, holding what the
 * panel showed -- the questions, and for each answer its reasoning, the tools
 * dsh used and the answer itself, as Markdown -- and what is needed to go on
 * with it: the history sent to the panel's own model, and the dsh session, if
 * dsh answered. dsh keeps that session's context itself and can reopen it, but
 * gives back none of what was said in it, so what is shown has to be kept here.
 *
 * `index.json` beside them lists them with their titles, so that the list in
 * the panel does not mean reading every conversation in full. It is rebuilt
 * from the files themselves if it is lost.
 */

/** Bumped if what is kept changes in a way older code would misread. */
const VERSION = 1;

/** How much of the first question a conversation is named with. */
const TITLE_LENGTH = 80;

/**
 * Whether an id is safe to make a file name of. Ours are UUIDs, but the
 * index is a file anyone can edit.
 *
 * @param {string} id
 * @returns {boolean}
 */
function isSafeId(id) {
  return typeof id == "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

/**
 * What the list needs of a conversation.
 *
 * @param {object} record
 * @returns {{id: string, title: string, created: string, updated: string, dsh: ?object}}
 */
function entryFor(record) {
  return {
    id: record.id,
    title: record.title,
    created: record.created,
    updated: record.updated,
    dsh: record.dsh ?? null,
  };
}

export const AIConversations = {
  /** Serializes reads and writes. */
  _chain: Promise.resolve(),

  /**
   * Conversations removed since startup, so that a save still queued for one
   * does not bring it back.
   *
   * @type {Set<string>}
   */
  _removed: new Set(),

  /** @returns {string} */
  get _dir() {
    return PathUtils.join(PathUtils.profileDir, "ai-conversations");
  },

  /** @returns {string} */
  get _indexFile() {
    return PathUtils.join(this._dir, "index.json");
  },

  /**
   * @param {string} id
   * @returns {string}
   */
  _file(id) {
    return PathUtils.join(this._dir, `${id}.json`);
  },

  /**
   * Run a task after every one before it has finished.
   *
   * @param {function(): Promise<*>} task
   * @returns {Promise<*>}
   */
  _queue(task) {
    const next = this._chain.then(task);
    this._chain = next.catch(() => {});
    return next;
  },

  /**
   * The index, or what it should say, worked out from the files when it is
   * missing or unreadable.
   *
   * @returns {Promise<object[]>}
   */
  async _readIndex() {
    try {
      const { conversations } = await IOUtils.readJSON(this._indexFile);
      if (Array.isArray(conversations)) {
        return conversations.filter(entry => isSafeId(entry?.id));
      }
    } catch (ex) {
      // Not there yet, or damaged: rebuilt below.
    }
    let children = [];
    try {
      children = await IOUtils.getChildren(this._dir);
    } catch (ex) {
      // No conversations at all.
      return [];
    }
    const entries = [];
    for (const path of children) {
      const name = PathUtils.filename(path);
      if (!name.endsWith(".json") || name == "index.json") {
        continue;
      }
      try {
        const record = await IOUtils.readJSON(path);
        if (isSafeId(record?.id) && `${record.id}.json` == name) {
          entries.push(entryFor(record));
        }
      } catch (ex) {
        // Not one of ours, or half-written.
      }
    }
    return entries;
  },

  async _writeIndex(entries) {
    await IOUtils.writeJSON(
      this._indexFile,
      { conversations: entries },
      { tmpPath: `${this._indexFile}.tmp` }
    );
  },

  /**
   * A new conversation, named after the question that begins it. Nothing is
   * written until it is saved.
   *
   * @param {string} question
   * @returns {object}
   */
  create(question) {
    const now = new Date().toISOString();
    return {
      version: VERSION,
      id: Services.uuid.generateUUID().toString().slice(1, -1),
      title: this.titleFor(question),
      created: now,
      updated: now,
      dsh: null,
      messages: [],
      mentions: new Map(),
      turns: [],
    };
  },

  /**
   * @param {string} question
   * @returns {string} The question on one line, cut short if long.
   */
  titleFor(question) {
    const line = String(question ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return line.length > TITLE_LENGTH
      ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…`
      : line;
  },

  /**
   * @returns {Promise<object[]>} Every conversation, latest first, as
   *   {id, title, created, updated, dsh}.
   */
  list() {
    return this._queue(async () => {
      const entries = await this._readIndex();
      return entries.sort((a, b) =>
        String(b.updated).localeCompare(String(a.updated))
      );
    });
  },

  /**
   * @param {string} id
   * @returns {Promise<?object>} The whole conversation, or null if it is gone.
   *   Its mentions -- the subject of each message dsh's tools returned, to
   *   that message's URI -- come back as a Map, as create() makes them.
   */
  load(id) {
    if (!isSafeId(id)) {
      return Promise.resolve(null);
    }
    return this._queue(async () => {
      try {
        const record = await IOUtils.readJSON(this._file(id));
        if (record?.id != id) {
          return null;
        }
        record.mentions = new Map(Object.entries(record.mentions ?? {}));
        record.messages ??= [];
        record.turns ??= [];
        return record;
      } catch (ex) {
        return null;
      }
    });
  },

  /**
   * Write a conversation, and its entry in the list.
   *
   * @param {object} record
   */
  save(record) {
    if (!isSafeId(record?.id)) {
      return Promise.resolve();
    }
    // Copied now: the panel goes on changing the record while this waits.
    const snapshot = JSON.parse(
      JSON.stringify(record, (key, value) =>
        // Not instanceof: the Map may have been made in a window's global.
        Object.prototype.toString.call(value) == "[object Map]"
          ? Object.fromEntries(value)
          : value
      )
    );
    return this._queue(async () => {
      if (this._removed.has(snapshot.id)) {
        return;
      }
      await IOUtils.makeDirectory(this._dir, { ignoreExisting: true });
      await IOUtils.writeJSON(this._file(snapshot.id), snapshot, {
        tmpPath: `${this._file(snapshot.id)}.tmp`,
      });
      const entries = (await this._readIndex()).filter(
        entry => entry.id != snapshot.id
      );
      entries.push(entryFor(snapshot));
      await this._writeIndex(entries);
    });
  },

  /**
   * Delete conversations.
   *
   * @param {string[]} ids
   * @returns {Promise<object[]>} The entries of those that were there.
   */
  remove(ids) {
    const wanted = new Set(ids.filter(isSafeId));
    for (const id of wanted) {
      this._removed.add(id);
    }
    return this._queue(async () => {
      const entries = await this._readIndex();
      const removed = entries.filter(entry => wanted.has(entry.id));
      for (const id of wanted) {
        await IOUtils.remove(this._file(id), { ignoreAbsent: true });
      }
      if (removed.length) {
        await this._writeIndex(entries.filter(entry => !wanted.has(entry.id)));
      }
      return removed;
    });
  },

  /**
   * Delete the conversations dsh answered in any of these sessions: once the
   * session is gone, there is no carrying on with them.
   *
   * @param {string[]} sessionIds
   * @returns {Promise<string[]>} The ids of the conversations deleted.
   */
  async removeForDshSessions(sessionIds) {
    const gone = new Set(sessionIds);
    const ids = (await this.list())
      .filter(entry => gone.has(entry.dsh?.sessionId))
      .map(entry => entry.id);
    if (ids.length) {
      await this.remove(ids);
    }
    return ids;
  },
};
