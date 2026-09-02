/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The AI panel: a conversation with a model, in the pane on the right.
 *
 * The one piece of behaviour worth calling out is how reasoning is shown.
 * Reasoning models emit their scratch work before the answer, and it is
 * useful to watch while you wait but noise once the answer exists. So it
 * streams into view while it is happening and folds itself away the moment
 * the answer starts -- still there behind a disclosure if you want to look,
 * gone from the flow if you don't.
 */

import {
  renderMarkdown,
  linkifyCitations,
} from "chrome://messenger/content/ai-markdown.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIConfig: "resource:///modules/AIConfig.sys.mjs",
  AIMailContext: "resource:///modules/AIMailContext.sys.mjs",
  AIFormat: "resource:///modules/AIProvider.sys.mjs",
  AIProvider: "resource:///modules/AIProvider.sys.mjs",
  MailServices: "resource:///modules/MailServices.sys.mjs",
  openLinkExternally: "resource:///modules/LinkHelper.sys.mjs",
});

/**
 * Keeps a long session bounded: both the turns shown and the history sent
 * with each question are trimmed to this many.
 */
const MAX_TURNS = 40;

/**
 * How many times a question may be searched for before answering with
 * whatever was found. Each extra round costs two requests and a visible
 * wait, so this stays small: one reformulation is where most of the
 * benefit is.
 */
const MAX_RETRIEVAL_ROUNDS = 2;

/**
 * Whether a question is already shaped like a search query -- a few words,
 * no question mark, no interrogative opening. Such input is better used
 * as-is than paraphrased by a model.
 *
 * @param {string} question
 * @returns {boolean}
 */
function isKeywordLike(question) {
  const text = question.trim();
  if (text.includes("?") || text.split(/\s+/).length > 5) {
    return false;
  }
  return !/^(who|what|when|where|which|why|how|did|do|does|is|are|was|were|can|could|should|would|tell|show|find|summar)/i.test(
    text
  );
}

/**
 * Output budget for the small helper calls that write and judge search
 * queries. The replies are a few words, but a reasoning model reasons
 * first and that reasoning comes out of the same budget -- measured at
 * 840 to 2000 tokens for these prompts, so anything tighter truncates the
 * reply before it begins and the query comes back empty.
 */
const SIDE_CALL_MAX_TOKENS = 2048;

/**
 * Picker values standing for the two actions rather than a profile. The NUL
 * prefix is so no profile name can ever collide with one.
 */
const ADD_PROFILE = "\u0000add";
const SET_KEY = "\u0000key";

export const AIPanel = {
  /** @type {?AbortController} Non-null while a conversation request is in flight. */
  _abort: null,

  /**
   * @type {?AbortController} Non-null while a reply is being drafted.
   *
   * Drafting reads the whole thread and writes a reply, so it runs for long
   * enough that holding the composer shut for it would make the pane unusable
   * for the wait. It gets its own controller and is cancelled on its own.
   */
  _draftAbort: null,

  /** @type {Array<{role: string, content: string}>} Conversation so far. */
  _messages: [],

  _initialized: false,

  async init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    this.panel = document.getElementById("aiPane");
    this.transcript = document.getElementById("ai-panel-transcript");
    this.form = document.getElementById("ai-panel-composer");
    this.input = document.getElementById("ai-panel-input");
    this.sendButton = document.getElementById("ai-panel-send");
    this.stopButton = document.getElementById("ai-panel-stop");
    this.setupNotice = document.getElementById("ai-panel-setup");
    this.actions = document.getElementById("ai-panel-actions");
    this.modelPicker = document.getElementById("ai-panel-model");

    this.modelPicker.addEventListener("change", () => {
      switch (this.modelPicker.value) {
        case ADD_PROFILE:
          this.addProfile();
          break;
        case SET_KEY:
          // Put the selection back before asking: the dialog can be
          // cancelled, and the picker should go on showing what is in use.
          this.refreshProfiles().then(() => this.promptForConnection());
          break;
        default:
          this.switchProfile(this.modelPicker.value);
      }
    });

    this.form.addEventListener("submit", event => {
      event.preventDefault();
      this.send();
    });
    this.draftButton = document.getElementById("ai-panel-draft-reply");

    // Delegated: answers are re-rendered on every streamed fragment, so
    // anything bound to the links themselves would be rebound dozens of
    // times a second.
    this.transcript.addEventListener("click", event =>
      this._onTranscriptClick(event)
    );

    this.stopButton.addEventListener("click", () => this.cancel());
    document
      .getElementById("ai-panel-clear")
      .addEventListener("click", () => this.clear());
    document
      .getElementById("ai-panel-close")
      .addEventListener("click", () => AIPanelUI.toggle(false));
    document
      .getElementById("ai-panel-setup-key")
      .addEventListener("click", () => this.promptForConnection());
    this.draftButton.addEventListener("click", () => {
      if (this._draftAbort) {
        this.cancelDraft();
      } else {
        this.draftReply();
      }
    });

    // The draft button only makes sense with a message selected, and what
    // is selected changes as the user moves around the mail window.
    document.addEventListener("MsgLoaded", () => this.updateDraftButton());
    window.addEventListener("focus", () => this.updateDraftButton(), true);
    this.updateDraftButton();

    // Enter sends, Shift+Enter makes a new line -- the convention for this
    // kind of composer. Cmd or Ctrl with it drafts a reply instead, which is
    // the convention for "the other thing this box can do".
    this.input.addEventListener("keydown", event => {
      if (event.key != "Enter" || event.shiftKey) {
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        this.draftReply();
        return;
      }
      event.preventDefault();
      this.send();
    });

    // What the draft button offers depends on whether there is anything to
    // steer it with, so it is re-labelled as you type.
    this.input.addEventListener("input", () => this.updateDraftButton());

    await this.refreshProfiles();
    await this.refreshConfigured();
  },

  /**
   * Fill the picker from the config file and mark the profile in use.
   *
   * Rebuilt rather than updated, because the file is editable by hand while
   * the panel is open and a profile added there should appear here.
   */
  async refreshProfiles() {
    let profiles = [];
    try {
      profiles = await lazy.AIConfig.listProfiles();
    } catch (ex) {
      console.error("Could not read the AI profiles:", ex);
    }

    this.modelPicker.replaceChildren();
    for (const profile of profiles) {
      const option = document.createElement("option");
      option.value = profile.name;
      option.textContent = profile.label;
      option.selected = profile.active;
      this.modelPicker.appendChild(option);
    }

    // The two things you can do to the list live in it rather than beside
    // it: both are the same question -- which model -- with more answers.
    // Grouped, so they read as actions and not as further endpoints.
    const actions = document.createElement("optgroup");
    document.l10n.setAttributes(actions, "ai-panel-model-actions");
    for (const [value, id] of [
      [SET_KEY, "ai-panel-model-key"],
      [ADD_PROFILE, "ai-panel-model-add"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      document.l10n.setAttributes(option, id);
      actions.appendChild(option);
    }
    this.modelPicker.appendChild(actions);

    // Never hidden now: with nothing configured it is the way to configure
    // something, and with one profile it is the way to add a second.
    this.modelPicker.hidden = false;
  },

  /**
   * Ask for an endpoint and add it.
   *
   * Four questions, in the order the answers are found: the URL is on the
   * provider's page, the format follows from which provider it is, the model
   * name from their list, and the name is whatever the user wants to see in
   * the picker. The key is asked for last, by the same dialog that changes
   * it later, so there is one place that ever sees a key.
   */
  async addProfile() {
    // Put the picker back first: the questions can be cancelled, and until
    // one is answered the selection should still show what is in use.
    await this.refreshProfiles();

    const [
      title,
      urlMessage,
      badUrl,
      formatMessage,
      modelMessage,
      nameMessage,
      taken,
    ] = await document.l10n.formatValues([
      { id: "ai-panel-model-add-title" },
      { id: "ai-panel-model-add-url" },
      { id: "ai-panel-url-invalid" },
      { id: "ai-panel-model-add-format" },
      { id: "ai-panel-model-add-model" },
      { id: "ai-panel-model-add-name" },
      { id: "ai-panel-model-add-taken" },
    ]);

    const url = { value: "https://" };
    if (!Services.prompt.prompt(window, title, urlMessage, url, null, {})) {
      return;
    }
    const baseUrl = url.value.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(baseUrl)) {
      Services.prompt.alert(window, title, badUrl);
      return;
    }

    // Listed in the order they are named in the dialog, so the index maps to
    // a format without a lookup table to keep in step.
    const formats = [lazy.AIFormat.OPENAI, lazy.AIFormat.ANTHROPIC];
    const chosen = { value: 0 };
    if (
      !Services.prompt.select(
        window,
        title,
        formatMessage,
        ["OpenAI-compatible", "Anthropic"],
        chosen
      )
    ) {
      return;
    }

    const modelName = { value: "" };
    if (
      !Services.prompt.prompt(window, title, modelMessage, modelName, null, {})
    ) {
      return;
    }
    if (!modelName.value.trim()) {
      return;
    }

    // Prefilled with the model, which is what a profile is normally called:
    // the provider is already implied by the model and the base URL. Left as
    // it is, that is the name; it stays editable for the case of two entries
    // differing by something else, like a key or a token budget.
    const profileName = { value: modelName.value.trim() };
    if (
      !Services.prompt.prompt(window, title, nameMessage, profileName, null, {})
    ) {
      return;
    }
    if (!profileName.value.trim()) {
      return;
    }

    const profiles = await lazy.AIConfig.listProfiles();
    if (profiles.some(entry => entry.name == profileName.value.trim())) {
      Services.prompt.alert(window, title, taken);
      return;
    }

    await lazy.AIConfig.addProfile({
      name: profileName.value.trim(),
      format: formats[chosen.value],
      baseUrl,
      model: modelName.value.trim(),
    });

    await this.refreshProfiles();
    // Straight on to the key, since a profile without one cannot be used and
    // this is the moment the user is thinking about this endpoint.
    await this.promptForConnection();
  },

  /**
   * Send subsequent requests to another profile.
   *
   * The conversation is left alone. Models differ in what they will say but
   * not in how the exchange is shaped, so there is nothing to discard --
   * and switching to compare two answers to the same question is the
   * obvious reason to switch at all.
   *
   * @param {string} profileName
   */
  async switchProfile(profileName) {
    try {
      await lazy.AIConfig.setActiveProfile(profileName);
    } catch (ex) {
      console.error("Could not switch AI profile:", ex);
      await this.refreshProfiles();
      return;
    }

    // A profile that has no key yet shows the setup notice instead of the
    // composer, which is the same state a first run is in.
    await this.refreshConfigured();
    this.updateDraftButton();
  },

  /**
   * Show the setup notice instead of the composer when there is nothing to
   * talk to, so the panel never looks broken when it is merely unconfigured.
   */
  async refreshConfigured() {
    const configured = await lazy.AIConfig.isConfigured();
    this.setupNotice.hidden = configured;
    this.form.hidden = !configured;
    this.transcript.hidden = !configured;
    this.actions.hidden = !configured;
    return configured;
  },

  /** Remove the conversation, both on screen and as model context. */
  clear() {
    this.cancel();
    this.cancelDraft();
    this._messages = [];
    this.transcript.replaceChildren();
  },

  /** Abort an in-flight conversation request, if there is one. */
  cancel() {
    this._abort?.abort();
    this._abort = null;
    this._setBusy(false);
  },

  /** Abort a reply being drafted, if there is one. */
  cancelDraft() {
    this._draftAbort?.abort();
    this._draftAbort = null;
    this.updateDraftButton();
  },

  _setBusy(busy) {
    this.sendButton.hidden = busy;
    this.stopButton.hidden = !busy;
    this.input.disabled = busy;
  },

  /**
   * Add a turn to the transcript.
   *
   * @param {string} role - "user" or "assistant".
   * @returns {HTMLElement} The bubble, for streaming content into.
   */
  _addTurn(role) {
    const turn = document.createElement("div");
    turn.className = `ai-turn ai-turn-${role}`;

    const body = document.createElement("div");
    body.className = "ai-turn-body";
    turn.appendChild(body);

    this.transcript.appendChild(turn);
    this._trimTranscript();
    this._scrollToEnd();
    return body;
  },

  /**
   * Create the collapsible reasoning block for an assistant turn.
   *
   * It starts open, because while it is filling in it is the only thing
   * there is to look at.
   *
   * @param {HTMLElement} turnBody
   * @returns {{details: HTMLElement, text: HTMLElement}}
   */
  _addThinking(turnBody) {
    const details = document.createElement("details");
    details.className = "ai-thinking";
    details.open = true;

    const summary = document.createElement("summary");
    summary.className = "ai-thinking-summary";
    document.l10n.setAttributes(summary, "ai-panel-thinking");
    details.appendChild(summary);

    const text = document.createElement("div");
    text.className = "ai-thinking-text";
    details.appendChild(text);

    turnBody.appendChild(details);
    return { details, text };
  },

  _trimTranscript() {
    while (this.transcript.childElementCount > MAX_TURNS) {
      this.transcript.firstElementChild.remove();
    }

    // The history sent with each question is trimmed to the same length as
    // the transcript shown. It used not to be, which cost twice: a session
    // left open all day held every turn it had ever had, and -- because the
    // whole history goes out with every question -- each request carried the
    // lot, growing slower and more expensive the longer the session ran.
    while (this._messages.length > MAX_TURNS) {
      this._messages.shift();
    }
    // Dropping from the front can leave a reply whose question has gone.
    // Providers that require the exchange to open with a user message reject
    // that outright, so drop the orphan too.
    if (this._messages[0]?.role == "assistant") {
      this._messages.shift();
    }
  },

  _scrollToEnd() {
    this.transcript.scrollTop = this.transcript.scrollHeight;
  },

  /** Whether the user is following along at the bottom of the transcript. */
  _isAtEnd() {
    const slack = 40;
    return (
      this.transcript.scrollHeight -
        this.transcript.scrollTop -
        this.transcript.clientHeight <
      slack
    );
  },

  /**
   * Send whatever is in the composer.
   */
  async send() {
    const question = this.input.value.trim();
    if (!question || this._abort) {
      return;
    }

    if (!(await this.refreshConfigured())) {
      return;
    }

    this.input.value = "";
    this._addTurn("user").textContent = question;
    this._messages.push({ role: "user", content: question });

    const answerBody = this._addTurn("assistant");
    let thinking = null;
    let answerText = null;
    // The Markdown is rendered from the whole answer each time, so the raw
    // text has to be kept: a fragment on its own is not parseable, and a
    // list or code fence only becomes one once its later lines arrive.
    let answerRaw = "";
    let lastRender = 0;
    let sources = [];

    this._setBusy(true);
    // Held locally as well, so that a request cancelled and resent before this
    // one unwinds neither has its controller cleared from under it nor has the
    // composer reopened while it is still streaming.
    const controller = new AbortController();
    this._abort = controller;

    try {
      const options = await lazy.AIConfig.requestOptions();

      // Retrieve relevant mail for this question. Only the newest turn is
      // grounded: re-searching for every follow-up would send the mailbox
      // repeatedly, and the earlier context is still in the transcript.
      const grounded = await this._buildGroundedPrompt(
        question,
        answerBody,
        controller.signal
      );
      sources = grounded.sources ?? [];
      const sendMessages = [
        ...this._messages.slice(0, -1),
        { role: "user", content: grounded.content },
      ];

      const result = await lazy.AIProvider.chatStream({
        ...options,
        system: grounded.system,
        messages: sendMessages,
        signal: controller.signal,

        onReasoning: fragment => {
          // Create the block lazily: a model that doesn't reason should
          // not leave an empty disclosure behind.
          thinking ??= this._addThinking(answerBody);
          const follow = this._isAtEnd();
          thinking.text.textContent += fragment;
          if (follow) {
            this._scrollToEnd();
          }
        },

        onReasoningEnd: () => {
          // The answer is starting, so put the scratch work away. It stays
          // in the DOM, one click from view, rather than being discarded.
          if (thinking) {
            thinking.details.open = false;
            thinking.details.classList.add("ai-thinking-done");
          }
        },

        onText: fragment => {
          if (!answerText) {
            answerText = document.createElement("div");
            answerText.className = "ai-answer";
            answerBody.appendChild(answerText);
          }
          answerRaw += fragment;
          // Re-rendering on every fragment would re-parse the whole answer
          // dozens of times a second for no visible gain.
          const now = Date.now();
          if (now - lastRender < 80) {
            return;
          }
          lastRender = now;
          const follow = this._isAtEnd();
          this._renderAnswer(answerText, answerRaw, sources);
          if (follow) {
            this._scrollToEnd();
          }
        },
      });

      if (answerText) {
        // The throttle above may have skipped the final fragment, and only
        // now is the Markdown complete enough to render properly.
        this._renderAnswer(answerText, answerRaw, sources);
      }

      if (result.text) {
        this._messages.push({ role: "assistant", content: result.text });
      }
    } catch (ex) {
      if (ex?.name == "AbortError") {
        // Cancelled by the user; leave whatever arrived in place.
        answerBody.appendChild(this._notice("ai-panel-stopped"));
      } else {
        console.error("AI request failed:", ex);
        const error = document.createElement("div");
        error.className = "ai-error";
        // The provider's own message is the useful part -- it says whether
        // the key was rejected, the model was wrong, or nothing answered.
        error.textContent = ex.message;
        answerBody.appendChild(error);
      }
    } finally {
      if (this._abort == controller) {
        this._abort = null;
        this._setBusy(false);
        this.input.focus();
      }
    }
  },

  /**
   * Send a clicked link to the browser instead of following it here.
   *
   * A chrome document has nowhere sensible to navigate: following the link
   * in place would replace the pane with the page. The scheme is checked
   * again here rather than trusted from render time, because what reaches
   * the transcript is model output.
   *
   * @param {MouseEvent} event
   */
  _onTranscriptClick(event) {
    // Not a plain left click: let the platform do whatever it does.
    if (event.button != 0 || event.defaultPrevented) {
      return;
    }
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor) {
      return;
    }
    // Citations point at mail rather than the web, and have their own
    // handler which has already run by now.
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#")) {
      return;
    }
    let uri;
    try {
      uri = Services.io.newURI(href);
    } catch {
      return;
    }
    if (!["http", "https", "mailto"].includes(uri.scheme)) {
      return;
    }
    event.preventDefault();
    lazy.openLinkExternally(uri);
  },

  /**
   * Render an answer as Markdown, with its citations linked.
   *
   * @param {HTMLElement} container - Element to render into; emptied first.
   * @param {string} raw - The answer so far, as Markdown.
   * @param {object[]} sources - Cited threads, keyed by their index.
   */
  _renderAnswer(container, raw, sources) {
    container.replaceChildren(renderMarkdown(raw, document));

    if (!sources?.length) {
      return;
    }
    // "2" is a conversation, "2.3" the third message in it. The model is
    // asked for the message-level form, so that following a citation opens
    // the message the answer actually came from; the thread-level form is
    // still understood, since that is what it falls back to.
    const targets = new Map();
    for (const source of sources) {
      if (source.uri) {
        targets.set(String(source.index), {
          uri: source.uri,
          subject: source.subject,
        });
      }
      for (const message of source.messages ?? []) {
        if (message.uri) {
          targets.set(message.ref, {
            uri: message.uri,
            subject: source.subject,
          });
        }
      }
    }

    linkifyCitations(
      container,
      document,
      ref => targets.has(ref),
      ref => {
        const target = targets.get(ref);
        if (target) {
          this._showMessage(target.uri, target.subject);
        }
      }
    );
  },

  /**
   * Show a cited message in the message pane.
   *
   * Not a new tab: the citation is being followed while reading an answer,
   * and the point is to see what it refers to without losing the thread of
   * the conversation. selectMessage switches folder and clears any quick
   * filter in the way, and the message pane follows the selection.
   *
   * @param {string} uri
   * @param {string} [subject] - For the error message, if it cannot be shown.
   */
  _showMessage(uri, subject) {
    try {
      const hdr =
        lazy.MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
      if (typeof window.selectMessage == "function") {
        window.selectMessage(hdr);
        return;
      }
      // Not in the mail tab -- fall back to opening it outright.
      this._openMessage(uri);
    } catch (ex) {
      console.warn(
        `Could not show the cited message${subject ? ` "${subject}"` : ""}:`,
        ex
      );
    }
  },

  /**
   * @param {string} l10nId
   * @returns {HTMLElement}
   */
  _notice(l10nId) {
    const notice = document.createElement("div");
    notice.className = "ai-notice";
    document.l10n.setAttributes(notice, l10nId);
    return notice;
  },

  // -- API key ------------------------------------------------------------

  /**
   * Ask for the endpoint and the API key, and store them.
   *
   * The two belong together: pointing at a different provider almost always
   * means a different key, and editing ai-config.json by hand to change one
   * of them is a poor answer to "this key stopped working".
   *
   * Both prompts open on the current setting, so this doubles as a way to
   * see what is configured, and either can be left alone by pressing Enter.
   *
   * The key uses the password prompt, so it is masked as it is typed and
   * never sits in a text field that could be screenshotted or logged. It is
   * stored in the login manager; the base URL is not secret and goes in
   * ai-config.json.
   */
  async promptForConnection() {
    const profile = await lazy.AIConfig.activeProfile();
    const provider = profile.label ?? profile.name;
    const [title, urlMessage, keyMessage, badUrl] =
      await document.l10n.formatValues([
        { id: "ai-panel-key-title" },
        { id: "ai-panel-url-prompt", args: { provider } },
        { id: "ai-panel-key-prompt", args: { provider } },
        { id: "ai-panel-url-invalid" },
      ]);

    const url = { value: profile.baseUrl ?? "" };
    if (!Services.prompt.prompt(window, title, urlMessage, url, null, {})) {
      return;
    }
    const baseUrl = url.value.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(baseUrl)) {
      // Anything else would fail later as an opaque network error, with
      // nothing pointing back at what was typed here.
      Services.prompt.alert(window, title, badUrl);
      return;
    }

    // Prefilled with the stored key, so pressing Enter keeps it and the
    // dialog also answers "which key is this profile using".
    const key = { value: (await lazy.AIConfig.getApiKey(profile.name)) ?? "" };
    if (
      !Services.prompt.promptPassword(window, title, keyMessage, key, null, {})
    ) {
      return;
    }

    if (baseUrl != profile.baseUrl) {
      const config = await lazy.AIConfig.read();
      config.profiles[profile.name].baseUrl = baseUrl;
      await lazy.AIConfig.save(config);
    }
    // Whatever is left in the field wins, including nothing: clearing it is
    // how a key gets removed.
    await lazy.AIConfig.setApiKey(profile.name, key.value.trim());
    await this.refreshConfigured();
  },

  // -- mailbox questions --------------------------------------------------

  /**
   * Search the mailbox for context, and render what was used underneath the
   * answer so the user can check it.
   *
   * @param {string} question
   * @param {HTMLElement} answerBody - Where to attach the sources list.
   * @param {AbortSignal} signal - The signal of the request being built for.
   * @returns {Promise<{system: string, content: string, sources: object[]}>}
   *   The prompt pieces, plus the threads behind them so that citations
   *   in the answer can be linked back to the mail they came from.
   */
  async _buildGroundedPrompt(question, answerBody, signal) {
    const config = await lazy.AIConfig.read();
    const context = await this._retrieve(question, answerBody, config, signal);

    if (!context.sources.length) {
      // Nothing found: say so rather than letting the model invent an
      // answer from no evidence at all.
      answerBody.appendChild(this._notice("ai-panel-no-context"));
      return {
        system:
          "You answer questions about the user's email, but no relevant " +
          "messages were found for this question. Tell the user that " +
          "nothing matching was found and suggest better search terms. " +
          "Do not invent contents of their mail.",
        content: question,
        sources: [],
      };
    }

    this._renderSources(
      answerBody,
      context.sources,
      context.truncated,
      context.queries.join(" → ")
    );

    return {
      system: lazy.AIMailContext.systemPrompt(context.sources.length),
      content: lazy.AIMailContext.userPrompt(question, context.prompt),
      sources: context.sources,
    };
  },

  /**
   * Search for context, reformulating if the first attempt falls short.
   *
   * One search rarely settles it: the first query is a guess made before
   * seeing any mail, and what comes back is the best clue about what to
   * search for instead. So after each round the model judges what was
   * found and can propose a better query, up to MAX_RETRIEVAL_ROUNDS.
   * Results are pooled across rounds, so a later round adds to the
   * evidence rather than replacing it.
   *
   * @param {string} question
   * @param {HTMLElement} answerBody - For the progress notice.
   * @param {object} config
   * @param {AbortSignal} signal - The signal of the request being built for.
   * @returns {Promise<{prompt: string, sources: object[], truncated: boolean, queries: string[]}>}
   */
  async _retrieve(question, answerBody, config, signal) {
    const progress = this._addSearchProgress(answerBody);

    const queries = [];
    const pooled = [];
    const seenIds = new Set();

    // A question that is already keyword-shaped ("budget meeting") is its
    // own best query; asking the model to rewrite it costs a round trip
    // and several seconds for no gain.
    let query;
    if (isKeywordLike(question)) {
      query = question.trim();
    } else {
      progress.step("ai-search-step-formulating");
      query = await this._formulateSearchQuery(question, signal);
    }

    for (let round = 1; round <= MAX_RETRIEVAL_ROUNDS; round++) {
      const effective = query || question;
      progress.step("ai-search-step-searching", { query: effective });

      const { messages, usedQuery } = await lazy.AIMailContext.searchMessages(
        effective,
        config.context
      );
      queries.push(usedQuery);

      let added = 0;
      for (const message of messages) {
        if (!seenIds.has(message.id)) {
          seenIds.add(message.id);
          pooled.push(message);
          added++;
        }
      }
      progress.step(added ? "ai-search-step-found" : "ai-search-step-none", {
        count: added,
      });

      if (round == MAX_RETRIEVAL_ROUNDS) {
        break;
      }

      // Judge what we have using only senders and subjects, which is
      // enough to spot irrelevance without resending every body.
      progress.step("ai-search-step-checking");
      const interim = await lazy.AIMailContext.buildContext(
        pooled,
        config.context
      );
      const next = await this._assessRetrieval(
        question,
        interim.sources,
        queries,
        signal
      );
      if (!next) {
        progress.step("ai-search-step-enough");
        break;
      }
      query = next;
    }

    progress.step("ai-search-step-reading", { count: pooled.length });
    progress.finish();
    return {
      ...(await lazy.AIMailContext.buildContext(pooled, config.context)),
      queries,
    };
  },

  /**
   * Ask whether what was found is enough, and if not, for a better query.
   *
   * @param {string} question
   * @param {object[]} sources
   * @param {string[]} triedQueries
   * @param {AbortSignal} signal - The signal of the request being built for.
   * @returns {Promise<?string>} A new query, or null to stop searching.
   */
  async _assessRetrieval(question, sources, triedQueries, signal) {
    try {
      const options = await lazy.AIConfig.requestOptions();
      const prompt = lazy.AIMailContext.assessPrompt(
        question,
        sources,
        triedQueries
      );
      const result = await lazy.AIProvider.chat({
        ...options,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.content }],
        maxTokens: SIDE_CALL_MAX_TOKENS,
        signal,
      });

      const reply = lazy.AIMailContext.cleanSearchQuery(result.text);
      if (!reply || /^enough$/i.test(reply)) {
        return null;
      }
      // A repeat would just search the same thing again.
      const normalized = reply.toLowerCase();
      if (triedQueries.some(q => q.toLowerCase().startsWith(normalized))) {
        return null;
      }
      return reply;
    } catch (ex) {
      if (ex?.name == "AbortError") {
        throw ex;
      }
      console.warn("Could not assess retrieval, stopping search:", ex);
      return null;
    }
  },

  /**
   * A live list of what the search is doing.
   *
   * Retrieval can take a while -- a query has to be written, sometimes
   * more than once, and each step is a request -- and a single unchanging
   * "Searching..." gives no sign of whether anything is happening. Each
   * step appears as it starts, the newest pulsing, so the wait is legible.
   *
   * @param {HTMLElement} parent
   * @returns {{step: Function, finish: Function}}
   */
  _addSearchProgress(parent) {
    const box = document.createElement("div");
    box.className = "ai-search-progress";

    const list = document.createElement("ul");
    list.className = "ai-search-steps";
    box.appendChild(list);
    parent.appendChild(box);

    const follow = () => {
      if (this._isAtEnd()) {
        this._scrollToEnd();
      }
    };
    follow();

    return {
      step: (l10nId, args) => {
        list.lastElementChild?.classList.remove("current");
        const item = document.createElement("li");
        item.className = "ai-search-step current";
        document.l10n.setAttributes(item, l10nId, args);
        list.appendChild(item);
        follow();
        return item;
      },
      finish: () => {
        // The citations that follow record which queries were used, so the
        // step list has done its job once the answer starts.
        box.remove();
      },
    };
  },

  /**
   * Ask the model for a mail search query.
   *
   * Kept deliberately cheap and non-fatal: it is a small request, and if
   * anything goes wrong the caller falls back to keyword extraction rather
   * than failing the question.
   *
   * @param {string} question
   * @param {AbortSignal} signal - The signal of the request being built for.
   * @returns {Promise<?string>} The query, or null to use the fallback.
   */
  async _formulateSearchQuery(question, signal) {
    try {
      const options = await lazy.AIConfig.requestOptions();
      const prompt = lazy.AIMailContext.searchQueryPrompt(question);
      const result = await lazy.AIProvider.chat({
        ...options,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.content }],
        // Generous for a handful of words, because reasoning models spend
        // their output budget thinking first: at 64 the budget ran out
        // mid-reasoning and the query came back empty every time.
        maxTokens: SIDE_CALL_MAX_TOKENS,
        signal,
      });
      const query = lazy.AIMailContext.cleanSearchQuery(result.text);
      if (!query) {
        console.warn(
          "The model returned no search query (finished:",
          result.finishReason,
          "); falling back to keywords."
        );
      }
      return query || null;
    } catch (ex) {
      if (ex?.name == "AbortError") {
        throw ex;
      }
      console.warn("Could not formulate a search query, using keywords:", ex);
      return null;
    }
  },

  _renderSources(parent, sources, truncated, query) {
    const details = document.createElement("details");
    details.className = "ai-sources";

    const summary = document.createElement("summary");
    summary.className = "ai-sources-summary";
    document.l10n.setAttributes(summary, "ai-panel-sources-threads", {
      count: sources.length,
    });
    details.appendChild(summary);

    const list = document.createElement("ul");
    list.className = "ai-sources-list";
    for (const source of sources) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = "#";
      link.textContent =
        source.messageCount > 1
          ? `[${source.index}] ${source.subject} — ${source.author} (${source.messageCount} messages)`
          : `[${source.index}] ${source.subject} — ${source.author}`;
      link.title = source.subject;
      if (source.uri) {
        link.addEventListener("click", event => {
          event.preventDefault();
          this._showMessage(source.uri, source.subject);
        });
      } else {
        link.setAttribute("aria-disabled", "true");
      }
      item.appendChild(link);
      list.appendChild(item);
    }
    details.appendChild(list);

    if (query) {
      // Showing the query makes a bad search diagnosable: the user can see
      // whether the right thing was looked for before judging the answer.
      const queryNote = document.createElement("div");
      queryNote.className = "ai-sources-note";
      document.l10n.setAttributes(queryNote, "ai-panel-search-query", {
        query,
      });
      details.appendChild(queryNote);
    }

    if (truncated) {
      const note = document.createElement("div");
      note.className = "ai-sources-note";
      document.l10n.setAttributes(note, "ai-panel-sources-truncated");
      details.appendChild(note);
    }

    parent.appendChild(details);
  },

  /**
   * Open a cited message in a tab.
   *
   * @param {string} uri
   */
  _openMessage(uri) {
    try {
      const hdr =
        lazy.MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
      window.top.MsgOpenNewTabForMessages?.([hdr]) ??
        window.top.OpenMessageInNewTab?.(hdr, { background: false });
    } catch (ex) {
      console.error("Could not open cited message:", ex);
    }
  },

  // -- reply drafting -----------------------------------------------------

  /**
   * A message from the user's current selection.
   *
   * The fallback for _replyTarget() when nothing is on display: with a
   * collapsed thread selected, or the message pane closed, there is no
   * previewed message but there is still a conversation to reply to.
   *
   * @returns {?nsIMsgDBHdr}
   */
  _selectedMessage() {
    try {
      // The pane is inside the mail tab, so this is the same window as the
      // thread pane -- no reaching across documents needed.
      if (window.gDBView?.numSelected >= 1) {
        return window.gDBView.hdrForFirstSelectedMessage;
      }
    } catch {
      // No view yet, or nothing selected.
    }
    return null;
  },

  /**
   * The message on display in the message pane, if one is.
   *
   * about:3pane shows a single message through messageBrowser and hides it
   * for everything else -- an empty selection, or the summary shown for
   * several -- so its being visible is what distinguishes "this message is
   * open" from "these messages are selected".
   *
   * @returns {?nsIMsgDBHdr}
   */
  _displayedMessage() {
    try {
      const browser = window.messageBrowser;
      if (browser && !browser.hidden) {
        return browser.contentWindow?.gMessage ?? null;
      }
    } catch {
      // No message pane in this tab.
    }
    return null;
  },

  /**
   * The message a drafted reply should answer.
   *
   * What is open in the message pane wins over what is selected in the
   * list: the reply is to the message being read, not to whatever the
   * thread has moved on to since.
   *
   * @returns {?nsIMsgDBHdr}
   */
  _replyTarget() {
    return this._displayedMessage() ?? this._selectedMessage();
  },

  updateDraftButton() {
    if (!this.draftButton) {
      return;
    }
    // While a draft is running the button is what cancels it, so it stays
    // enabled whatever the selection has moved on to.
    const drafting = !!this._draftAbort;
    const target = this._replyTarget();
    this.draftButton.disabled = !drafting && !target;

    // Three things the button can be, and it says which: it is stopping a
    // draft, it will use what you have typed, or it will read the thread and
    // decide for itself. Left as one label, the difference between the last
    // two was invisible, which is what made the box's second purpose a
    // secret.
    let id = "ai-panel-draft-reply";
    if (drafting) {
      id = "ai-panel-draft-stop";
    } else if (this.input?.value.trim()) {
      id = "ai-panel-draft-with-instruction";
    }
    document.l10n.setAttributes(this.draftButton, id);

    // The placeholder is the other half of saying so: with a message in
    // front of you the box has two uses, and with none it has one.
    document.l10n.setAttributes(
      this.input,
      target ? "ai-panel-input-with-message" : "ai-panel-input"
    );
  },

  /**
   * Draft a reply to the selected thread and open it in a compose window.
   *
   * It deliberately opens a compose window rather than saving to Drafts or
   * sending: the whole point is that you read it first.
   *
   * Runs alongside the conversation: the composer stays live while it works,
   * so a question can be asked and answered without waiting for the draft.
   */
  async draftReply() {
    const hdr = this._replyTarget();
    if (!hdr || this._draftAbort) {
      return;
    }
    if (!(await this.refreshConfigured())) {
      return;
    }

    // Whatever is in the composer is taken as an instruction for the draft --
    // "decline politely", "ask when they need it by". The alternative was a
    // dialog of its own, which is a worse trade: there is already a text box
    // in front of you, and a reply worth steering is usually one you have
    // already started thinking in words about. Empty, this drafts as before.
    const instruction = this.input.value.trim();
    if (instruction) {
      this.input.value = "";
      this._addTurn("user").textContent = instruction;
      // Into the history as well, not only onto the screen. Shown but not
      // remembered, a follow-up like "make that softer" would be answered by
      // a model that had never seen what was asked for, while the transcript
      // above it said otherwise.
      this._messages.push({ role: "user", content: instruction });
      this.updateDraftButton();
    }

    const answerBody = this._addTurn("assistant");
    answerBody.appendChild(this._notice("ai-panel-drafting"));

    // Held locally as well, so that a draft cancelled and restarted before
    // this one unwinds does not have its controller cleared from under it.
    const controller = new AbortController();
    this._draftAbort = controller;
    this.updateDraftButton();

    try {
      const { text: thread, target } =
        await lazy.AIMailContext.threadForReply(hdr);
      const identity =
        lazy.MailServices.accounts.getFirstIdentityForServer(
          hdr.folder.server
        ) ?? lazy.MailServices.accounts.defaultAccount?.defaultIdentity;

      // Compose needs an identity to send as, and refuses to open a window
      // without one. Say that plainly rather than spending a request on a
      // draft that can never be shown.
      if (!identity) {
        throw new Error(
          "No email identity is set up for this account, so a reply cannot " +
            "be composed. Add an account with an email address first."
        );
      }
      const me = `${identity.fullName || identity.email} <${identity.email}>`;

      const options = await lazy.AIConfig.requestOptions();
      const result = await lazy.AIProvider.chat({
        ...options,
        signal: controller.signal,
        system:
          `You draft email replies as ${me}. Write only the body of the ` +
          `reply: no subject line, no "To:" header, no quoted original, ` +
          `and no commentary about what you wrote. Match the tone of the ` +
          `conversation, and write in the language the message you are ` +
          `replying to is written in -- not the language of these ` +
          `instructions, and not the language the user writes their own ` +
          `instruction in. Someone who reads mail in two languages will ` +
          `write you an instruction in whichever comes to hand, and the ` +
          `reply still has to reach its recipient in theirs. ` +
          `Be direct and concise. If the thread asks ` +
          `questions, answer them. If something genuinely cannot be ` +
          `answered without information you do not have, leave a clearly ` +
          `marked [TODO] for the user rather than inventing it.` +
          (instruction
            ? ` The user has said what they want this reply to do. Follow ` +
              `that instruction: it decides what the reply says and how it ` +
              `says it, and the thread is there to tell you who you are ` +
              `answering and what about. Where the two disagree -- the ` +
              `instruction declines something the thread proposes, say -- ` +
              `the instruction is what the user wants said. Carry it out in ` +
              `the reply itself; do not describe it or acknowledge having ` +
              `been asked.`
            : ``),
        messages: [
          {
            role: "user",
            content: instruction
              ? `Draft a reply to the last message shown in this thread, ` +
                `doing what I have asked for below.\n\n` +
                `What I want the reply to do:\n${instruction}\n\n` +
                `${thread}`
              : `Draft a reply to the last message shown in this thread.\n\n` +
                `${thread}`,
          },
        ],
      });

      this._openReplyCompose(target, identity, result.text);
      answerBody.replaceChildren(this._notice("ai-panel-draft-opened"));
    } catch (ex) {
      if (ex?.name == "AbortError") {
        answerBody.replaceChildren(this._notice("ai-panel-stopped"));
      } else {
        console.error("Reply drafting failed:", ex);
        const error = document.createElement("div");
        error.className = "ai-error";
        error.textContent = ex.message;
        answerBody.replaceChildren(error);
      }
    } finally {
      if (this._draftAbort == controller) {
        this._draftAbort = null;
        this.updateDraftButton();
      }
    }
  },

  /**
   * Open a reply compose window with the generated body already in it.
   *
   * Thunderbird builds the headers and quoted original from
   * `originalMsgURI` and the ReplyAll type; only the body is ours.
   *
   * @param {nsIMsgDBHdr} hdr - The message being replied to.
   * @param {?nsIMsgIdentity} identity
   * @param {string} body
   */
  _openReplyCompose(hdr, identity, body) {
    // The generated text cannot be passed in composeFields: for reply
    // types the compose backend builds the body itself by quoting the
    // original, and overwrites whatever was set. So the window is opened
    // as an ordinary reply -- which is what gets the headers, recipients
    // and quoting right -- and the draft is inserted above the quote once
    // the editor exists.
    const observer = {
      observe: (subject, topic) => {
        if (topic != "domwindowopened") {
          return;
        }
        Services.ww.unregisterNotification(observer);
        const win = subject;
        win.addEventListener(
          "compose-editor-ready",
          () => this._insertDraftBody(win, body),
          { once: true }
        );
      },
    };
    Services.ww.registerNotification(observer);

    const params = Cc[
      "@mozilla.org/messengercompose/composeparams;1"
    ].createInstance(Ci.nsIMsgComposeParams);
    params.composeFields = Cc[
      "@mozilla.org/messengercompose/composefields;1"
    ].createInstance(Ci.nsIMsgCompFields);
    params.identity = identity;
    params.type = Ci.nsIMsgCompType.ReplyAll;
    params.format = Ci.nsIMsgCompFormat.Default;
    params.originalMsgURI = hdr.folder.getUriForMsg(hdr);

    try {
      lazy.MailServices.compose.OpenComposeWindowWithParams(null, params);
    } catch (ex) {
      Services.ww.unregisterNotification(observer);
      throw ex;
    }
  },

  /**
   * Put the generated reply above the quoted original, leaving the cursor
   * position and the quote itself untouched.
   *
   * @param {Window} win - The compose window.
   * @param {string} text
   */
  _insertDraftBody(win, text) {
    try {
      const doc = win.document.getElementById("messageEditor")?.contentDocument;
      if (!doc?.body) {
        console.error("Compose editor was not ready; draft not inserted.");
        return;
      }
      const fragment = doc.createDocumentFragment();
      for (const line of text.split(/\r?\n/)) {
        const div = doc.createElement("div");
        if (line) {
          div.textContent = line;
        } else {
          div.appendChild(doc.createElement("br"));
        }
        fragment.appendChild(div);
      }
      // A blank line so the draft and the quoted original don't run together.
      const spacer = doc.createElement("div");
      spacer.appendChild(doc.createElement("br"));
      fragment.appendChild(spacer);

      doc.body.insertBefore(fragment, doc.body.firstChild);
    } catch (ex) {
      console.error("Could not insert the drafted reply:", ex);
    }
  },
};

/**
 * Showing and hiding the panel. Kept separate from the conversation so the
 * window can toggle the pane without loading anything AI-related until it
 * is actually opened.
 */
export const AIPanelUI = {
  get box() {
    return document.getElementById("aiPane");
  },
  get splitter() {
    return document.getElementById("aiPaneSplitter");
  },

  /**
   * @param {boolean} [visible] - Omit to flip the current state.
   */
  async toggle(visible) {
    const box = this.box;
    if (visible === undefined) {
      visible = box.hidden;
    }
    box.hidden = !visible;
    this.splitter.hidden = !visible;
    // The pane splitter also tracks collapsed state; a pane can be present
    // but collapsed to zero width, which on screen is indistinguishable
    // from never having opened.
    this.splitter.isCollapsed = !visible;

    Services.xulStore.setValue(
      "about:3pane",
      "aiPane",
      "visible",
      String(visible)
    );

    // The status bar button in the containing window mirrors this state, and
    // the pane can be closed from its own header without going near it.
    Services.obs.notifyObservers(
      null,
      "ai-pane-visibility-changed",
      String(visible)
    );

    if (visible) {
      await AIPanel.init();
      AIPanel.input?.focus();
    }
  },

  /**
   * Restore the panel's visibility from the last session.
   *
   * With nothing stored the panel is shown, because in this build it takes
   * the place the calendar pane used to occupy and a feature nobody can
   * find is not a feature. Once the user closes it that choice is stored
   * and respected from then on.
   */
  async restore() {
    const stored = Services.xulStore.getValue(
      "about:3pane",
      "aiPane",
      "visible"
    );
    const visible = stored === "" ? true : stored == "true";
    if (visible) {
      await this.toggle(true);
      return;
    }
    // Staying closed is not a change, so nothing would be announced -- but
    // the window's status button binds before this document exists and has
    // no other way to learn that there is now a pane for it to act on.
    Services.obs.notifyObservers(
      null,
      "ai-pane-visibility-changed",
      String(visible)
    );
  },
};
