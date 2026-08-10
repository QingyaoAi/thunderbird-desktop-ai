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
function glodaSearch(query, limit) {
  return new Promise((resolve, reject) => {
    let collected = [];
    // The third argument is andTerms: false makes this an OR search, so a
    // message matching some of the question's keywords still comes back,
    // ranked by how well it matches. AND would demand every keyword.
    //
    // The searcher's own retrieval limit is a read-only pref-backed getter,
    // so the cap is applied to the ranked results instead of the query.
    const searcher = new lazy.GlodaMsgSearcher(null, query, false);

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
  async gather(question, limits = {}) {
    const maxMessages = limits.maxMessages ?? 12;
    const maxCharsPerMessage = limits.maxCharsPerMessage ?? 4000;
    const maxTotalChars = limits.maxTotalChars ?? 60000;

    let messages;
    try {
      messages = await glodaSearch(searchTermsFor(question), maxMessages * 2);
    } catch (ex) {
      throw new Error(
        `Could not search your mail: ${ex.message}. ` +
          `Global search indexing may be disabled.`
      );
    }

    // One entry per conversation: a long thread would otherwise fill the
    // whole budget by itself, crowding out other threads that might hold
    // the actual answer.
    const seenConversations = new Set();
    const chosen = [];
    for (const message of messages) {
      const conversationId = message.conversationID ?? message.id;
      if (seenConversations.has(conversationId)) {
        continue;
      }
      seenConversations.add(conversationId);
      chosen.push(message);
      if (chosen.length >= maxMessages) {
        break;
      }
    }

    const sources = [];
    const blocks = [];
    let totalChars = 0;
    let truncated = messages.length > chosen.length;

    for (const message of chosen) {
      const body = condenseBody(
        message.indexedBodyText ?? "",
        maxCharsPerMessage
      );
      if (!body) {
        continue;
      }

      const index = sources.length + 1;
      const date = message.date ? new Date(message.date).toISOString().slice(0, 10) : "unknown date";
      const block =
        `[${index}] From: ${displayName(message.from)}\n` +
        `Date: ${date}\n` +
        `Subject: ${message.subject || "(no subject)"}\n` +
        `${body}\n`;

      if (totalChars + block.length > maxTotalChars) {
        truncated = true;
        break;
      }
      totalChars += block.length;
      blocks.push(block);

      sources.push({
        index,
        subject: message.subject || "(no subject)",
        author: displayName(message.from),
        date: message.date ?? null,
        uri: message.folderMessageURI ?? null,
      });
    }

    return {
      prompt: blocks.join("\n---\n"),
      sources,
      truncated,
    };
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
      `${sourceCount} message(s) from their mailbox, each numbered.\n\n` +
      `Rules:\n` +
      `- Answer only from the messages provided. Do not use outside ` +
      `knowledge about the user's affairs.\n` +
      `- Cite the messages you used as [1], [2], and so on, inline.\n` +
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
      `Messages from my mailbox:\n\n${contextBlock}`
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
