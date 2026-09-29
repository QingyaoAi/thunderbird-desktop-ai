/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * DeepSeek Harness (dsh), run as an agent the AI panel can talk to.
 *
 * dsh is a separate program, started only when asked for -- never with
 * Thunderbird -- in its ACP mode: the Agent Client Protocol, JSON-RPC over the
 * program's stdin and stdout, the way editors drive coding agents. Thunderbird
 * is the client. It hands the agent this mailbox as an MCP server, on the mail
 * endpoint's `/mcp` route with a token made for the run and revoked when the
 * run ends, and passes on to the panel what the agent says and does.
 *
 * dsh keeps its own model settings and keys; none are configured here. What
 * is: where node and dsh are, and the folder the agent works in. It can run
 * commands and read and write files there, and asks before doing so.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  MailMcpServer: "resource:///modules/MailMcpServer.sys.mjs",
  MailMcpTokens: "resource:///modules/MailMcpServer.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** Where the settings are kept. None has a default in the pref files. */
export const DSH_PREFS = {
  node: "mail.ai.dsh.node",
  dsh: "mail.ai.dsh.path",
  workspace: "mail.ai.dsh.workspace",
};

/**
 * Where node usually is, tried in order when no path has been set.
 * Thunderbird started from the Dock has only the system PATH, which has none
 * of these, so a PATH search would not find node where it actually is.
 */
const NODE_CANDIDATES = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
];

/**
 * Where an installed dsh usually is, tried after the folder node is in --
 * where `npm install -g` puts it -- when no path has been set.
 */
const DSH_CANDIDATES = ["/opt/homebrew/bin/dsh", "/usr/local/bin/dsh"];

/**
 * What dsh started from Thunderbird is told it is for.
 *
 * dsh's ACP profile introduces it as a coding agent, which sends it to the
 * web and the shell for anything it does not already know. Started from the
 * mail client, the mailbox is the first place to look, whatever the task --
 * and a message it cites should be a link the user can click. The link rule is
 * here rather than only in the mail endpoint's MCP instructions because dsh
 * does not pass on the instructions of an MCP server a client attaches. This
 * goes to dsh as a patch layer for this run only -- the `--patch` it is started
 * with -- so dsh started any other way is not affected. `{{model}}` and
 * `{{cwd}}` are dsh's own template variables.
 */
const PERSONA_PATCH = `# Written by Thunderbird each time it starts dsh, for that run only.
- id: system-prompt
  config:
    personaPrefix: >-
      You are the mail assistant in the user's Thunderbird, powered by the
      {{model}} model. The user is talking to you from their mail client, so
      whatever the task, their mailbox is the first place to look: search it
      with the thunderbird tools (mcp__thunderbird__search_mail, sorting by
      date for anything recent, then get_thread, get_message and
      get_attachment to read what you find), and answer from what the mail
      says. Turn to the web, the shell or files only when the mailbox has
      nothing that answers it, or the task plainly needs them, and then say
      that the mail did not have it.

      Link every message you cite. A message's id, as the thunderbird tools
      return it, opens that message in Thunderbird when it is the target of
      a Markdown link written with angle brackets, like this:
      [Meta-reviews due on Oct 3](<imap-message://me%40example.com@mail.example.com/INBOX#1234>).
      Use the subject, or a short description, as the link text. Copy the id
      exactly as the tool gave it, and never write one that did not come from
      a tool result. Do not name a message in quotation marks or 《》 instead
      of linking it.
    personaSuffix: Your working directory is {{cwd}}.
`;

/** How long a closing session may take before the process is killed. */
const CLOSE_TIMEOUT_MS = 3000;

/** How much of dsh's error output to keep, for when it fails to start. */
const STDERR_KEEP = 4000;

/** How long quitting waits for running agents to stop. */
const SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * Agents with a process, so that quitting stops them. Closing the pipes, which
 * is all Subprocess does at shutdown, leaves it to the program whether to
 * exit; a harness with work in hand may not.
 *
 * @type {Set<DshAgent>}
 */
const runningAgents = new Set();
let stopsAtShutdown = false;

function stopAtShutdown() {
  if (stopsAtShutdown) {
    return;
  }
  stopsAtShutdown = true;
  try {
    lazy.AsyncShutdown.profileBeforeChange.addBlocker("dsh: stop agents", () =>
      Promise.race([
        Promise.all([...runningAgents].map(agent => agent.stop())),
        new Promise(resolve => lazy.setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ])
    );
  } catch (ex) {
    // Already shutting down.
  }
}

/**
 * A failure the panel can explain, rather than a stack trace.
 */
export class DshError extends Error {
  /**
   * @param {string} code - "no-node", "no-dsh", "mail-access-off" or "failed".
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "DshError";
    this.code = code;
  }
}

export const DshSettings = {
  /**
   * The settings in force, with the ones left unset filled in.
   *
   * @returns {Promise<{node: string, dsh: string, workspace: string}>}
   */
  async get() {
    let node = Services.prefs.getStringPref(DSH_PREFS.node, "");
    if (!node) {
      for (const candidate of NODE_CANDIDATES) {
        if (await IOUtils.exists(candidate)) {
          node = candidate;
          break;
        }
      }
    }
    let dsh = Services.prefs.getStringPref(DSH_PREFS.dsh, "");
    if (!dsh) {
      const nextToNode = node
        ? [PathUtils.join(PathUtils.parent(node), "dsh")]
        : [];
      for (const candidate of [...nextToNode, ...DSH_CANDIDATES]) {
        if (await IOUtils.exists(candidate)) {
          dsh = candidate;
          break;
        }
      }
    }
    return {
      node,
      dsh,
      workspace:
        Services.prefs.getStringPref(DSH_PREFS.workspace, "") ||
        PathUtils.join(PathUtils.tempDir, "thunderbird-dsh"),
    };
  },

  /**
   * @param {"node"|"dsh"|"workspace"} key
   * @param {string} value - A path; empty goes back to the default.
   */
  set(key, value) {
    if (value) {
      Services.prefs.setStringPref(DSH_PREFS[key], value);
    } else {
      Services.prefs.clearUserPref(DSH_PREFS[key]);
    }
  },
};

/**
 * The sessions Thunderbird has started in dsh, so they can be cleared without
 * touching the ones started any other way.
 *
 * dsh keeps a session in two places under its home folder (`$DSH_HOME`, or
 * `~/.dsh`): its log, in `sessions/<folder for the working folder>/<id>/`, and
 * a cache that follows the log, `storages/session_projcache/sessions/<id>.json`.
 * The folder name encodes the working folder in a way that is dsh's own
 * business, so a session is found by its id rather than by working out that
 * name -- and a folder the user also runs dsh in by hand is never emptied
 * wholesale.
 */
export const DshSessions = {
  /** Serializes reads and writes of the record. */
  _chain: Promise.resolve(),

  /** @returns {string} Where the record is kept. */
  get _file() {
    return PathUtils.join(PathUtils.profileDir, "dsh-sessions.json");
  },

  /** @returns {string} dsh's home folder. */
  get home() {
    return (
      Services.env.get("DSH_HOME") ||
      PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ".dsh")
    );
  },

  /**
   * @param {function(object[]): (object[]|Promise<object[]>)} change - Given
   *   the recorded sessions, returns what to record instead.
   * @returns {Promise<object[]>} What is recorded afterwards.
   */
  _update(change) {
    const next = this._chain.then(async () => {
      let sessions = [];
      try {
        sessions = (await IOUtils.readJSON(this._file)).sessions ?? [];
      } catch (ex) {
        // Nothing recorded yet.
      }
      const changed = await change(sessions);
      if (changed != sessions) {
        await IOUtils.writeJSON(this._file, { sessions: changed });
      }
      return changed;
    });
    this._chain = next.catch(() => {});
    return next;
  },

  /**
   * @returns {Promise<object[]>} {id, workspace, created} for each.
   */
  list() {
    return this._update(sessions => sessions);
  },

  /**
   * Record a session Thunderbird has just started.
   *
   * @param {string} id
   * @param {string} workspace
   */
  remember(id, workspace) {
    if (!isSafeId(id)) {
      return Promise.resolve();
    }
    return this._update(sessions => [
      ...sessions.filter(s => s.id != id),
      { id, workspace, created: new Date().toISOString() },
    ]);
  },

  /**
   * Delete the sessions Thunderbird started, except those still in use.
   *
   * @param {string[]} [keep] - Ids to leave alone: the session open now.
   * @returns {Promise<number>} How many were deleted.
   */
  async clear(keep = []) {
    let deleted = 0;
    await this._update(async sessions => {
      const sessionsDir = PathUtils.join(this.home, "sessions");
      let projects = [];
      try {
        projects = await IOUtils.getChildren(sessionsDir);
      } catch (ex) {
        // dsh has no sessions at all.
      }
      const kept = [];
      for (const session of sessions) {
        if (keep.includes(session.id)) {
          kept.push(session);
          continue;
        }
        if (!isSafeId(session.id)) {
          continue;
        }
        let found = false;
        for (const project of projects) {
          const dir = PathUtils.join(project, session.id);
          if (await IOUtils.exists(dir)) {
            await IOUtils.remove(dir, { recursive: true });
            found = true;
          }
        }
        await IOUtils.remove(
          PathUtils.join(
            this.home,
            "storages",
            "session_projcache",
            "sessions",
            `${session.id}.json`
          ),
          { ignoreAbsent: true }
        );
        if (found) {
          deleted++;
        }
      }
      return kept;
    });
    return deleted;
  },
};

/**
 * Whether a session id is safe to put in a path. It comes from dsh, and is
 * only ever used as one path segment, never to go anywhere else.
 *
 * @param {string} id
 * @returns {boolean}
 */
function isSafeId(id) {
  return typeof id == "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

/**
 * JSON-RPC 2.0, one message per line, in both directions: requests either
 * side can make, their responses, and notifications.
 *
 * Knows nothing of processes; it is handed a function to write a line with
 * and is fed whatever is read.
 */
export class AcpConnection {
  /**
   * @param {function(string)} write - Sends one line, newline included.
   * @param {object} handlers
   * @param {function(string, object)} handlers.onNotification
   * @param {function(string, object): Promise<object>} handlers.onRequest -
   *   Answers a request from the other side, or throws to refuse it.
   */
  constructor(write, { onNotification, onRequest }) {
    this._write = write;
    this._onNotification = onNotification;
    this._onRequest = onRequest;
    this._nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this._pending = new Map();
    this._buffer = "";
    this._closed = null;
  }

  /**
   * @param {string} method
   * @param {object} params
   * @returns {Promise<object>} The result, or a rejection with the error.
   */
  request(method, params) {
    if (this._closed) {
      return Promise.reject(this._closed);
    }
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * @param {string} method
   * @param {object} params
   */
  notify(method, params) {
    if (!this._closed) {
      this._send({ jsonrpc: "2.0", method, params });
    }
  }

  /**
   * Take in text read from the other side, in whatever pieces it came.
   *
   * @param {string} text
   */
  receive(text) {
    this._buffer += text;
    let end;
    while ((end = this._buffer.indexOf("\n")) > -1) {
      const line = this._buffer.slice(0, end).trim();
      this._buffer = this._buffer.slice(end + 1);
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (ex) {
        // Output that is not the protocol -- a stray log line -- is not a
        // reason to drop the connection.
        console.warn("dsh: ignoring a line that is not JSON:", line);
        continue;
      }
      this._dispatch(message);
    }
  }

  /**
   * Fail everything still waiting, and refuse anything further.
   *
   * @param {Error} error
   */
  close(error) {
    this._closed ??= error;
    for (const { reject } of this._pending.values()) {
      reject(this._closed);
    }
    this._pending.clear();
  }

  _send(message) {
    this._write(JSON.stringify(message) + "\n");
  }

  _dispatch(message) {
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method == "string") {
      if (!hasId) {
        this._onNotification?.(message.method, message.params);
        return;
      }
      Promise.resolve()
        .then(() => this._onRequest(message.method, message.params))
        .then(
          result => {
            if (!this._closed) {
              this._send({ jsonrpc: "2.0", id: message.id, result });
            }
          },
          ex => {
            if (!this._closed) {
              this._send({
                jsonrpc: "2.0",
                id: message.id,
                error: {
                  code: ex?.code ?? -32603,
                  message: String(ex?.message ?? ex),
                },
              });
            }
          }
        );
      return;
    }

    const pending = hasId && this._pending.get(message.id);
    if (!pending) {
      return;
    }
    this._pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message ?? "request failed");
      error.code = message.error.code;
      error.data = message.error.data;
      pending.reject(error);
    } else {
      pending.resolve(message.result ?? {});
    }
  }
}

/**
 * The PATH to start dsh with: node's own folder first, so a `dsh` that is a
 * script starting with `#!/usr/bin/env node` finds it, then the usual places
 * for the commands the agent may run, then whatever Thunderbird was given.
 *
 * @param {string} node
 * @returns {string}
 */
function pathFor(node) {
  const dirs = [
    PathUtils.parent(node),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(Services.env.get("PATH") || "/usr/bin:/bin:/usr/sbin:/sbin").split(":"),
  ];
  return [...new Set(dirs.filter(Boolean))].join(":");
}

/**
 * One run of dsh, with one session in it.
 */
export class DshAgent {
  /**
   * @param {object} handlers
   * @param {function(object)} [handlers.onUpdate] - Each session/update's
   *   `update`: messages, thoughts, tool calls and config changes.
   * @param {function(object): Promise<?string>} [handlers.onPermission] -
   *   Given a permission request, resolves to the chosen option's id, or
   *   null to cancel it.
   * @param {function({exitCode: number, stderr: string})} [handlers.onExit] -
   *   The process ended by itself. Not called for stop().
   */
  constructor(handlers = {}) {
    this._handlers = handlers;
    this._process = null;
    this._connection = null;
    this._token = null;
    this._stderr = "";
    /** Settles once dsh's error output has been read to its end. */
    this._stderrRead = Promise.resolve();
    this._stopping = false;
    /** @type {?string} */
    this.sessionId = null;
    /** @type {object[]} As ACP describes them: the model, and so on. */
    this.configOptions = [];
  }

  /** @returns {boolean} */
  get running() {
    return Boolean(this._process) && !this._stopping;
  }

  /**
   * Start dsh and open a session in it. On failure everything started is
   * stopped again before the error is thrown.
   */
  async start() {
    const settings = await DshSettings.get();
    if (!settings.node || !(await IOUtils.exists(settings.node))) {
      throw new DshError(
        "no-node",
        settings.node
          ? `node was not found at ${settings.node}`
          : "node was not found; set where it is"
      );
    }
    if (!settings.dsh || !(await IOUtils.exists(settings.dsh))) {
      throw new DshError(
        "no-dsh",
        settings.dsh
          ? `dsh was not found at ${settings.dsh}`
          : "dsh was not found; install it, or set where it is"
      );
    }
    const port = lazy.MailMcpServer.start();
    if (port < 0) {
      throw new DshError(
        "mail-access-off",
        "mail access for AI is turned off (Tools > Mail Access for AI)"
      );
    }

    try {
      await IOUtils.makeDirectory(settings.workspace, {
        createAncestors: true,
        ignoreExisting: true,
      });
      this._token = lazy.MailMcpTokens.createEphemeral();

      const patch = PathUtils.join(
        PathUtils.profileDir,
        "dsh-thunderbird.patch.yml"
      );
      await IOUtils.writeUTF8(patch, PERSONA_PATCH);

      // dsh's own entry point is a script for node to run; an installed
      // `dsh` is a program in its own right.
      const isScript = /\.[cm]?js$/.test(settings.dsh);
      stopAtShutdown();
      runningAgents.add(this);
      this._process = await lazy.Subprocess.call({
        command: isScript ? settings.node : settings.dsh,
        arguments: [
          ...(isScript ? [settings.dsh] : []),
          "--profile",
          "acp",
          "--patch",
          patch,
        ],
        environment: { PATH: pathFor(settings.node) },
        environmentAppend: true,
        workdir: settings.workspace,
        stderr: "pipe",
      });

      this._connection = new AcpConnection(
        line => this._process?.stdin.write(line),
        {
          onNotification: (method, params) => {
            if (
              method == "session/update" &&
              params?.sessionId == this.sessionId
            ) {
              this._onUpdate(params.update);
            }
          },
          onRequest: (method, params) => this._onRequest(method, params),
        }
      );
      this._pump();

      await this._connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "thunderbird", version: Services.appinfo.version },
      });
      const session = await this._connection.request("session/new", {
        cwd: settings.workspace,
        mcpServers: [
          {
            type: "http",
            name: "thunderbird",
            url: `http://127.0.0.1:${port}/mcp`,
            headers: [
              { name: "Authorization", value: `Bearer ${this._token}` },
            ],
          },
        ],
      });
      this.sessionId = session.sessionId;
      this.configOptions = session.configOptions ?? [];
      await DshSessions.remember(this.sessionId, settings.workspace);
    } catch (ex) {
      await this.stop();
      // What dsh said on the way down is usually the actual reason, and the
      // last of it is only certain to have been read once it has exited.
      await this._stderrRead;
      throw new DshError(
        "failed",
        [ex.message, this._stderr.trim().split("\n").slice(-5).join("\n")]
          .filter(Boolean)
          .join("\n")
      );
    }
  }

  /**
   * Send a prompt and wait for the turn to end. What happens meanwhile
   * arrives through onUpdate.
   *
   * @param {object[]} blocks - ACP content blocks: text, resource links.
   * @returns {Promise<string>} Why the turn ended, e.g. "end_turn".
   */
  async prompt(blocks) {
    const result = await this._connection.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: blocks,
    });
    return result.stopReason;
  }

  /** Ask the agent to stop what it is doing; the prompt then settles. */
  cancel() {
    this._connection?.notify("session/cancel", { sessionId: this.sessionId });
  }

  /**
   * @param {string} configId - e.g. "model".
   * @param {string} value
   * @returns {Promise<object[]>} The options as they now are.
   */
  async setConfigOption(configId, value) {
    const result = await this._connection.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId,
      value,
    });
    this.configOptions = result.configOptions ?? this.configOptions;
    return this.configOptions;
  }

  /**
   * Close the session and end the process. Safe to call at any point, and
   * more than once.
   */
  async stop() {
    if (this._stopping) {
      return;
    }
    this._stopping = true;
    const process = this._process;
    const connection = this._connection;

    if (connection && this.sessionId) {
      // Closing lets dsh save the session; it is not worth waiting long for.
      let timer;
      await Promise.race([
        connection
          .request("session/close", { sessionId: this.sessionId })
          .catch(() => {}),
        new Promise(resolve => {
          timer = lazy.setTimeout(resolve, CLOSE_TIMEOUT_MS);
        }),
      ]);
      lazy.clearTimeout(timer);
    }
    connection?.close(new DshError("failed", "dsh was stopped"));
    if (process) {
      try {
        await process.stdin.close();
      } catch (ex) {
        // Already closed.
      }
      await process.kill(CLOSE_TIMEOUT_MS).catch(() => {});
    }
    if (this._token) {
      lazy.MailMcpTokens.revokeEphemeral(this._token);
      this._token = null;
    }
    runningAgents.delete(this);
    this._process = null;
    this._connection = null;
    this.sessionId = null;
  }

  _onUpdate(update) {
    if (update?.sessionUpdate == "config_option_update") {
      this.configOptions = update.configOptions ?? this.configOptions;
    }
    this._handlers.onUpdate?.(update);
  }

  async _onRequest(method, params) {
    if (method == "session/request_permission") {
      const optionId = await this._handlers.onPermission?.(params);
      return optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    const error = new Error(`not supported: ${method}`);
    error.code = -32601;
    throw error;
  }

  /** Read both output streams until they end, and notice the exit. */
  _pump() {
    const process = this._process;
    const connection = this._connection;
    (async () => {
      let text;
      while ((text = await process.stdout.readString())) {
        connection.receive(text);
      }
    })().catch(() => {});
    // Read even though only the tail is kept: a pipe nobody empties fills
    // up, and the program writing to it stops dead. Bounded, because a
    // child of dsh's that outlives it can hold the pipe open.
    const stderrEnded = (async () => {
      let text;
      while ((text = await process.stderr.readString())) {
        this._stderr = (this._stderr + text).slice(-STDERR_KEEP);
      }
    })().catch(() => {});
    // wait() rejects for a process that has already been reaped -- one
    // stopped from two directions at once -- and that is an exit too.
    const exited = process.wait().catch(() => ({ exitCode: -1 }));
    this._stderrRead = exited.then(() =>
      Promise.race([
        stderrEnded,
        new Promise(resolve => lazy.setTimeout(resolve, CLOSE_TIMEOUT_MS)),
      ])
    );
    exited.then(async ({ exitCode }) => {
      connection.close(new DshError("failed", "dsh has stopped"));
      if (this._stopping || this._process != process) {
        return;
      }
      await this.stop();
      await this._stderrRead;
      this._handlers.onExit?.({ exitCode, stderr: this._stderr });
    });
  }
}
