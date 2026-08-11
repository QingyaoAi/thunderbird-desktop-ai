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
  AIProvider: "resource:///modules/AIProvider.sys.mjs",
  MailServices: "resource:///modules/MailServices.sys.mjs",
});

/** Keeps the transcript from growing without bound in a long session. */
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

export const AIPanel = {
  /** @type {?AbortController} Non-null while a request is in flight. */
  _abort: null,

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

    this.form.addEventListener("submit", event => {
      event.preventDefault();
      this.send();
    });
    this.draftButton = document.getElementById("ai-panel-draft-reply");

    this.stopButton.addEventListener("click", () => this.cancel());
    document
      .getElementById("ai-panel-clear")
      .addEventListener("click", () => this.clear());
    document
      .getElementById("ai-panel-close")
      .addEventListener("click", () => AIPanelUI.toggle(false));
    document
      .getElementById("ai-panel-key")
      .addEventListener("click", () => this.promptForApiKey());
    document
      .getElementById("ai-panel-setup-key")
      .addEventListener("click", () => this.promptForApiKey());
    this.draftButton.addEventListener("click", () => this.draftReply());

    // The draft button only makes sense with a message selected, and what
    // is selected changes as the user moves around the mail window.
    document.addEventListener("MsgLoaded", () => this.updateDraftButton());
    window.addEventListener("focus", () => this.updateDraftButton(), true);
    this.updateDraftButton();

    // Enter sends, Shift+Enter makes a new line -- the convention for this
    // kind of composer.
    this.input.addEventListener("keydown", event => {
      if (event.key == "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });

    await this.refreshConfigured();
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
    this._messages = [];
    this.transcript.replaceChildren();
  },

  /** Abort an in-flight request, if there is one. */
  cancel() {
    this._abort?.abort();
    this._abort = null;
    this._setBusy(false);
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
    this._abort = new AbortController();

    try {
      const options = await lazy.AIConfig.requestOptions();

      // Retrieve relevant mail for this question. Only the newest turn is
      // grounded: re-searching for every follow-up would send the mailbox
      // repeatedly, and the earlier context is still in the transcript.
      const grounded = await this._buildGroundedPrompt(question, answerBody);
      sources = grounded.sources ?? [];
      const sendMessages = [
        ...this._messages.slice(0, -1),
        { role: "user", content: grounded.content },
      ];

      const result = await lazy.AIProvider.chatStream({
        ...options,
        system: grounded.system,
        messages: sendMessages,
        signal: this._abort.signal,

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
      this._abort = null;
      this._setBusy(false);
      this.input.focus();
    }
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
    const byIndex = new Map(sources.map(source => [source.index, source]));
    linkifyCitations(
      container,
      document,
      number => byIndex.get(number)?.uri,
      number => {
        const source = byIndex.get(number);
        if (source?.uri) {
          this._showMessage(source.uri, source.subject);
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
      const hdr = lazy.MailServices
        .messageServiceFromURI(uri)
        .messageURIToMsgHdr(uri);
      if (typeof window.selectMessage == "function") {
        window.selectMessage(hdr);
        return;
      }
      // Not in the mail tab -- fall back to opening it outright.
      this._openMessage(uri);
    } catch (ex) {
      console.warn(`Could not show the cited message${subject ? ` "${subject}"` : ""}:`, ex);
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
   * Ask for an API key and store it in the login manager.
   *
   * Uses the password prompt so the key is masked as it is typed and never
   * ends up in a text field that could be screenshotted or logged.
   */
  async promptForApiKey() {
    const profile = await lazy.AIConfig.activeProfile();
    const [title, message] = await document.l10n.formatValues([
      { id: "ai-panel-key-title" },
      { id: "ai-panel-key-prompt", args: { provider: profile.label ?? profile.name } },
    ]);

    const value = { value: "" };
    const accepted = Services.prompt.promptPassword(
      window,
      title,
      message,
      value,
      null,
      {}
    );
    if (!accepted) {
      return;
    }

    await lazy.AIConfig.setApiKey(profile.name, value.value.trim());
    await this.refreshConfigured();
  },

  // -- mailbox questions --------------------------------------------------

  /**
   * Search the mailbox for context, and render what was used underneath the
   * answer so the user can check it.
   *
   * @param {string} question
   * @param {HTMLElement} answerBody - Where to attach the sources list.
   * @returns {Promise<{system: string, content: string, sources: object[]}>}
   *   The prompt pieces, plus the threads behind them so that citations
   *   in the answer can be linked back to the mail they came from.
   */
  async _buildGroundedPrompt(question, answerBody) {
    const config = await lazy.AIConfig.read();
    const context = await this._retrieve(question, answerBody, config);

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
   * @returns {Promise<{prompt: string, sources: object[], truncated: boolean, queries: string[]}>}
   */
  async _retrieve(question, answerBody, config) {
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
      query = await this._formulateSearchQuery(question);
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
      progress.step(
        added ? "ai-search-step-found" : "ai-search-step-none",
        { count: added }
      );

      if (round == MAX_RETRIEVAL_ROUNDS) {
        break;
      }

      // Judge what we have using only senders and subjects, which is
      // enough to spot irrelevance without resending every body.
      progress.step("ai-search-step-checking");
      const interim = await lazy.AIMailContext.buildContext(pooled, config.context);
      const next = await this._assessRetrieval(question, interim.sources, queries);
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
   * @returns {Promise<?string>} A new query, or null to stop searching.
   */
  async _assessRetrieval(question, sources, triedQueries) {
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
        signal: this._abort?.signal,
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
   * @returns {Promise<?string>} The query, or null to use the fallback.
   */
  async _formulateSearchQuery(question) {
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
        signal: this._abort?.signal,
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
      link.textContent = source.messageCount > 1
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
      const hdr = lazy.MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
      window.top.MsgOpenNewTabForMessages?.([hdr]) ??
        window.top.OpenMessageInNewTab?.(hdr, { background: false });
    } catch (ex) {
      console.error("Could not open cited message:", ex);
    }
  },

  // -- reply drafting -----------------------------------------------------

  /**
   * A message from the user's current selection, used as the way in to the
   * thread being replied to.
   *
   * Any non-empty selection counts. Clicking a collapsed thread selects
   * every message in it, which is the normal way to pick a conversation --
   * requiring exactly one selected message would refuse the common case.
   * threadForReply() walks out to the full thread from here anyway, so
   * which message it is matters less than which thread.
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

  updateDraftButton() {
    if (this.draftButton) {
      this.draftButton.disabled = !this._selectedMessage();
    }
  },

  /**
   * Draft a reply to the selected thread and open it in a compose window.
   *
   * It deliberately opens a compose window rather than saving to Drafts or
   * sending: the whole point is that you read it first.
   */
  async draftReply() {
    const hdr = this._selectedMessage();
    if (!hdr || this._abort) {
      return;
    }
    if (!(await this.refreshConfigured())) {
      return;
    }

    const answerBody = this._addTurn("assistant");
    answerBody.appendChild(this._notice("ai-panel-drafting"));

    this._setBusy(true);
    this._abort = new AbortController();

    try {
      const { text: thread, latest } =
        await lazy.AIMailContext.threadForReply(hdr);
      const identity =
        lazy.MailServices.accounts.getFirstIdentityForServer(hdr.folder.server) ??
        lazy.MailServices.accounts.defaultAccount?.defaultIdentity;

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
        signal: this._abort.signal,
        system:
          `You draft email replies as ${me}. Write only the body of the ` +
          `reply: no subject line, no "To:" header, no quoted original, ` +
          `and no commentary about what you wrote. Match the tone of the ` +
          `conversation. Be direct and concise. If the thread asks ` +
          `questions, answer them. If something genuinely cannot be ` +
          `answered without information you do not have, leave a clearly ` +
          `marked [TODO] for the user rather than inventing it.`,
        messages: [
          {
            role: "user",
            content:
              `Draft a reply to the most recent message in this thread.\n\n` +
              `${thread}`,
          },
        ],
      });

      this._openReplyCompose(latest, identity, result.text);
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
      this._abort = null;
      this._setBusy(false);
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
