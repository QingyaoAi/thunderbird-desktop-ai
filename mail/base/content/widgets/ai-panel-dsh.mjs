/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The AI panel's dsh mode: DeepSeek Harness running as an agent, turned on
 * and off with a button in the panel's header.
 *
 * On is the default wherever there is a dsh to run: the panel opens with dsh
 * as what answers, and the button is how to go back to the panel's own model,
 * which is then remembered. On is not running, though. The program is started
 * by the first thing sent to it, or by the button, so a Thunderbird nobody
 * asks anything has no dsh process and leaves no empty session behind.
 *
 * While it is on, what is typed in the panel goes to dsh instead of to the
 * panel's own model, with the message that is open as where to begin, and the
 * transcript shows what dsh does as it does it -- its reasoning, each tool it
 * calls and what came back, and its answers. Starting and talking to the
 * program is DshAgent's job; this is the part that shows it.
 */

import {
  linkifyMessageMentions,
  MESSAGE_LINK_RE,
} from "chrome://messenger/content/ai-markdown.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  DshAgent: "resource:///modules/DshAgent.sys.mjs",
  DshSessions: "resource:///modules/DshAgent.sys.mjs",
  DshSettings: "resource:///modules/DshAgent.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
});

/** Tools dsh reaches through the mailbox's MCP server are named with this. */
const MAIL_TOOL_PREFIX = "mcp__thunderbird__";

/**
 * How long a subject must be to be linked where an answer names it without a
 * link. Shorter ones -- "Hi", "周报" -- turn up in ordinary prose too often to
 * be taken as naming a message.
 */
const MIN_MENTION_LENGTH = 6;

/** How much of a tool's input or result to show before cutting it short. */
const TOOL_TEXT_MAX = 2000;

/**
 * @param {string} text
 * @returns {string}
 */
function shorten(text) {
  return text.length > TOOL_TEXT_MAX
    ? `${text.slice(0, TOOL_TEXT_MAX)}…`
    : text;
}

/**
 * dsh mode, for one AI panel: the header's button and model picker, and what
 * goes into the transcript while dsh is on.
 */
export class DshPanel {
  /**
   * @param {object} panel - The AIPanel this is part of: its transcript,
   *   composer and helpers are shared.
   */
  constructor(panel) {
    this.panel = panel;
    /**
     * "off" is the panel's own model answering. In the other three dsh does:
     * "ready" before anything has been sent to it, when no program is running
     * yet, then "starting" and "on".
     *
     * @type {"off"|"ready"|"starting"|"on"}
     */
    this.state = "off";
    /** @type {?DshAgent} */
    this.agent = null;
    /** @type {?Promise<void>} The latest start, settled once it is over. */
    this._starting = null;
    this._prompting = false;
    /** The assistant turn being written into, while a prompt runs. */
    this._turn = null;
    /** @type {Set<Function>} Permission prompts waiting on an answer. */
    this._waiting = new Set();
    this._allowAll = false;
    /**
     * Subject to URI, for every message the mail tools have returned this
     * session: what an answer's mentions of them are linked to.
     *
     * @type {Map<string, string>}
     */
    this._mentions = new Map();

    this.toggleButton = document.getElementById("ai-panel-dsh");
    this.settingsButton = document.getElementById("ai-panel-dsh-settings");
    this.modelPicker = document.getElementById("ai-panel-dsh-model");

    this.toggleButton.addEventListener("click", () => this.toggle());
    this.settingsButton.addEventListener("click", () => this.editSettings());
    this.modelPicker.addEventListener("change", () => this._changeModel());
    // Closing the mail tab or window is turning it off.
    window.addEventListener("unload", () => this.agent?.stop(), { once: true });
  }

  /** @returns {boolean} Whether what is typed goes to dsh. */
  get active() {
    return this.state != "off";
  }

  /** @returns {boolean} */
  get busy() {
    return this._prompting;
  }

  /**
   * Begin the way the panel was left: with dsh answering, unless its button
   * turned it off or there is no dsh to run. Nothing is started.
   */
  async restore() {
    if (this.state == "starting" || this.state == "on") {
      return;
    }
    this._setState(
      (await lazy.DshSettings.answersByDefault()) ? "ready" : "off"
    );
  }

  /** The button. What it leaves dsh as is what the panel next opens with. */
  async toggle() {
    if (this.state == "off") {
      await this.start();
      if (this.state != "off") {
        lazy.DshSettings.leftOn(true);
      }
    } else {
      lazy.DshSettings.leftOn(false);
      await this.stop();
    }
  }

  /**
   * Start dsh, unless it is running. If it cannot be started the panel says
   * why and goes back to what it was: off, where the button asked for it.
   *
   * @returns {Promise<void>} Settles once dsh is on, or has failed to be.
   */
  start() {
    if (this.state == "on") {
      return Promise.resolve();
    }
    if (this.state != "starting") {
      this._starting = this._start();
    }
    return this._starting;
  }

  async _start() {
    const before = this.state;
    this._setState("starting");
    const notice = this._note("ai-panel-dsh-starting");

    const agent = new lazy.DshAgent({
      onUpdate: update => this._onUpdate(update),
      onPermission: request => this._askPermission(request),
      onExit: info => this._onExit(agent, info),
    });
    try {
      await agent.start();
    } catch (ex) {
      notice.remove();
      if (this.state == "starting") {
        this._setState(before);
        this._showFailure(ex);
      }
      return;
    }
    notice.remove();
    if (this.state != "starting") {
      // Turned off again while it was starting.
      agent.stop();
      return;
    }

    this.agent = agent;
    this._allowAll = false;
    this._mentions = new Map();
    this._setState("on");
    this._fillModelPicker();
    const { workspace } = await lazy.DshSettings.get();
    this._note("ai-panel-dsh-on", { folder: workspace });
    this.panel.input.focus();
  }

  async stop() {
    if (this.state == "off") {
      return;
    }
    const agent = this.agent;
    this.agent = null;
    this._setState("off");
    this._answerWaiting(null);
    this._endPrompt();
    this._note("ai-panel-dsh-off");
    await agent?.stop();
  }

  /**
   * Begin a new conversation: a new session in a new run, since a session's
   * context cannot be emptied from outside it.
   */
  async restart() {
    if (this.state != "on") {
      return;
    }
    const agent = this.agent;
    this.agent = null;
    this._answerWaiting(null);
    this._endPrompt();
    this._setState("ready");
    await agent?.stop();
    await this.start();
  }

  /** Ask dsh to stop what it is doing. The prompt then settles by itself. */
  cancel() {
    this._answerWaiting(null);
    if (this._prompting && !this.agent) {
      // Still being started for this prompt, so there is nobody to tell:
      // the prompt is dropped here, and send() finds it gone.
      this.panel.transcript.appendChild(this.panel._notice("ai-panel-stopped"));
      this._endPrompt();
      return;
    }
    this.agent?.cancel();
  }

  /**
   * Send what was typed, with the message that is open, if there is one, as
   * a link dsh can read with its mail tools. The first thing sent is what
   * starts dsh.
   *
   * @param {string} text
   */
  async send(text) {
    if (this.state == "off" || this._prompting) {
      return;
    }
    const panel = this.panel;
    panel.input.value = "";
    panel._addTurn("user").textContent = text;

    // What is open as this is asked, not once dsh has started.
    const blocks = [{ type: "text", text }];
    const openMessage = this._openMessageLink();
    if (openMessage) {
      blocks.push(openMessage);
    }

    const turn = {
      body: null,
      thinking: null,
      answer: null,
      answerId: null,
      answerRaw: "",
      tools: new Map(),
    };
    this._turn = turn;
    this._prompting = true;
    panel._setBusy(true);
    try {
      await this.start();
      if (this._turn != turn || this.state != "on") {
        // It could not be started, which start() has said, or this was
        // stopped while it was.
        return;
      }
      // Made only now, so that it comes after the notices starting left.
      turn.body = panel._addTurn("assistant");
      const agent = this.agent;
      try {
        const stopReason = await agent.prompt(blocks);
        if (stopReason == "cancelled") {
          turn.body.appendChild(panel._notice("ai-panel-stopped"));
        } else if (stopReason && stopReason != "end_turn") {
          turn.body.appendChild(
            this._noticeWith("ai-panel-dsh-stopped-early", {
              reason: stopReason,
            })
          );
        }
      } catch (ex) {
        // A run that died is explained by _onExit; anything else is shown
        // here.
        if (this.agent == agent && this._turn == turn) {
          turn.body.appendChild(this._error(ex.message));
        }
      }
    } finally {
      // A turn ended from elsewhere -- dsh stopped or turned off -- may have
      // been followed by another by now, which is not this one's to end.
      if (this._turn == turn) {
        this._endPrompt();
      }
    }
  }

  /**
   * The message open in the mail tab, as a link to send with a prompt. Its
   * URI is its id for the mail tools, and the name says what it is --
   * subject, sender and date, as the tools give them -- so that dsh can tell
   * whether a request is about it before reading it. dsh's persona, in
   * DshAgent, tells it to begin there.
   *
   * @returns {?object} An ACP resource_link block, or null with none open.
   */
  _openMessageLink() {
    const hdr = this.panel._replyTarget();
    if (!hdr) {
      return null;
    }
    const date = new Date(hdr.date / 1000).toISOString();
    return {
      type: "resource_link",
      uri: hdr.folder.getUriForMsg(hdr),
      name:
        `the message open in Thunderbird: "${hdr.mime2DecodedSubject}", ` +
        `from ${hdr.mime2DecodedAuthor}, ${date}`,
    };
  }

  // -- settings --------------------------------------------------------------

  /**
   * Show the settings and change one of them. Built from the stock prompts
   * and file pickers rather than a dialog of its own: there are three paths
   * to choose, and a picker is the right way to choose each.
   */
  async editSettings() {
    const settings = await lazy.DshSettings.get();
    const sessions = await lazy.DshSessions.list();
    const l10n = document.l10n;
    const unset = await l10n.formatValue("ai-panel-dsh-settings-unset");
    const [title, text, node, dsh, workspace, reset, clearSessions] =
      await l10n.formatValues([
        { id: "ai-panel-dsh-settings-title" },
        { id: "ai-panel-dsh-settings-text" },
        {
          id: "ai-panel-dsh-settings-node",
          args: { path: settings.node || unset },
        },
        {
          id: "ai-panel-dsh-settings-dsh",
          args: { path: settings.dsh || unset },
        },
        {
          id: "ai-panel-dsh-settings-workspace",
          args: { path: settings.workspace },
        },
        { id: "ai-panel-dsh-settings-reset" },
        {
          id: "ai-panel-dsh-settings-clear-sessions",
          args: { count: sessions.length },
        },
      ]);

    const chosen = { value: 0 };
    if (
      !Services.prompt.select(
        window,
        title,
        text,
        [node, dsh, workspace, reset, clearSessions],
        chosen
      )
    ) {
      return;
    }

    if (chosen.value == 4) {
      await this.clearSessions();
      return;
    }
    const keys = ["node", "dsh", "workspace"];
    if (chosen.value == 3) {
      for (const key of keys) {
        lazy.DshSettings.set(key, "");
      }
    } else {
      const key = keys[chosen.value];
      const path = await this._pick(key, settings[key]);
      if (!path) {
        return;
      }
      lazy.DshSettings.set(key, path);
    }
    // Only a dsh that is running has the old ones; one not yet started will
    // be started with these.
    if (this.state == "starting" || this.state == "on") {
      this._note("ai-panel-dsh-restart");
    }
  }

  /**
   * Delete the sessions Thunderbird started in dsh, after asking. The one in
   * use, if dsh is on, is kept: dsh has it open.
   */
  async clearSessions() {
    const keep = this.agent?.sessionId ? [this.agent.sessionId] : [];
    const count = (await lazy.DshSessions.list()).filter(
      session => !keep.includes(session.id)
    ).length;
    const [title, question, none] = await document.l10n.formatValues([
      { id: "ai-panel-dsh-settings-title" },
      {
        id: keep.length
          ? "ai-panel-dsh-clear-sessions-confirm-keeping"
          : "ai-panel-dsh-clear-sessions-confirm",
        args: { count },
      },
      { id: "ai-panel-dsh-clear-sessions-none" },
    ]);
    if (!count) {
      Services.prompt.alert(window, title, none);
      return;
    }
    if (!Services.prompt.confirm(window, title, question)) {
      return;
    }
    try {
      const deleted = await lazy.DshSessions.clear(keep);
      this._note("ai-panel-dsh-clear-sessions-done", { count: deleted });
    } catch (ex) {
      this.panel.transcript.appendChild(this._error(ex.message));
    }
  }

  /**
   * @param {"node"|"dsh"|"workspace"} key
   * @param {string} current
   * @returns {Promise<?string>} The chosen path, or null if cancelled.
   */
  async _pick(key, current) {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    const title = await document.l10n.formatValue(`ai-panel-dsh-pick-${key}`);
    picker.init(
      window.browsingContext,
      title,
      key == "workspace"
        ? Ci.nsIFilePicker.modeGetFolder
        : Ci.nsIFilePicker.modeOpen
    );
    try {
      if (current) {
        const start = key == "workspace" ? current : PathUtils.parent(current);
        if (start && (await IOUtils.exists(start))) {
          picker.displayDirectory = new lazy.FileUtils.File(start);
        }
      }
    } catch (ex) {
      // Wherever the picker opens by default will do.
    }
    const result = await new Promise(resolve => picker.open(resolve));
    return result == Ci.nsIFilePicker.returnOK ? picker.file.path : null;
  }

  // -- what dsh says and does ------------------------------------------------

  _onUpdate(update) {
    if (update?.sessionUpdate == "config_option_update") {
      this._fillModelPicker();
      return;
    }
    const turn = this._turn;
    if (!turn?.body) {
      return;
    }
    const follow = this.panel._isAtEnd();

    switch (update.sessionUpdate) {
      case "agent_thought_chunk": {
        if (update.content?.type != "text") {
          break;
        }
        turn.thinking ??= this.panel._addThinking(turn.body);
        turn.thinking.text.textContent += update.content.text;
        break;
      }

      case "agent_message_chunk": {
        if (update.content?.type != "text") {
          break;
        }
        this._foldThinking();
        // One message arrives whole; a later one after a tool call gets a
        // block of its own, so the transcript reads in the order things
        // happened.
        if (!turn.answer || update.messageId != turn.answerId) {
          turn.answer = document.createElement("div");
          turn.answer.className = "ai-answer";
          turn.body.appendChild(turn.answer);
          turn.answerId = update.messageId;
          turn.answerRaw = "";
        }
        turn.answerRaw += update.content.text;
        this.panel._renderAnswer(turn.answer, turn.answerRaw, []);
        linkifyMessageMentions(turn.answer, document, this._mentions);
        break;
      }

      case "tool_call": {
        this._foldThinking();
        turn.answer = null;
        turn.tools.set(update.toolCallId, this._addTool(turn.body, update));
        break;
      }

      case "tool_call_update": {
        const tool = turn.tools.get(update.toolCallId);
        if (tool) {
          this._updateTool(tool, update);
        }
        break;
      }
    }

    if (follow) {
      this.panel._scrollToEnd();
    }
  }

  _foldThinking() {
    const thinking = this._turn?.thinking;
    if (thinking) {
      thinking.details.open = false;
      thinking.details.classList.add("ai-thinking-done");
      this._turn.thinking = null;
    }
  }

  /**
   * @param {HTMLElement} container
   * @param {object} call - A tool_call update.
   * @returns {{details: HTMLElement, name: HTMLElement, output: HTMLElement}}
   */
  _addTool(container, call) {
    const details = document.createElement("details");
    details.className = "ai-dsh-tool";
    details.dataset.status = call.status ?? "in_progress";

    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.className = "ai-dsh-tool-name";
    const title = String(call.title ?? "tool");
    label.textContent = title.startsWith(MAIL_TOOL_PREFIX)
      ? title.slice(MAIL_TOOL_PREFIX.length)
      : title;
    summary.appendChild(label);
    details.appendChild(summary);

    if (call.rawInput !== undefined) {
      const input = document.createElement("pre");
      input.className = "ai-dsh-tool-input";
      input.textContent = shorten(
        typeof call.rawInput == "string"
          ? call.rawInput
          : JSON.stringify(call.rawInput, null, 2)
      );
      details.appendChild(input);
    }
    const output = document.createElement("pre");
    output.className = "ai-dsh-tool-output";
    output.hidden = true;
    details.appendChild(output);

    container.appendChild(details);
    return {
      details,
      name: label,
      output,
      mail: title.startsWith(MAIL_TOOL_PREFIX),
    };
  }

  _updateTool(tool, update) {
    if (update.status) {
      tool.details.dataset.status = update.status;
    }
    const text = (update.content ?? [])
      .map(item => (item.content?.type == "text" ? item.content.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) {
      tool.output.textContent = shorten(text);
      tool.output.hidden = false;
      if (tool.mail) {
        this._rememberMessages(text);
      }
    }
  }

  /**
   * Note the subject and id of each message a mail tool returned, so that an
   * answer naming one without a link can still be given one.
   *
   * @param {string} text - The tool's result, which for the mail tools is
   *   JSON: one message, or lists of them.
   */
  _rememberMessages(text) {
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      return;
    }
    const visit = (value, depth) => {
      if (!value || typeof value != "object" || depth > 4) {
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(item => visit(item, depth + 1));
        return;
      }
      const subject =
        typeof value.subject == "string" ? value.subject.trim() : "";
      if (
        subject.length >= MIN_MENTION_LENGTH &&
        typeof value.id == "string" &&
        MESSAGE_LINK_RE.test(value.id)
      ) {
        this._mentions.set(subject, value.id);
      }
      for (const child of Object.values(value)) {
        visit(child, depth + 1);
      }
    };
    visit(result, 0);
  }

  /**
   * Ask whether dsh may go ahead with a tool call.
   *
   * @param {object} request - session/request_permission's params.
   * @returns {Promise<?string>} The chosen option's id, or null.
   */
  async _askPermission(request) {
    const allow = request.options?.find(o => o.kind?.startsWith("allow"));
    if (this._allowAll && allow) {
      return allow.optionId;
    }
    const container = this._turn?.body ?? this.panel.transcript;
    const tool = this._turn?.tools.get(request.toolCall?.toolCallId);

    const box = document.createElement("div");
    box.className = "ai-dsh-permission";
    const question = document.createElement("p");
    document.l10n.setAttributes(question, "ai-panel-dsh-permission", {
      tool:
        tool?.name.textContent ??
        request.toolCall?.title ??
        request.toolCall?.toolCallId ??
        "",
    });
    box.appendChild(question);
    const buttons = document.createElement("div");
    buttons.className = "ai-dsh-permission-buttons";
    box.appendChild(buttons);
    container.appendChild(box);
    this.panel._scrollToEnd();

    return new Promise(resolve => {
      const answer = (optionId, outcomeId) => {
        this._waiting.delete(settle);
        buttons.remove();
        const outcome = document.createElement("p");
        outcome.className = "ai-dsh-permission-outcome";
        document.l10n.setAttributes(outcome, outcomeId);
        box.appendChild(outcome);
        resolve(optionId);
      };
      const settle = optionId =>
        answer(optionId, "ai-panel-dsh-permission-cancelled");
      this._waiting.add(settle);

      for (const option of request.options ?? []) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ai-panel-action";
        button.textContent = option.name;
        button.addEventListener("click", () =>
          answer(
            option.optionId,
            option.kind?.startsWith("allow")
              ? "ai-panel-dsh-allowed"
              : "ai-panel-dsh-rejected"
          )
        );
        buttons.appendChild(button);
      }
      if (allow) {
        const always = document.createElement("button");
        always.type = "button";
        always.className = "ai-panel-action";
        document.l10n.setAttributes(always, "ai-panel-dsh-allow-all");
        always.addEventListener("click", () => {
          this._allowAll = true;
          answer(allow.optionId, "ai-panel-dsh-allowed");
        });
        buttons.appendChild(always);
      }
    });
  }

  /**
   * Settle every permission prompt still waiting, with the same answer.
   *
   * @param {?string} optionId
   */
  _answerWaiting(optionId) {
    for (const settle of [...this._waiting]) {
      settle(optionId);
    }
  }

  _onExit(agent, { exitCode, stderr }) {
    if (this.agent != agent) {
      return;
    }
    this.agent = null;
    this._answerWaiting(null);
    this._endPrompt();
    // Still what answers: the next thing sent starts it again.
    this._setState("ready");
    const notice = this._noticeWith("ai-panel-dsh-exited", { code: exitCode });
    notice.classList.add("ai-error");
    this.panel.transcript.appendChild(notice);
    const detail = stderr?.trim().split("\n").slice(-8).join("\n");
    if (detail) {
      const pre = document.createElement("pre");
      pre.className = "ai-dsh-stderr";
      pre.textContent = detail;
      this.panel.transcript.appendChild(pre);
    }
    this.panel._scrollToEnd();
  }

  // -- the header ------------------------------------------------------------

  _setState(state) {
    this.state = state;
    this.toggleButton.setAttribute("aria-pressed", state != "off");
    this.toggleButton.classList.toggle("starting", state == "starting");
    // The panel's own model picker means nothing while dsh answers, and
    // dsh's own means nothing while it does not.
    this.panel.modelPicker.hidden = state != "off";
    this.modelPicker.hidden = state != "on";
    this.panel.refreshConfigured();
    this.panel.updateDraftButton();
  }

  _endPrompt() {
    if (!this._prompting) {
      return;
    }
    this._prompting = false;
    this._foldThinking();
    this._turn = null;
    this.panel._setBusy(false);
    this.panel.input.focus();
  }

  _fillModelPicker() {
    const option = this.agent?.configOptions.find(o => o.id == "model");
    this.modelPicker.replaceChildren();
    if (!option) {
      this.modelPicker.hidden = true;
      return;
    }
    const add = (list, choice) => {
      const element = document.createElement("option");
      element.value = choice.value;
      element.textContent = choice.name;
      list.appendChild(element);
    };
    for (const entry of option.options ?? []) {
      if (Array.isArray(entry.options)) {
        const group = document.createElement("optgroup");
        group.label = entry.name;
        entry.options.forEach(choice => add(group, choice));
        this.modelPicker.appendChild(group);
      } else {
        add(this.modelPicker, entry);
      }
    }
    this.modelPicker.value = option.currentValue;
    this.modelPicker.hidden = this.state != "on";
  }

  async _changeModel() {
    const agent = this.agent;
    if (!agent) {
      return;
    }
    try {
      await agent.setConfigOption("model", this.modelPicker.value);
    } catch (ex) {
      this.panel.transcript.appendChild(this._error(ex.message));
    }
    this._fillModelPicker();
  }

  // -- notices ---------------------------------------------------------------

  /**
   * Add a notice to the transcript.
   *
   * @param {string} l10nId
   * @param {object} [args]
   * @returns {HTMLElement}
   */
  _note(l10nId, args) {
    const notice = this._noticeWith(l10nId, args);
    this.panel.transcript.appendChild(notice);
    this.panel._scrollToEnd();
    return notice;
  }

  _noticeWith(l10nId, args) {
    const notice = document.createElement("div");
    notice.className = "ai-notice";
    document.l10n.setAttributes(notice, l10nId, args);
    return notice;
  }

  _error(text) {
    const error = document.createElement("div");
    error.className = "ai-error";
    error.textContent = text;
    return error;
  }

  /**
   * Say why dsh did not start, with the way to fix it when there is one.
   *
   * @param {Error} ex
   */
  _showFailure(ex) {
    const box = document.createElement("div");
    box.className = "ai-error";
    const heading = document.createElement("div");
    document.l10n.setAttributes(heading, "ai-panel-dsh-failed");
    const detail = document.createElement("pre");
    detail.className = "ai-dsh-stderr";
    detail.textContent = ex.message;
    box.append(heading, detail);
    if (ex.code == "no-node" || ex.code == "no-dsh") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ai-panel-action";
      document.l10n.setAttributes(button, "ai-panel-dsh-settings-open");
      button.addEventListener("click", () => this.editSettings());
      box.appendChild(button);
    }
    this.panel.transcript.appendChild(box);
    this.panel._scrollToEnd();
  }
}
