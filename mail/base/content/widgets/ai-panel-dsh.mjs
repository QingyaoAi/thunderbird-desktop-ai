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
 *
 * Each conversation in the panel is a session of dsh's. A new conversation is
 * a new session, and carrying on an earlier one reopens the session it was
 * answered in, so dsh remembers it. What dsh showed is recorded with the
 * conversation as it arrives, since dsh gives none of it back on reopening.
 *
 * A conversation left while dsh is answering in it goes on being answered,
 * out of sight: its run is kept, with what the transcript showed, and both
 * are given back if it is opened again before dsh is done. Once dsh is done
 * the run is stopped, and the conversation is opened from what was kept, as
 * any other is. The list of conversations says which are still being
 * answered, and which wait for a permission.
 */

import {
  linkifyMessageMentions,
  MESSAGE_LINK_RE,
} from "chrome://messenger/content/ai-markdown.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIConversations: "resource:///modules/AIConversations.sys.mjs",
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
 * How many conversations dsh may go on answering out of sight at once. Each
 * is a run of its own -- a node process, and the model's time -- going on
 * while nobody watches. One more left while dsh answers in it is stopped,
 * as every one was before they could go on.
 */
const MAX_OUT_OF_SIGHT = 2;

/**
 * How long, in seconds, dsh may sit idle in the conversation shown before it
 * is stopped. A run left going holds a node process for as long as the panel
 * is open -- days, for a panel nobody closes. The next thing asked starts it
 * again in the same session, which takes about a second. 0 is never.
 */
const IDLE_PREF = "mail.ai.dsh.idleSeconds";
const IDLE_DEFAULT = 600;

/**
 * How long, in seconds, dsh answering out of sight may wait on a permission
 * before it is stopped, rather than holding its process until the
 * conversation is opened again, which may be never. 0 is for ever.
 */
const UNANSWERED_PREF = "mail.ai.dsh.unansweredSeconds";
const UNANSWERED_DEFAULT = 1800;

/**
 * dsh in one conversation: the run started for it, and the prompt running in
 * it, if one is. The panel shows one of these; any others are answering in
 * conversations left while they did (see DshPanel.leave).
 */
class DshRun {
  constructor() {
    /** @type {?DshAgent} */
    this.agent = null;
    /** @type {?object} The conversation, once something is asked in it. */
    this.conversation = null;
    /** The assistant turn being written into, while a prompt runs. */
    this.turn = null;
    /** @type {Set<Function>} Permission prompts waiting on an answer. */
    this.waiting = new Set();
    /** Whether "allow all" was chosen: for this run, and no other. */
    this.allowAll = false;
    /**
     * @type {?DocumentFragment} What the transcript showed, while it is out
     *   of sight. dsh goes on writing into it.
     */
    this.hidden = null;
    /** Set while it waits out of sight on a permission: see _watchWaiting. */
    this.waitTimer = null;
  }
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
     * yet, then "starting" and "on". All of this is the conversation shown's.
     *
     * @type {"off"|"ready"|"starting"|"on"}
     */
    this.state = "off";
    /** @type {DshRun} The conversation shown's. */
    this.run = new DshRun();
    /**
     * @type {Map<string, DshRun>} Those answering out of sight, by the id of
     *   their conversation.
     */
    this._background = new Map();
    /**
     * @type {Map<string, Promise<void>>} The runs that answered out of sight
     *   and are being stopped, by session id: dsh will not reopen a session
     *   another run of it still has open.
     */
    this._closing = new Map();
    /**
     * Whether the conversation last left was being answered, but could not
     * go on out of sight because as many already were: restart() says so.
     */
    this._tooMany = false;
    /** @type {?Promise<void>} The latest start, settled once it is over. */
    this._starting = null;
    /** Set while dsh sits idle in the conversation shown: see _watchIdle. */
    this._idleTimer = null;
    /**
     * @type {?string} The model chosen when dsh was stopped for sitting idle,
     *   to be chosen again when it next starts. dsh keeps the choice only in
     *   the run, and a reopened session may come back with another.
     */
    this._pendingModel = null;
    /**
     * Whether dsh was stopped for sitting idle, so that starting it again
     * need not say that it is on: as far as anyone can tell, it never went.
     */
    this._quietStart = false;

    this.toggleButton = document.getElementById("ai-panel-dsh");
    this.settingsButton = document.getElementById("ai-panel-dsh-settings");
    this.modelPicker = document.getElementById("ai-panel-dsh-model");

    this.toggleButton.addEventListener("click", () => this.toggle());
    this.settingsButton.addEventListener("click", () => this.editSettings());
    this.modelPicker.addEventListener("change", () => this._changeModel());
    // Closing the mail tab or window is turning it off.
    window.addEventListener("unload", () => this._unload(), { once: true });
  }

  /** @returns {?DshAgent} The run of dsh in the conversation shown. */
  get agent() {
    return this.run.agent;
  }

  /** @returns {boolean} Whether what is typed goes to dsh. */
  get active() {
    return this.state != "off";
  }

  /** @returns {boolean} Whether dsh is answering in the conversation shown. */
  get busy() {
    return Boolean(this.run.turn);
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
    const run = this.run;
    this._setState("starting");
    const notice = this._note("ai-panel-dsh-starting");

    const agent = new lazy.DshAgent({
      onUpdate: update => this._onUpdate(run, update),
      onPermission: request => this._askPermission(run, request),
      onExit: info => this._onExit(run, agent, info),
    });
    // The session the conversation shown was answered in, if it was.
    const resume = this.panel.conversation?.dsh;
    try {
      // Answered in out of sight, perhaps, by a run that is still closing.
      await this._closing.get(resume?.sessionId);
      await agent.start({ resume });
    } catch (ex) {
      notice.remove();
      if (this.state == "starting") {
        this._setState(before);
        this._showFailure(ex);
      }
      return;
    }
    // Started again after sitting idle: with the model it had, before
    // anything is asked of it.
    const chosen = this._pendingModel;
    if (chosen && this._modelOf(agent) != chosen) {
      await agent
        .setConfigOption("model", chosen)
        .catch(ex => console.error("dsh: could not choose the model:", ex));
    }
    notice.remove();
    if (this.state != "starting") {
      // Turned off again while it was starting.
      agent.stop();
      return;
    }

    run.agent = agent;
    run.allowAll = false;
    const quiet = this._quietStart;
    this._pendingModel = null;
    this._quietStart = false;
    this._setState("on");
    this._fillModelPicker();
    if (agent.resumeError) {
      this._note("ai-panel-dsh-resume-failed", { reason: agent.resumeError });
    }
    if (!quiet) {
      this._note(agent.resumed ? "ai-panel-dsh-resumed" : "ai-panel-dsh-on", {
        folder: agent.workspace,
      });
    }
    this.panel.input.focus();
  }

  /**
   * Turn dsh off: in every conversation, so those it was answering out of
   * sight are stopped too, and say so when opened again.
   */
  async stop() {
    if (this.state == "off") {
      return;
    }
    const run = this.run;
    const agent = run.agent;
    run.agent = null;
    this._forgetIdle();
    this._setState("off");
    this._answerWaiting(run, null);
    this._interruptPrompt(run);
    this._note("ai-panel-dsh-off");
    await Promise.all([
      this._retire(agent),
      ...[...this._background.values()].map(left => this._stopOutOfSight(left)),
    ]);
  }

  /**
   * The panel is about to show another conversation. If dsh is answering in
   * the one shown, it goes on answering out of sight, keeping what the
   * transcript shows to go on writing into, unless as many are already being
   * answered that way as may be. Nothing else is touched: restart() then
   * starts dsh for the conversation shown next.
   *
   * @returns {boolean} Whether dsh goes on answering; if not, what is
   *   answering is the panel's to stop.
   */
  leave() {
    const run = this.run;
    if (!run.turn || !run.agent || !run.conversation) {
      // Nothing being answered, or dsh still being started for it, with
      // nothing sent to it yet.
      return false;
    }
    if (this._background.size >= MAX_OUT_OF_SIGHT) {
      this._tooMany = true;
      return false;
    }
    run.hidden = document.createDocumentFragment();
    run.hidden.append(...this.panel.transcript.childNodes);
    this._background.set(run.conversation.id, run);
    // Kept as far as it has got: a conversation begun with this question is
    // in the list only once it is saved.
    this.panel._saveConversation(run.conversation);
    this.run = new DshRun();
    this.panel._setBusy(false);
    this._showOutOfSight();
    return true;
  }

  /**
   * @param {string} id - A conversation's.
   * @returns {?object} The conversation, if dsh is answering in it out of
   *   sight: the one to show, rather than what was last saved of it, which
   *   lacks what is being answered.
   */
  answering(id) {
    return this._background.get(id)?.conversation ?? null;
  }

  /**
   * What the transcript showed when a conversation was left, if dsh is still
   * answering in it, to be shown again in place of what was kept of it.
   * restart() then makes it the conversation shown's run.
   *
   * @param {?object} conversation
   * @returns {?DocumentFragment}
   */
  takeHidden(conversation) {
    const run = conversation && this._background.get(conversation.id);
    const hidden = run?.hidden ?? null;
    if (run) {
      run.hidden = null;
    }
    return hidden;
  }

  /**
   * @returns {Map<string, "answering"|"waiting">} The conversations dsh is
   *   answering out of sight, by id, and whether each waits for a permission.
   */
  outOfSight() {
    const states = new Map();
    for (const [id, run] of this._background) {
      states.set(id, run.waiting.size ? "waiting" : "answering");
    }
    return states;
  }

  /**
   * @returns {{keep: string[], keepSessions: string[]}} The conversations
   *   and dsh sessions in use here, which deleting the unused ones is to
   *   leave alone: the conversation shown and those answered out of sight,
   *   and the sessions runs of dsh have open, or are closing.
   */
  inUse() {
    const runs = [this.run, ...this._background.values()];
    return {
      keep: [
        this.panel.conversation?.id,
        ...runs.map(run => run.conversation?.id),
      ].filter(Boolean),
      keepSessions: [
        this.panel.conversation?.dsh?.sessionId,
        ...runs.map(run => run.agent?.sessionId),
        ...this._closing.keys(),
      ].filter(Boolean),
    };
  }

  /**
   * Stop dsh answering in a conversation out of sight, as one deleted must
   * be before its session is.
   *
   * @param {string} id - The conversation's.
   * @returns {Promise<void>} Settles once the run has stopped.
   */
  async stopAnswering(id) {
    const run = this._background.get(id);
    if (run) {
      await this._stopOutOfSight(run);
    }
  }

  /**
   * Go on with the conversation the panel now shows, new or earlier: dsh, if
   * it is running, is started again in that conversation's session, or in a
   * new one. A new run, since a session's context cannot be emptied or
   * swapped from outside it. One not yet running starts in the right session
   * when it is first asked something. A conversation dsh is answering out of
   * sight has a run already, which becomes the one shown.
   */
  async restart() {
    if (this.state == "starting") {
      await this._starting;
    }
    if (this.state == "off") {
      return;
    }
    // What was kept from a run stopped for sitting idle was the conversation
    // left's.
    this._forgetIdle();
    const shown = this.panel.conversation;
    const back = shown ? this._background.get(shown.id) : null;
    const wasOn = this.state == "on";
    const old = this.run;
    this._answerWaiting(old, null);
    this._interruptPrompt(old);
    const tooMany = this._tooMany;
    this._tooMany = false;

    if (back) {
      this._background.delete(shown.id);
      back.hidden = null;
      this.run = back;
      this._setState("on");
      this._fillModelPicker();
      this.panel._setBusy(true);
      this._showOutOfSight();
      await this._retire(old.agent);
      return;
    }
    if (!wasOn) {
      return;
    }
    this.run = new DshRun();
    this._setState("ready");
    await this._retire(old.agent);
    await this.start();
    if (tooMany) {
      this._note("ai-panel-dsh-too-many", { count: MAX_OUT_OF_SIGHT });
    }
  }

  /**
   * Stop a run that is being left. A session nothing was asked in is deleted
   * as well: it is in no conversation, so nothing could reopen it, and
   * beginning conversations without asking anything would otherwise leave
   * one behind each time.
   *
   * @param {?DshAgent} agent
   */
  async _retire(agent) {
    if (!agent) {
      return;
    }
    const unused = agent.prompted || agent.resumed ? null : agent.sessionId;
    await agent.stop();
    if (unused) {
      await lazy.DshSessions.remove([unused]).catch(console.error);
    }
  }

  /**
   * End the prompt running in a run, if one is, because dsh is being stopped
   * under it. What it showed is kept with its conversation, marked as
   * stopped.
   *
   * @param {DshRun} run
   * @param {object} [why] - The notice to mark it with.
   */
  _interruptPrompt(run, why = { type: "notice", id: "ai-panel-stopped" }) {
    if (run.turn) {
      this._recordPart(run.turn, why);
    }
    this._endPrompt(run);
  }

  /**
   * Stop a run answering out of sight.
   *
   * @param {DshRun} run
   * @param {object} [why] - The notice to mark its conversation with.
   * @returns {Promise<void>} Settles once it has stopped.
   */
  _stopOutOfSight(run, why) {
    const sessionId = run.agent?.sessionId;
    this._answerWaiting(run, null);
    // Which, out of sight, stops the run as well.
    this._interruptPrompt(run, why);
    return this._closing.get(sessionId) ?? Promise.resolve();
  }

  /**
   * Stop a run whose session may be reopened at any moment, noting it as
   * closing until it has: dsh will not reopen a session another run of it
   * still has open, so _start waits.
   *
   * @param {DshAgent} agent
   */
  _retireNoting(agent) {
    const sessionId = agent.sessionId;
    const closing = this._retire(agent).finally(() => {
      if (this._closing.get(sessionId) == closing) {
        this._closing.delete(sessionId);
      }
    });
    if (sessionId) {
      this._closing.set(sessionId, closing);
    }
  }

  // -- runs left going -------------------------------------------------------

  /**
   * @param {?DshAgent} agent
   * @returns {?string} The model it answers with.
   */
  _modelOf(agent) {
    return (
      agent?.configOptions.find(option => option.id == "model")?.currentValue ??
      null
    );
  }

  /**
   * Have dsh in the conversation shown stopped once it has sat idle for long
   * enough, or not, as it now is: idle is on, with nothing being answered.
   * Called whenever that may have changed.
   */
  _watchIdle() {
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
    const run = this.run;
    const agent = run.agent;
    const seconds = Services.prefs.getIntPref(IDLE_PREF, IDLE_DEFAULT);
    if (this.state != "on" || !agent || run.turn || seconds <= 0) {
      return;
    }
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (
        this.state == "on" &&
        this.run == run &&
        run.agent == agent &&
        !run.turn
      ) {
        this._stopIdle(run);
      }
    }, seconds * 1000);
  }

  /**
   * Stop dsh in the conversation shown, which has sat idle. It is still what
   * answers: the next thing asked starts it again, in the same session and
   * with the same model, without a word in the transcript about it.
   *
   * @param {DshRun} run
   */
  _stopIdle(run) {
    const agent = run.agent;
    run.agent = null;
    this._pendingModel = this._modelOf(agent);
    this._quietStart = true;
    this._setState("ready");
    this._retireNoting(agent);
  }

  /** Let go of what was kept from a run stopped for sitting idle. */
  _forgetIdle() {
    this._pendingModel = null;
    this._quietStart = false;
    this._showModelPicker();
  }

  /**
   * Have each run that waits out of sight on a permission stopped once it
   * has waited long enough, and no other. Called whenever what waits, or
   * what is out of sight, may have changed.
   */
  _watchWaiting() {
    const seconds = Services.prefs.getIntPref(
      UNANSWERED_PREF,
      UNANSWERED_DEFAULT
    );
    for (const run of [this.run, ...this._background.values()]) {
      const waits =
        run != this.run &&
        this._background.has(run.conversation?.id) &&
        run.waiting.size > 0 &&
        seconds > 0;
      if (!waits) {
        clearTimeout(run.waitTimer);
        run.waitTimer = null;
      } else if (!run.waitTimer) {
        run.waitTimer = setTimeout(() => {
          run.waitTimer = null;
          if (this._background.get(run.conversation?.id) == run) {
            this._stopOutOfSight(run, {
              type: "notice",
              id: "ai-panel-dsh-unanswered",
              args: { minutes: Math.max(1, Math.round(seconds / 60)) },
            });
          }
        }, seconds * 1000);
      }
    }
  }

  /**
   * The window is going: stop every run, keeping what each one answering
   * showed, as stopped. Here rather than once their prompts settle, which
   * may be after this window's code has stopped running.
   */
  _unload() {
    clearTimeout(this._idleTimer);
    for (const run of [this.run, ...this._background.values()]) {
      clearTimeout(run.waitTimer);
      const conversation = run.turn ? run.conversation : null;
      const agent = run.agent;
      this._interruptPrompt(run);
      this.panel._saveConversation(conversation);
      agent?.stop();
    }
  }

  /** Ask dsh to stop what it is doing. The prompt then settles by itself. */
  cancel() {
    const run = this.run;
    this._answerWaiting(run, null);
    if (run.turn && !run.agent) {
      // Still being started for this prompt, so there is nobody to tell:
      // the prompt is dropped here, and send() finds it gone.
      this.panel.transcript.appendChild(this.panel._notice("ai-panel-stopped"));
      this._endPrompt(run);
      return;
    }
    run.agent?.cancel();
  }

  /**
   * Send what was typed, with the message that is open, if there is one, as
   * a link dsh can read with its mail tools. The first thing sent is what
   * starts dsh.
   *
   * @param {string} text
   */
  async send(text) {
    const run = this.run;
    if (this.state == "off" || run.turn) {
      return;
    }
    const panel = this.panel;
    panel.input.value = "";
    panel._addTurn("user").textContent = text;
    const { conversation, answer } = panel._recordExchange(text, "dsh");
    run.conversation = conversation;

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
      /** Where what is shown is recorded, once there is an answer. */
      record: null,
      thinkingPart: null,
      answerPart: null,
      /**
       * Subject to URI, for every message the mail tools have returned in
       * the conversation: what an answer's mentions of them are linked to.
       *
       * @type {Map<string, string>}
       */
      mentions: conversation.mentions,
    };
    run.turn = turn;
    this._watchIdle();
    panel._setBusy(true);
    try {
      await this.start();
      if (run.turn != turn || this.run != run || !run.agent) {
        // It could not be started, which start() has said, or this was
        // stopped while it was.
        return;
      }
      // Made only now, so that it comes after the notices starting left.
      turn.body = panel._addTurn("assistant");
      turn.record = answer;
      const agent = run.agent;
      panel._attachDshSession(conversation, agent);
      try {
        // Answered here or, if the conversation is left before it is done,
        // out of sight: turn.body goes with what the transcript showed.
        const stopReason = await agent.prompt(blocks);
        if (run.turn != turn) {
          // Ended from elsewhere -- dsh stopped or turned off -- which has
          // recorded how.
        } else if (stopReason == "cancelled") {
          turn.body.appendChild(panel._notice("ai-panel-stopped"));
          this._recordPart(turn, { type: "notice", id: "ai-panel-stopped" });
        } else if (stopReason && stopReason != "end_turn") {
          const part = {
            type: "notice",
            id: "ai-panel-dsh-stopped-early",
            args: { reason: stopReason },
          };
          turn.body.appendChild(this._noticeWith(part.id, part.args));
          this._recordPart(turn, part);
        }
      } catch (ex) {
        // A run that died is explained by _onExit; anything else is shown
        // here.
        if (run.agent == agent && run.turn == turn) {
          turn.body.appendChild(this._error(ex.message));
          this._recordPart(turn, { type: "error", text: ex.message });
        }
      }
    } finally {
      // A turn ended from elsewhere -- dsh stopped or turned off -- may have
      // been followed by another by now, which is not this one's to end.
      if (run.turn == turn) {
        this._endPrompt(run);
      }
      // Its own conversation, which by now may not be the one shown.
      panel._saveConversation(conversation);
    }
  }

  /**
   * Record one more thing shown in a turn's answer, in the order shown.
   *
   * @param {?object} turn
   * @param {object} part
   * @returns {object} The part, to go on filling in.
   */
  _recordPart(turn, part) {
    turn?.record?.parts.push(part);
    return part;
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
        `the message open in Thunderbird AI: "${hdr.mime2DecodedSubject}", ` +
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
   * Delete the sessions Thunderbird started in dsh, after asking. Those in
   * use are kept: dsh has them open.
   */
  async clearSessions() {
    // The one dsh has open, the one the conversation shown was answered in,
    // which is reopened when it is carried on, and those dsh is answering in
    // out of sight or has only just stopped answering in.
    const keep = [
      this.agent?.sessionId,
      this.panel.conversation?.dsh?.sessionId,
      ...[...this._background.values()].map(run => run.agent?.sessionId),
      ...this._closing.keys(),
    ].filter(Boolean);
    const ids = (await lazy.DshSessions.list())
      .map(session => session.id)
      .filter(id => !keep.includes(id));
    const count = ids.length;
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
      const deleted = await lazy.DshSessions.remove(ids);
      // Their conversations go too: there is no carrying them on.
      await lazy.AIConversations.removeForDshSessions(ids);
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

  /**
   * @param {DshRun} run - The one dsh is reporting on, which may be
   *   answering out of sight.
   * @param {object} update - A session/update's.
   */
  _onUpdate(run, update) {
    if (update?.sessionUpdate == "config_option_update") {
      if (run == this.run) {
        this._fillModelPicker();
      }
      return;
    }
    const turn = run.turn;
    if (!turn?.body) {
      return;
    }
    // Out of sight, the transcript is another conversation's.
    const follow = run == this.run && this.panel._isAtEnd();

    switch (update.sessionUpdate) {
      case "agent_thought_chunk": {
        if (update.content?.type != "text") {
          break;
        }
        if (!turn.thinking) {
          turn.thinking = this.panel._addThinking(turn.body);
          turn.thinkingPart = this._recordPart(turn, {
            type: "thinking",
            text: "",
          });
        }
        turn.thinking.text.textContent += update.content.text;
        turn.thinkingPart.text += update.content.text;
        break;
      }

      case "agent_message_chunk": {
        if (update.content?.type != "text") {
          break;
        }
        this._foldThinking(run);
        // One message arrives whole; a later one after a tool call gets a
        // block of its own, so the transcript reads in the order things
        // happened.
        if (!turn.answer || update.messageId != turn.answerId) {
          turn.answer = document.createElement("div");
          turn.answer.className = "ai-answer";
          turn.body.appendChild(turn.answer);
          turn.answerId = update.messageId;
          turn.answerRaw = "";
          turn.answerPart = this._recordPart(turn, {
            type: "answer",
            text: "",
          });
        }
        turn.answerRaw += update.content.text;
        turn.answerPart.text = turn.answerRaw;
        this.panel._renderAnswer(turn.answer, turn.answerRaw, []);
        linkifyMessageMentions(turn.answer, document, turn.mentions);
        this.panel.linkFiles(turn.answer, run.agent?.workspace);
        break;
      }

      case "tool_call": {
        this._foldThinking(run);
        turn.answer = null;
        const tool = this._addTool(turn.body, update);
        tool.part = this._recordPart(turn, {
          type: "tool",
          title: String(update.title ?? "tool"),
          status: update.status ?? "in_progress",
          input: tool.inputText,
        });
        turn.tools.set(update.toolCallId, tool);
        break;
      }

      case "tool_call_update": {
        const tool = turn.tools.get(update.toolCallId);
        if (tool) {
          this._updateTool(tool, update, turn.mentions);
        }
        break;
      }
    }

    if (follow) {
      this.panel._scrollToEnd();
    }
  }

  /** @param {DshRun} run */
  _foldThinking(run) {
    const thinking = run.turn?.thinking;
    if (thinking) {
      thinking.details.open = false;
      thinking.details.classList.add("ai-thinking-done");
      run.turn.thinking = null;
      run.turn.thinkingPart = null;
    }
  }

  /**
   * Show a tool call as it was recorded with an earlier conversation.
   *
   * @param {HTMLElement} container
   * @param {object} part - {title, status, input, output}.
   */
  renderTool(container, part) {
    const tool = this._addTool(container, {
      title: part.title,
      status: part.status,
      rawInput: part.input ?? undefined,
    });
    if (part.output) {
      tool.output.textContent = part.output;
      tool.output.hidden = false;
    }
  }

  /**
   * @param {HTMLElement} container
   * @param {object} call - A tool_call update.
   * @returns {{details: HTMLElement, name: HTMLElement, output: HTMLElement, inputText: ?string}}
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

    let inputText = null;
    if (call.rawInput !== undefined) {
      const input = document.createElement("pre");
      input.className = "ai-dsh-tool-input";
      inputText = shorten(
        typeof call.rawInput == "string"
          ? call.rawInput
          : JSON.stringify(call.rawInput, null, 2)
      );
      input.textContent = inputText;
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
      inputText,
      mail: title.startsWith(MAIL_TOOL_PREFIX),
    };
  }

  /**
   * @param {object} tool - As _addTool made it.
   * @param {object} update - A tool_call_update.
   * @param {Map<string, string>} mentions - The conversation's.
   */
  _updateTool(tool, update, mentions) {
    if (update.status) {
      tool.details.dataset.status = update.status;
      if (tool.part) {
        tool.part.status = update.status;
      }
    }
    const text = (update.content ?? [])
      .map(item => (item.content?.type == "text" ? item.content.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) {
      tool.output.textContent = shorten(text);
      tool.output.hidden = false;
      if (tool.part) {
        tool.part.output = tool.output.textContent;
      }
      if (tool.mail) {
        this._rememberMessages(text, mentions);
      }
    }
  }

  /**
   * Note the subject and id of each message a mail tool returned, so that an
   * answer naming one without a link can still be given one.
   *
   * @param {string} text - The tool's result, which for the mail tools is
   *   JSON: one message, or lists of them.
   * @param {Map<string, string>} mentions - Where to note them.
   */
  _rememberMessages(text, mentions) {
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
        mentions.set(subject, value.id);
      }
      for (const child of Object.values(value)) {
        visit(child, depth + 1);
      }
    };
    visit(result, 0);
  }

  /**
   * Ask whether dsh may go ahead with a tool call. Out of sight, the
   * question waits in the conversation, and the list of conversations says
   * that it does.
   *
   * @param {DshRun} run - The one asking.
   * @param {object} request - session/request_permission's params.
   * @returns {Promise<?string>} The chosen option's id, or null.
   */
  async _askPermission(run, request) {
    const allow = request.options?.find(o => o.kind?.startsWith("allow"));
    if (run.allowAll && allow) {
      return allow.optionId;
    }
    if (!run.turn?.body && run != this.run) {
      // Nowhere to ask it.
      return null;
    }
    const container = run.turn?.body ?? this.panel.transcript;
    const tool = run.turn?.tools.get(request.toolCall?.toolCallId);

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
    if (run == this.run) {
      this.panel._scrollToEnd();
    }

    return new Promise(resolve => {
      const answer = (optionId, outcomeId) => {
        run.waiting.delete(settle);
        buttons.remove();
        const outcome = document.createElement("p");
        outcome.className = "ai-dsh-permission-outcome";
        document.l10n.setAttributes(outcome, outcomeId);
        box.appendChild(outcome);
        this._showOutOfSight();
        resolve(optionId);
      };
      const settle = optionId =>
        answer(optionId, "ai-panel-dsh-permission-cancelled");
      run.waiting.add(settle);
      this._showOutOfSight();

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
          run.allowAll = true;
          answer(allow.optionId, "ai-panel-dsh-allowed");
        });
        buttons.appendChild(always);
      }
    });
  }

  /**
   * Settle every permission prompt a run has waiting, with the same answer.
   *
   * @param {DshRun} run
   * @param {?string} optionId
   */
  _answerWaiting(run, optionId) {
    for (const settle of [...run.waiting]) {
      settle(optionId);
    }
  }

  /**
   * dsh ended by itself. Out of sight, that is recorded with the
   * conversation, to be seen when it is opened again.
   *
   * @param {DshRun} run
   * @param {DshAgent} agent
   * @param {{exitCode: number, stderr: string}} info
   */
  _onExit(run, agent, { exitCode, stderr }) {
    if (run.agent != agent) {
      return;
    }
    run.agent = null;
    this._answerWaiting(run, null);
    if (run.turn) {
      this._recordPart(run.turn, {
        type: "notice",
        id: "ai-panel-dsh-exited",
        args: { code: exitCode },
      });
    }
    const shown = run == this.run;
    this._endPrompt(run);
    if (!shown) {
      return;
    }
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
    this._showModelPicker();
    this.panel.refreshConfigured();
    this.panel.updateDraftButton();
    this._watchIdle();
  }

  /**
   * A run's prompt is over, however it ended. Out of sight, that is the end
   * of the run: dsh is stopped, and the conversation, which send() saves,
   * is opened from what was kept from now on, starting dsh again in its
   * session when it is next asked something.
   *
   * @param {DshRun} run
   */
  _endPrompt(run) {
    if (!run.turn) {
      return;
    }
    this._foldThinking(run);
    run.turn = null;
    if (run == this.run) {
      this.panel._setBusy(false);
      this.panel.input.focus();
      this._watchIdle();
      return;
    }

    const id = run.conversation?.id;
    if (this._background.get(id) == run) {
      this._background.delete(id);
    }
    clearTimeout(run.waitTimer);
    run.waitTimer = null;
    const agent = run.agent;
    run.agent = null;
    run.hidden = null;
    if (agent) {
      this._retireNoting(agent);
    }
    this._showOutOfSight();
  }

  /**
   * Have the panel mark the conversations dsh answers out of sight, and stop
   * any that wait too long on a permission.
   */
  _showOutOfSight() {
    this._watchWaiting();
    this.panel.showOutOfSight(this.outOfSight());
  }

  _fillModelPicker() {
    const option = this.agent?.configOptions.find(o => o.id == "model");
    this.modelPicker.replaceChildren();
    if (!option) {
      this._showModelPicker();
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
        // Marked as dsh's: the panel's own picker sits in the same place.
        document.l10n.setAttributes(group, "ai-panel-dsh-model-group", {
          provider: entry.name,
        });
        entry.options.forEach(choice => add(group, choice));
        this.modelPicker.appendChild(group);
      } else {
        add(this.modelPicker, entry);
      }
    }
    this.modelPicker.value = option.currentValue;
    this._showModelPicker();
  }

  /**
   * dsh's model picker is shown once dsh has said what its models are. It
   * stays where it is while dsh starts again for another conversation, so the
   * box above it does not jump, but it can only be used while dsh is on --
   * or stopped for sitting idle, when what is chosen is chosen as it starts.
   */
  _showModelPicker() {
    this.modelPicker.hidden =
      this.state == "off" || !this.modelPicker.options.length;
    this.modelPicker.disabled = !(
      this.state == "on" ||
      (this.state == "ready" && this._pendingModel)
    );
  }

  async _changeModel() {
    const agent = this.agent;
    if (!agent) {
      if (this.state == "ready" && this._pendingModel) {
        this._pendingModel = this.modelPicker.value;
      }
      return;
    }
    try {
      await agent.setConfigOption("model", this.modelPicker.value);
    } catch (ex) {
      this.panel.transcript.appendChild(this._error(ex.message));
    }
    this._fillModelPicker();
    // Choosing one is using dsh: it is not stopped for sitting idle just
    // after.
    this._watchIdle();
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
