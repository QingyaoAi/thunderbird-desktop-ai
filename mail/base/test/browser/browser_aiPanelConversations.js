/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The AI panel's conversations, with its own model answering: what is asked
 * and answered is kept, a new conversation starts with nothing behind it, and
 * an earlier one can be read again and carried on -- with what was said in it
 * going to the model with the next question. The model is a stand-in served
 * from this test, and the mail search finds nothing, so that only the
 * conversation is in play.
 */

const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);
const { AIConfig } = ChromeUtils.importESModule(
  "resource:///modules/AIConfig.sys.mjs"
);
const { AIConversations } = ChromeUtils.importESModule(
  "resource:///modules/AIConversations.sys.mjs"
);
const { AIMailContext } = ChromeUtils.importESModule(
  "resource:///modules/AIMailContext.sys.mjs"
);
const { AIFormat } = ChromeUtils.importESModule(
  "resource:///modules/AIProvider.sys.mjs"
);

const tabmail = document.getElementById("tabmail");
const about3Pane = tabmail.currentAbout3Pane;
const doc = about3Pane.document;

const PROFILE = "stand-in-model";

let AIPanel, server;

/** Every request the stand-in was sent, streamed or not. */
const requests = [];

/** @returns {object[]} The streamed requests: the questions themselves. */
function questions() {
  return requests.filter(request => request.stream);
}

/**
 * Ask a question, and wait for its answer.
 *
 * @param {string} text
 * @returns {Promise<HTMLElement>} The answer's turn.
 */
async function ask(text) {
  const before = doc.querySelectorAll(".ai-turn-assistant .ai-answer").length;
  AIPanel.input.focus();
  AIPanel.input.value = text;
  EventUtils.synthesizeKey("KEY_Enter", {}, about3Pane);
  await TestUtils.waitForCondition(
    () =>
      doc.querySelectorAll(".ai-turn-assistant .ai-answer").length > before &&
      !AIPanel._abort,
    `"${text}" is answered`
  );
  return [...doc.querySelectorAll(".ai-turn-assistant")].at(-1);
}

/**
 * @param {HTMLElement} element
 */
function click(element) {
  element.scrollIntoView({ block: "center" });
  EventUtils.synthesizeMouseAtCenter(element, {}, about3Pane);
}

add_setup(async function () {
  server = new HttpServer();
  server.registerPathHandler("/v1/chat/completions", (request, response) => {
    const stream = request.bodyInputStream;
    const body = JSON.parse(
      NetUtil.readInputStreamToString(stream, stream.available(), {
        charset: "UTF-8",
      })
    );
    requests.push(body);
    if (!body.stream) {
      // Asked whether the search found enough to answer from.
      response.setHeader("Content-Type", "application/json");
      response.write(
        JSON.stringify({
          choices: [{ message: { content: "ENOUGH" }, finish_reason: "stop" }],
        })
      );
      return;
    }
    response.setHeader("Content-Type", "text/event-stream");
    const delta = value =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: value }] })}\n\n`
      );
    delta({ reasoning_content: "Thinking it over." });
    delta({ content: `Answer ${questions().length}` });
    response.write("data: [DONE]\n\n");
  });
  server.start(-1);

  // Nothing in the mail, so the model is asked with only the conversation.
  const searchMessages = AIMailContext.searchMessages;
  AIMailContext.searchMessages = async query => ({
    messages: [],
    usedQuery: query,
  });

  // The panel's own model answers here, not dsh.
  Services.prefs.setBoolPref("mail.ai.dsh.on", false);
  await AIConfig.addProfile({
    name: PROFILE,
    format: AIFormat.OPENAI,
    baseUrl: `http://localhost:${server.identity.primaryPort}/v1`,
    model: "stand-in",
  });
  await AIConfig.setApiKey(PROFILE, "not-a-real-key");

  await about3Pane.AIPanelUI.toggle(true);
  AIPanel = about3Pane.AIPanel;
  await AIPanel.dsh.restore();
  await AIPanel.refreshProfiles();
  await AIPanel.refreshConfigured();
  await AIPanel.newConversation();

  registerCleanupFunction(async () => {
    await AIPanel.newConversation();
    AIMailContext.searchMessages = searchMessages;
    await AIConfig.removeProfile(PROFILE);
    Services.prefs.clearUserPref("mail.ai.dsh.on");
    await AIPanel.dsh.restore();
    await AIPanel.refreshProfiles();
    await AIPanel.refreshConfigured();
    await IOUtils.remove(
      PathUtils.join(PathUtils.profileDir, "ai-conversations"),
      { recursive: true, ignoreAbsent: true }
    );
    await new Promise(resolve => server.stop(resolve));
  });
});

add_task(async function testTheModelPickerIsUnderTheComposer() {
  Assert.ok(
    BrowserTestUtils.isVisible(AIPanel.modelPicker),
    "the model in use is shown"
  );
  Assert.ok(
    AIPanel.modelPicker.closest(".ai-panel-footer"),
    "under the composer"
  );
  Assert.ok(
    !doc.querySelector(".ai-panel-header select"),
    "and the header has no picker in it"
  );
  Assert.equal(AIPanel.modelPicker.value, PROFILE);
});

add_task(async function testAnExchangeIsKept() {
  const turn = await ask("budget meeting");
  Assert.equal(turn.querySelector(".ai-answer").textContent, "Answer 1");

  const conversation = AIPanel.conversation;
  Assert.equal(conversation.title, "budget meeting", "named for the question");
  Assert.equal(
    doc.getElementById("ai-panel-conversation-title").textContent,
    "budget meeting",
    "which the header shows"
  );

  const kept = await TestUtils.waitForCondition(
    async () => (await AIConversations.load(conversation.id))?.messages.length,
    "the exchange is kept"
  ).then(() => AIConversations.load(conversation.id));
  Assert.deepEqual(
    kept.messages,
    [
      { role: "user", content: "budget meeting" },
      { role: "assistant", content: "Answer 1" },
    ],
    "what the model is to be sent next time"
  );
  Assert.deepEqual(kept.turns[0], { role: "user", text: "budget meeting" });
  Assert.deepEqual(
    kept.turns[1].parts.map(part => part.type),
    ["notice", "thinking", "answer"],
    "and what was shown, in the order it was"
  );
  Assert.equal(kept.turns[1].parts[2].text, "Answer 1");
  Assert.equal(kept.dsh, null, "dsh did not answer in it");
});

add_task(async function testANewConversationStartsAfresh() {
  click(doc.getElementById("ai-panel-new"));
  Assert.ok(!doc.querySelector(".ai-turn"), "the transcript is empty");
  Assert.equal(AIPanel.conversation, null);

  await ask("another thing");
  const sent = questions().at(-1).messages;
  Assert.deepEqual(
    sent.map(message => message.role),
    ["system", "user"],
    "the model is sent the new question alone"
  );
  Assert.stringContains(sent[1].content, "another thing");
});

add_task(async function testCarryingOnAnEarlierConversation() {
  await TestUtils.waitForCondition(
    async () => (await AIConversations.list()).length == 2,
    "both conversations are kept"
  );
  click(AIPanel.historyButton);
  Assert.ok(
    BrowserTestUtils.isHidden(AIPanel.transcript),
    "the list takes the conversation's place"
  );
  await TestUtils.waitForCondition(
    () => doc.querySelectorAll(".ai-history-item").length == 2,
    "and lists them"
  );
  const items = [...doc.querySelectorAll(".ai-history-item")];
  Assert.deepEqual(
    items.map(item => item.querySelector(".ai-history-title").textContent),
    ["another thing", "budget meeting"],
    "latest first"
  );
  Assert.equal(
    items[0].getAttribute("aria-current"),
    "true",
    "with the one shown marked"
  );

  click(items[1].querySelector(".ai-history-open"));
  await TestUtils.waitForCondition(
    () => AIPanel.conversation?.title == "budget meeting",
    "the earlier conversation is open"
  );
  Assert.ok(BrowserTestUtils.isHidden(AIPanel.historyList), "the list closes");
  Assert.deepEqual(
    [...doc.querySelectorAll(".ai-turn-user")].map(turn => turn.textContent),
    ["budget meeting"],
    "its question is shown again"
  );
  const answer = doc.querySelector(".ai-turn-assistant");
  Assert.equal(answer.querySelector(".ai-answer").textContent, "Answer 1");
  Assert.ok(
    !answer.querySelector(".ai-thinking").open,
    "with its reasoning folded away"
  );
  Assert.ok(
    answer.querySelector(".ai-notice"),
    "and the note that the mail had nothing"
  );

  const turn = await ask("follow up");
  Assert.equal(turn.querySelector(".ai-answer").textContent, "Answer 3");
  const sent = questions().at(-1).messages;
  Assert.deepEqual(
    sent.map(message => message.role),
    ["system", "user", "assistant", "user"],
    "the model is sent what was said before"
  );
  Assert.equal(sent[1].content, "budget meeting");
  Assert.equal(sent[2].content, "Answer 1");
  Assert.stringContains(sent[3].content, "follow up");

  await TestUtils.waitForCondition(
    async () =>
      (await AIConversations.load(AIPanel.conversation.id))?.turns.length == 4,
    "the conversation is kept with its new exchange"
  );
  Assert.equal(
    (await AIConversations.list())[0].title,
    "budget meeting",
    "and is now the latest"
  );
});
