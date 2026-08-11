/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Finding the mail that answers a question, and packing it into a prompt.
 *
 * Retrieval is gloda's full-text search -- the same index behind Search
 * Messages -- so there is no second index to build or keep current. Message
 * bodies come from `indexedBodyText`, which gloda already extracted, so
 * assembling context costs a query rather than a MIME parse per message.
 *
 * Everything here is about what gets sent: the caller decides whether to
 * send it at all.
 */

// System modules run in the shared system global, which has no window and
// therefore no setTimeout; Timer.sys.mjs is where it comes from here.
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Gloda: "resource:///modules/gloda/GlodaPublic.sys.mjs",
  GlodaMsgSearcher: "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs",
  MailServices: "resource:///modules/MailServices.sys.mjs",
  MsgHdrToMimeMessage: "resource:///modules/gloda/MimeMessage.sys.mjs",
});

/**
 * Words that carry no retrieval signal. A question is phrased as a
 * question -- "who", "what did they say" -- and none of that appears in
 * the mail being looked for.
 */
const STOPWORDS = new Set(
  ("a about all also am an and any are as at be been but by can could did " +
    "do does for from had has have he her him his how i if in into is it " +
    "its me my of on or our out say said she should so some tell than that " +
    "the their them then there these they this those to too us was we were " +
    "what when where which who whom why will with would you your").split(" ")
);

/**
 * Turn a question into gloda search terms.
 *
 * Two things matter here, and both were learned by watching a real query
 * fail. Gloda ANDs its terms, so feeding it a whole sentence asks for mail
 * containing every word of the question, which essentially never matches --
 * hence OR at the call site. And question words dominate a sentence, so
 * they are dropped in favour of the words that actually name the subject.
 *
 * @param {string} question
 * @returns {string} Space separated terms, possibly empty.
 */
function searchTermsFor(question) {
  const terms = [];
  const seen = new Set();
  for (const raw of question.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []) {
    // Gloda ignores one- and two-character tokens for non-CJK anyway.
    if (raw.length < 3 || STOPWORDS.has(raw) || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    terms.push(raw);
  }
  // Nothing but stopwords: fall back to the question so we search for
  // something rather than silently returning nothing.
  return terms.length ? terms.join(" ") : question.trim();
}

/**
 * Run a gloda full-text search and resolve with the matching messages.
 *
 * Gloda's query API is listener-based and delivers results in batches, so
 * this collects them and resolves when the query completes.
 *
 * @param {string} query - Search terms.
 * @param {number} limit - Maximum messages to retrieve.
 * @returns {Promise<object[]>} Gloda message objects, most relevant first.
 */
function glodaSearch(query, limit, andTerms = true) {
  return new Promise((resolve, reject) => {
    let collected = [];
    // andTerms matches Search Messages, which requires every term. That is
    // the more precise search and the one the user compares this against;
    // gather() falls back to OR only when AND finds nothing.
    //
    // The searcher's own retrieval limit is a read-only pref-backed getter,
    // so the cap is applied to the ranked results instead of the query.
    const searcher = new lazy.GlodaMsgSearcher(null, query, andTerms);

    const listener = {
      onItemsAdded(items) {
        collected = collected.concat(items);
      },
      onItemsModified() {},
      onItemsRemoved() {},
      onQueryCompleted() {
        resolve(collected.slice(0, limit));
      },
    };

    try {
      searcher.getCollection(listener);
    } catch (ex) {
      reject(ex);
    }
  });
}

/**
 * Every message in a conversation, oldest first.
 *
 * A search hit points at one message, but the message that matched is
 * rarely the whole story -- the answer is often in the reply after it, or
 * in the question it was answering. Pulling the conversation gives both
 * the model and the reader the actual exchange.
 *
 * @param {object} conversation - A gloda conversation.
 * @returns {Promise<object[]>} Its messages, or [] if they cannot be read.
 */
function conversationMessages(conversation) {
  return new Promise(resolve => {
    let collected = [];
    let settled = false;
    const finish = messages => {
      if (!settled) {
        settled = true;
        resolve(messages);
      }
    };
    // Never let one unresponsive conversation stall the whole answer.
    const timer = setTimeout(() => finish(collected), 10000);

    try {
      conversation.getMessagesCollection({
        onItemsAdded(items) {
          collected = collected.concat(items);
        },
        onItemsModified() {},
        onItemsRemoved() {},
        onQueryCompleted() {
          clearTimeout(timer);
          finish(collected);
        },
      });
    } catch (ex) {
      clearTimeout(timer);
      console.warn("Could not read a conversation:", ex);
      finish([]);
    }
  });
}

/**
 * Strip a body down to something worth sending: no quoted replies, no
 * signature, no runs of blank lines. Quoted text is the single biggest
 * source of wasted context in mail, since every reply repeats the thread.
 *
 * @param {string} body
 * @param {number} maxChars
 * @returns {string}
 */
function condenseBody(body, maxChars) {
  if (!body) {
    return "";
  }
  const lines = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith(">")) {
      continue;
    }
    if (/^-- ?$/.test(line)) {
      break; // Signature delimiter: nothing below it is content.
    }
    // Collapse repeated blank lines rather than spending context on them.
    if (!line && !lines.at(-1)) {
      continue;
    }
    lines.push(line);
  }

  let text = lines.join("\n").trim();
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n[…truncated]";
  }
  return text;
}

/**
 * A person's name, falling back to their address.
 *
 * @param {object} identity - A gloda identity.
 * @returns {string}
 */
function displayName(identity) {
  return identity?.contact?.name || identity?.value || "unknown";
}

export const AIMailContext = {
  /**
   * Gather mail relevant to a question.
   *
   * @param {string} question
   * @param {object} [limits]
   * @param {number} [limits.maxMessages]
   * @param {number} [limits.maxCharsPerMessage]
   * @param {number} [limits.maxTotalChars]
   * @returns {Promise<{prompt: string, sources: object[], truncated: boolean}>}
   *   `prompt` is the context block to give the model, `sources` are the
   *   messages behind it (for citations), and `truncated` says whether the
   *   budget cut anything off.
   */
  async gather(question, limits = {}, searchQuery = null) {
    const query = searchQuery?.trim() || searchTermsFor(question);
    const { messages, usedQuery } = await this.searchMessages(query, limits);
    return {
      ...(await this.buildContext(messages, limits)),
      query: usedQuery,
    };
  },

  /**
   * Search the mail index for one query.
   *
   * @param {string} query
   * @param {object} [limits]
   * @returns {Promise<{messages: object[], usedQuery: string}>}
   */
  async searchMessages(query, limits = {}) {
    const maxMessages = limits.maxMessages ?? 12;
    try {
      // Precise first, exactly as Search Messages would do it. Only if that
      // finds nothing do we loosen to OR, which trades precision for the
      // chance of finding anything at all.
      let messages = await glodaSearch(query, maxMessages * 2, true);
      if (messages.length) {
        return { messages, usedQuery: query };
      }
      messages = await glodaSearch(query, maxMessages * 2, false);
      return { messages, usedQuery: `${query} (broadened)` };
    } catch (ex) {
      throw new Error(
        `Could not search your mail: ${ex.message}. ` +
          `Global search indexing may be disabled.`
      );
    }
  },

  /**
   * Pack messages into a prompt block within the context budget.
   *
   * Kept separate from searching so several rounds of retrieval can be
   * pooled and turned into one context, rather than the last round
   * discarding what earlier ones found.
   *
   * @param {object[]} messages - Gloda messages, most relevant first.
   * @param {object} [limits]
   * @returns {{prompt: string, sources: object[], truncated: boolean}}
   */
  async buildContext(messages, limits = {}) {
    const maxThreads = limits.maxThreads ?? 6;
    const maxCharsPerMessage = limits.maxCharsPerMessage ?? 2500;
    const maxTotalChars = limits.maxTotalChars ?? 60000;

    // Group the hits by conversation, keeping the order the search ranked
    // them in, so the best-matching thread is assembled first.
    const threads = [];
    const byConversation = new Map();
    for (const message of messages) {
      const id = message.conversationID ?? `msg-${message.id}`;
      let entry = byConversation.get(id);
      if (!entry) {
        entry = { id, conversation: message.conversation, hits: [] };
        byConversation.set(id, entry);
        threads.push(entry);
      }
      entry.hits.push(message);
    }

    const chosen = threads.slice(0, maxThreads);
    const sources = [];
    const blocks = [];
    let totalChars = 0;
    let truncated = threads.length > chosen.length;

    for (const entry of chosen) {
      // The whole exchange when it can be read, otherwise just the hits.
      let thread = entry.conversation
        ? await conversationMessages(entry.conversation)
        : [];
      if (!thread.length) {
        thread = entry.hits;
      }
      thread = thread
        .slice()
        .sort((a, b) => (a.date ?? 0) - (b.date ?? 0));

      const index = sources.length + 1;
      const parts = [];
      // Each message carries its own reference, so an answer can point at
      // the one it came from rather than at the conversation as a whole.
      const messages = [];
      for (const message of thread) {
        const body = condenseBody(
          message.indexedBodyText ?? "",
          maxCharsPerMessage
        );
        const date = message.date
          ? new Date(message.date).toISOString().slice(0, 16).replace("T", " ")
          : "unknown date";
        const ref = `${index}.${parts.length + 1}`;
        parts.push(
          `[${ref}] From: ${displayName(message.from)}  (${date})\n` +
            `${body || "(no readable text)"}`
        );
        messages.push({
          ref,
          from: displayName(message.from),
          date: message.date ?? null,
          uri: message.folderMessageURI ?? null,
        });
      }
      if (!parts.length) {
        continue;
      }
      const subject =
        thread[0]?.subject || entry.hits[0]?.subject || "(no subject)";
      const block =
        `[${index}] Thread: ${subject} (${parts.length} message` +
        `${parts.length == 1 ? "" : "s"})\n\n` +
        parts.join("\n\n  --  \n\n") +
        `\n`;

      // Always include the first thread, even if it is over budget on its
      // own: an answer from a truncated thread beats no answer at all.
      if (totalChars + block.length > maxTotalChars && blocks.length) {
        truncated = true;
        break;
      }
      totalChars += block.length;
      blocks.push(block);

      // Cite the thread, linking to the message that actually matched.
      const participants = [
        ...new Set(thread.map(m => displayName(m.from))),
      ];
      sources.push({
        index,
        subject,
        author:
          participants.length > 2
            ? `${participants[0]} and ${participants.length - 1} others`
            : participants.join(", "),
        date: thread.at(-1)?.date ?? null,
        messageCount: parts.length,
        messages,
        uri:
          entry.hits[0]?.folderMessageURI ??
          thread.at(-1)?.folderMessageURI ??
          null,
      });
    }

    return {
      prompt: blocks.join("\n===\n\n"),
      sources,
      truncated,
    };
  },

  /**
   * The prompt that decides whether another round of searching is worth it.
   *
   * The model sees what has been found so far -- senders and subjects only,
   * which is enough to judge relevance without paying to resend every body
   * -- and either accepts it or writes a better query. Showing it the
   * queries already tried stops it proposing the same one again.
   *
   * @param {string} question
   * @param {object[]} sources
   * @param {string[]} triedQueries
   * @returns {{system: string, content: string}}
   */
  assessPrompt(question, sources, triedQueries) {
    const found = sources.length
      ? sources.map(x => `- ${x.subject} (from ${x.author})`).join("\n")
      : "(nothing found)";
    return {
      system:
        `Decide if these emails can answer the question. Reply with only ` +
        `"ENOUGH" if they can, or a different 2-5 keyword search query if ` +
        `they cannot. Never repeat a query already tried. No explanation.`,
      content:
        `Question: ${question}\n\n` +
        `Tried: ${triedQueries.join(" | ")}\n\n` +
        `Found:\n${found}\n\nENOUGH or new query:`,
    };
  },

  /**
   * The prompt that turns a question into a mail search query.
   *
   * Search Messages matches literal words in mail, so a question asked in
   * natural language ("who told me about the deadline?") searches badly:
   * the words that carry the question carry no signal, and the words that
   * would appear in the mail are often not in the question at all. Asking
   * the model to write the query first is the same thing a person does
   * before typing into the search box.
   *
   * @param {string} question
   * @returns {{system: string, content: string}}
   */
  searchQueryPrompt(question) {
    return {
      system:
        `Turn the question into an email search query. Reply with only the ` +
        `query: 2-5 keywords that would literally appear in the emails. ` +
        `You may prefix one term with subject:, from:, to:, or body:. ` +
        `No explanation.`,
      content: `Question: ${question}\n\nSearch query:`,
    };
  },

  /**
   * Clean up whatever the model returned into something searchable.
   *
   * Models like to be helpful, so this strips the wrappers they add: code
   * fences, a leading "Search query:", trailing full stops.
   *
   * @param {string} text
   * @returns {string}
   */
  cleanSearchQuery(text) {
    let query = (text ?? "").trim();
    query = query.replace(/^```[a-z]*\s*/i, "").replace(/```$/, "");
    query = query.replace(/^(search\s+)?query\s*:\s*/i, "");
    query = query.split(/\r?\n/)[0].trim();
    query = query.replace(/[.\s]+$/, "");
    // Some replies come back as "a, b, c"; the search wants plain terms.
    query = query.replace(/\s*,\s*/g, " ");
    // A model that wrapped the whole query in quotes meant it as one
    // phrase only if there is nothing else alongside it.
    if (/^"[^"]+"$/.test(query) && !query.slice(1, -1).includes('"')) {
      return query;
    }
    return query.replace(/^["'`]+|["'`]+$/g, "").trim();
  },

  /**
   * The instruction that turns retrieved mail into a grounded answer.
   *
   * The emphasis on refusing to guess is deliberate: for mail, a confident
   * wrong answer is worse than "I couldn't find it", because the user has
   * no easy way to tell the two apart.
   *
   * @param {number} sourceCount
   * @returns {string}
   */
  systemPrompt(sourceCount) {
    return (
      `You answer questions about the user's email. You have been given ` +
      `${sourceCount} conversation(s) from their mailbox, each numbered. ` +
      `A conversation contains every message in that thread in order, so ` +
      `read the exchange as a whole rather than any one message.\n\n` +
      `Rules:\n` +
      `- Answer only from the messages provided. Do not use outside ` +
      `knowledge about the user's affairs.\n` +
      `- Cite what you used inline. Each conversation is numbered [1], [2], ` +
      `and each message within one is numbered [1.1], [1.2] and so on. ` +
      `Prefer the message-level reference, so the exact message you took ` +
      `the answer from can be opened.\n` +
      `- If the provided messages do not contain the answer, say so ` +
      `plainly and suggest what to search for instead. Never guess.\n` +
      `- Be concise. Quote exact wording only when it matters.`
    );
  },

  /**
   * Build the user-side prompt: the question plus its context.
   *
   * @param {string} question
   * @param {string} contextBlock
   * @returns {string}
   */
  userPrompt(question, contextBlock) {
    return (
      `Question: ${question}\n\n` +
      `Conversations from my mailbox:\n\n${contextBlock}`
    );
  },

  /**
   * The messages of one thread, oldest first, for drafting a reply.
   *
   * @param {nsIMsgDBHdr} hdr - Any message in the thread.
   * @param {number} [maxMessages]
   * @param {number} [maxCharsPerMessage]
   * @returns {{text: string, latest: nsIMsgDBHdr}} The conversation as text
   *   and the message a reply should respond to.
   */
  async threadForReply(hdr, maxMessages = 10, maxCharsPerMessage = 3000) {
    const thread = hdr.folder.msgDatabase.getThreadContainingMsgHdr(hdr);
    const headers = [];
    for (let i = 0; i < thread.numChildren; i++) {
      const child = thread.getChildHdrAt(i);
      if (child) {
        headers.push(child);
      }
    }
    headers.sort((a, b) => a.date - b.date);

    // Keep the most recent exchanges: the beginning of a long thread is
    // usually less relevant to what the reply must address.
    const kept = headers.slice(-maxMessages);
    const latest = headers.at(-1) ?? hdr;

    // Read the bodies in parallel; each is an async message load.
    const bodies = await Promise.all(
      kept.map(header => getMessageBodyText(header))
    );

    const parts = kept.map((header, index) => {
      const body = condenseBody(bodies[index], maxCharsPerMessage);
      const date = new Date(header.date / 1000)
        .toISOString()
        .slice(0, 16)
        .replace("T", " ");
      const recipients = [header.mime2DecodedRecipients, header.ccList]
        .filter(Boolean)
        .join(", ");
      return (
        `From: ${header.mime2DecodedAuthor}\n` +
        (recipients ? `To: ${recipients}\n` : "") +
        `Date: ${date}\n` +
        `Subject: ${header.mime2DecodedSubject}\n\n` +
        `${body || "(no readable text in this message)"}`
      );
    });

    return { text: parts.join("\n\n---\n\n"), latest };
  },
};

/**
 * Body text for a message, as plain text.
 *
 * Loading a message is asynchronous. An earlier version of this tried to
 * read it synchronously through nsISyncStreamListener, which always came
 * back with nothing -- so every message in a thread reached the model as
 * headers with an empty body, and replies were written from the subject
 * line alone.
 *
 * Downloads are allowed here, unlike in the message list preview: a reply
 * cannot be drafted at all without the text, and the user asked for this
 * one message explicitly.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {Promise<string>} The body, or "" if it could not be read.
 */
function getMessageBodyText(hdr) {
  return new Promise(resolve => {
    // Loading Gloda registers the MIME parsing machinery this relies on.
    void lazy.Gloda;

    let settled = false;
    const finish = text => {
      if (!settled) {
        settled = true;
        resolve(text);
      }
    };

    // A message that never streams (offline, gone, unreachable server)
    // must not leave the draft hanging forever.
    const timer = setTimeout(() => {
      console.warn("Timed out reading a message body for reply drafting.");
      finish("");
    }, 15000);

    try {
      lazy.MsgHdrToMimeMessage(
        hdr,
        null,
        (messageHeader, mimeMessage) => {
          clearTimeout(timer);
          if (!mimeMessage) {
            finish("");
            return;
          }
          try {
            finish(mimeMessage.coerceBodyToPlaintext(messageHeader.folder));
          } catch (ex) {
            console.warn("Could not convert a message body to text:", ex);
            finish("");
          }
        },
        true,
        { saneBodySize: true }
      );
    } catch (ex) {
      clearTimeout(timer);
      console.warn("Could not read a message body for reply drafting:", ex);
      finish("");
    }
  });
}
