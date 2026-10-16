/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The AI panel's dsh mode, driven through the panel the way it is used: on
 * from the start and started by the first prompt, which goes with the message
 * that is open; a permission to answer, stopping, the model picker, a new
 * conversation in a new session, an earlier one carried on in its own session,
 * deleting one, and the button that turns it off and on. dsh itself is
 * replaced by a stand-in (FakeAcpAgent.sys.mjs).
 */

const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { MailMcpServer, MailMcpTokens } = ChromeUtils.importESModule(
  "resource:///modules/MailMcpServer.sys.mjs"
);
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { writeFakeAcpAgent } = ChromeUtils.importESModule(
  "resource://testing-common/FakeAcpAgent.sys.mjs"
);
const { PromptTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromptTestUtils.sys.mjs"
);
const { AIConversations } = ChromeUtils.importESModule(
  "resource:///modules/AIConversations.sys.mjs"
);
const { DshSessions } = ChromeUtils.importESModule(
  "resource:///modules/DshAgent.sys.mjs"
);

const tabmail = document.getElementById("tabmail");
const about3Pane = tabmail.currentAbout3Pane;
const doc = about3Pane.document;

let AIPanel, scratch, folder, fakeDsh;

/**
 * @returns {HTMLElement} The last assistant turn in the transcript.
 */
function lastAnswerTurn() {
  return [...doc.querySelectorAll(".ai-turn-assistant")].at(-1);
}

/**
 * Type into the panel and send it with Enter.
 *
 * @param {string} text
 */
function send(text) {
  AIPanel.input.focus();
  AIPanel.input.value = text;
  EventUtils.synthesizeKey("KEY_Enter", {}, about3Pane);
}

/**
 * @param {HTMLElement} element
 */
function click(element) {
  // The transcript scrolls, and a click lands wherever the middle of the
  // element is on screen -- which, for one scrolled out of view, is on
  // something else.
  element.scrollIntoView({ block: "center" });
  // The middle of its first box: a link that wraps onto a second line has
  // nothing of it in the middle of its bounding box.
  const box = element.getClientRects()[0];
  EventUtils.synthesizeMouseAtPoint(
    box.left + box.width / 2,
    box.top + box.height / 2,
    {},
    about3Pane
  );
}

/**
 * Wait until every button in a row has its label: they are filled in by the
 * localisation system, and until then have nothing to click.
 *
 * @param {HTMLElement} row
 */
async function labelled(row) {
  await TestUtils.waitForCondition(
    () => [...row.children].every(button => button.textContent),
    "the buttons are labelled"
  );
}

/**
 * Answer the permission dsh asks for with "Allow all this session", which
 * lasts as long as this run of it.
 */
async function allowEverything() {
  const buttons = await TestUtils.waitForCondition(
    () => doc.querySelector(".ai-dsh-permission-buttons"),
    "dsh asks before using its tool"
  );
  await labelled(buttons);
  click(buttons.lastElementChild);
}

async function waitForTurnToEnd() {
  await TestUtils.waitForCondition(
    () => !AIPanel.dsh.busy,
    "the turn should end"
  );
}

add_setup(async function () {
  const python = await Subprocess.pathSearch("python3");
  scratch = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "dshpanel");
  fakeDsh = await writeFakeAcpAgent(scratch);

  Services.prefs.setBoolPref("mail.mcp.enabled", true);
  Services.prefs.setStringPref("mail.ai.dsh.node", python);
  Services.prefs.setStringPref("mail.ai.dsh.path", fakeDsh);
  Services.prefs.setStringPref(
    "mail.ai.dsh.workspace",
    PathUtils.join(scratch, "work")
  );

  const account = MailServices.accounts.createLocalMailAccount();
  const rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  folder = rootFolder
    .createLocalSubfolder("aiPanelDsh")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  folder.addMessage(new MessageGenerator().makeMessage().toMessageString());

  about3Pane.restoreState({
    folderURI: folder.URI,
    messagePaneVisible: true,
  });
  about3Pane.threadTree.selectedIndex = 0;
  await messageLoadedIn(about3Pane.messageBrowser);

  await about3Pane.AIPanelUI.toggle(true);
  AIPanel = about3Pane.AIPanel;
  // The panel opened before there were these settings, with whatever dsh
  // this machine has, or none. Have it look again now.
  await AIPanel.dsh.restore();

  registerCleanupFunction(async () => {
    await AIPanel.dsh.stop();
    for (const pref of [
      "mail.ai.dsh.node",
      "mail.ai.dsh.path",
      "mail.ai.dsh.workspace",
      "mail.ai.dsh.on",
      "mail.mcp.enabled",
    ]) {
      Services.prefs.clearUserPref(pref);
    }
    // Back to what the panel opens as here, for whatever runs next.
    await AIPanel.dsh.restore();
    await AIPanel.newConversation();
    await IOUtils.remove(
      PathUtils.join(PathUtils.profileDir, "ai-conversations"),
      { recursive: true, ignoreAbsent: true }
    );
    MailMcpServer.stop();
    MailServices.accounts.removeAccount(account, false);
    await IOUtils.remove(scratch, { recursive: true });
  });
});

add_task(async function testWithoutDshThePanelIsAsItWas() {
  // Nowhere, as for someone who has never installed dsh.
  Services.prefs.setStringPref(
    "mail.ai.dsh.path",
    PathUtils.join(scratch, "nowhere")
  );
  await AIPanel.dsh.restore();
  Assert.equal(AIPanel.dsh.state, "off", "the panel's own model answers");
  Assert.equal(
    doc.getElementById("ai-panel-dsh").getAttribute("aria-pressed"),
    "false"
  );
  Assert.ok(
    BrowserTestUtils.isVisible(AIPanel.modelPicker),
    "with its model picker, as before there was dsh"
  );
  Assert.ok(
    AIPanel.modelPicker.closest(".ai-panel-footer"),
    "under the composer rather than in the header"
  );
  Assert.ok(!AIPanel.dsh.agent, "and nothing has been started");

  Services.prefs.setStringPref("mail.ai.dsh.path", fakeDsh);
  await AIPanel.dsh.restore();
});

add_task(async function testOnFromTheStart() {
  Assert.equal(AIPanel.dsh.state, "ready", "dsh is what answers");
  Assert.equal(
    doc.getElementById("ai-panel-dsh").getAttribute("aria-pressed"),
    "true",
    "and its button says so"
  );
  Assert.ok(!AIPanel.dsh.agent, "but nothing runs until something is sent");
  Assert.ok(
    BrowserTestUtils.isHidden(AIPanel.modelPicker),
    "the panel's own model picker makes way"
  );
  Assert.ok(
    BrowserTestUtils.isHidden(doc.getElementById("ai-panel-dsh-model")),
    "and dsh's waits for dsh"
  );
  Assert.ok(
    BrowserTestUtils.isVisible(AIPanel.form),
    "the composer is there, whether or not the panel's model is set up"
  );
});

add_task(async function testWhenTheFirstPromptCannotStartIt() {
  // There, so dsh is still what answers, but not something that can be run.
  const broken = PathUtils.join(scratch, "not-a-program");
  await IOUtils.writeUTF8(broken, "nothing to run\n");
  Services.prefs.setStringPref("mail.ai.dsh.path", broken);

  send("hello");
  await TestUtils.waitForCondition(
    () => doc.querySelector(".ai-error .ai-dsh-stderr"),
    "the reason is shown"
  );
  await waitForTurnToEnd();
  Assert.equal(AIPanel.dsh.state, "ready", "dsh still answers, to try again");
  Assert.ok(
    BrowserTestUtils.isVisible(AIPanel.sendButton),
    "and the composer is ready to"
  );
  Assert.ok(!lastAnswerTurn(), "with no answer left waiting");

  Services.prefs.setStringPref("mail.ai.dsh.path", fakeDsh);
  AIPanel.transcript.replaceChildren();
});

add_task(async function testTheFirstPromptStartsIt() {
  send("hello");

  const allow = await TestUtils.waitForCondition(
    () => doc.querySelector(".ai-dsh-permission-buttons button"),
    "dsh should ask before using its tool"
  );
  Assert.equal(AIPanel.dsh.state, "on", "sending is what started dsh");
  const dshModels = doc.getElementById("ai-panel-dsh-model");
  Assert.ok(BrowserTestUtils.isVisible(dshModels), "whose models are offered");
  Assert.equal(dshModels.value, "deepseek/v4");
  const group = dshModels.querySelector("optgroup");
  await TestUtils.waitForCondition(() => group.label, "the group is named");
  Assert.equal(group.label, "DSH DeepSeek", "as dsh's, not the panel's own");

  await labelled(allow.parentNode);
  Assert.equal(allow.textContent, "Allow once");
  click(allow);
  await waitForTurnToEnd();

  const turn = lastAnswerTurn();
  Assert.ok(
    turn.previousElementSibling.classList.contains("ai-notice"),
    "the answer comes after the notice that dsh is on"
  );
  const tool = turn.querySelector(".ai-dsh-tool");
  Assert.equal(
    tool.querySelector(".ai-dsh-tool-name").textContent,
    "list_tags",
    "a mail tool is shown by its own name"
  );
  Assert.equal(tool.dataset.status, "completed");
  Assert.equal(
    turn.querySelector(".ai-dsh-tool-output").textContent,
    "3 tags",
    "what the tool gave back is there to look at"
  );
  Assert.ok(
    !turn.querySelector(".ai-thinking").open,
    "the reasoning is folded away once the answer arrives"
  );

  const report = JSON.parse(turn.querySelector(".ai-answer").textContent);
  Assert.equal(report.said, "hello");
  Assert.equal(report.permission, "allow-once");
  const open = [...folder.messages][0];
  Assert.deepEqual(
    report.links,
    [folder.getUriForMsg(open)],
    "the open message goes with the prompt"
  );
  Assert.deepEqual(
    report.names,
    [
      `the message open in Thunderbird: "${open.mime2DecodedSubject}", ` +
        `from ${open.mime2DecodedAuthor}, ` +
        new Date(open.date / 1000).toISOString(),
    ],
    "named for what it is, so dsh can tell whether it was what was asked about"
  );
  Assert.equal(doc.activeElement, AIPanel.input, "the composer is ready again");
});

add_task(async function testAllowingEverything() {
  send("again");
  const buttons = await TestUtils.waitForCondition(
    () => doc.querySelector(".ai-dsh-permission-buttons"),
    "asked again"
  );
  await labelled(buttons);
  Assert.equal(buttons.lastElementChild.textContent, "Allow all this session");
  click(buttons.lastElementChild);
  await waitForTurnToEnd();

  const asked = doc.querySelectorAll(".ai-dsh-permission").length;
  send("and again");
  await waitForTurnToEnd();
  Assert.equal(
    doc.querySelectorAll(".ai-dsh-permission").length,
    asked,
    "after allowing all, nothing more is asked this session"
  );
  const report = JSON.parse(
    lastAnswerTurn().querySelector(".ai-answer").textContent
  );
  Assert.equal(report.permission, "allow-once");
});

add_task(async function testStop() {
  send("wait");
  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isVisible(AIPanel.stopButton),
    "the stop button appears"
  );
  click(AIPanel.stopButton);
  await waitForTurnToEnd();
  Assert.ok(
    lastAnswerTurn().querySelector(".ai-notice"),
    "the turn says it was stopped"
  );
  Assert.ok(BrowserTestUtils.isVisible(AIPanel.sendButton));
});

add_task(async function testChangingTheModel() {
  const dshModels = doc.getElementById("ai-panel-dsh-model");
  dshModels.value = "deepseek/v4-pro";
  dshModels.dispatchEvent(new Event("change"));
  await TestUtils.waitForCondition(
    () => AIPanel.dsh.agent.configOptions[0].currentValue == "deepseek/v4-pro",
    "dsh takes the new model"
  );
  Assert.equal(dshModels.value, "deepseek/v4-pro");
});

add_task(async function testANewConversation() {
  const first = AIPanel.conversation;
  Assert.ok(first, "what has been asked so far is a conversation");
  Assert.equal(first.title, "hello", "named for its first question");
  Assert.equal(
    doc.getElementById("ai-panel-conversation-title").textContent,
    "hello",
    "which the header shows"
  );
  Assert.equal(
    first.dsh?.sessionId,
    AIPanel.dsh.agent.sessionId,
    "and which knows the dsh session it was answered in"
  );

  const before = AIPanel.dsh.agent;
  click(doc.getElementById("ai-panel-new"));
  await TestUtils.waitForCondition(
    () => AIPanel.dsh.state == "on" && AIPanel.dsh.agent != before,
    "a new run is started"
  );
  Assert.ok(!before.running, "and the old one stopped");
  Assert.ok(!AIPanel.dsh.agent.resumed, "in a new session");
  Assert.ok(
    !doc.querySelector(".ai-turn"),
    "with nothing left of the conversation on screen"
  );
  Assert.equal(AIPanel.conversation, null);
  Assert.ok(
    BrowserTestUtils.isVisible(doc.getElementById("ai-panel-conversation-new")),
    "the header says it is a new one"
  );
  Assert.ok(
    BrowserTestUtils.isVisible(doc.getElementById("ai-panel-dsh-model")),
    "with dsh's models still offered"
  );
});

add_task(async function testAnUnusedSessionIsNotKept() {
  const unused = AIPanel.dsh.agent.sessionId;
  Assert.ok(
    (await DshSessions.list()).some(session => session.id == unused),
    "the new session is on record"
  );
  const before = AIPanel.dsh.agent;
  click(doc.getElementById("ai-panel-new"));
  await TestUtils.waitForCondition(
    () => AIPanel.dsh.state == "on" && AIPanel.dsh.agent != before,
    "another run is started"
  );
  await TestUtils.waitForCondition(
    async () => !(await DshSessions.list()).some(s => s.id == unused),
    "and the session nothing was asked in is deleted as it is left"
  );
});

add_task(async function testCarryingOnAnEarlierConversation() {
  const [entry, ...others] = await AIConversations.list();
  Assert.equal(entry.title, "hello", "the first conversation is kept");
  Assert.equal(others.length, 0, "and the empty ones are not");

  click(AIPanel.historyButton);
  Assert.ok(BrowserTestUtils.isHidden(AIPanel.transcript), "in its place");
  const item = await TestUtils.waitForCondition(
    () => doc.querySelector(".ai-history-item"),
    "the earlier conversations are listed"
  );
  Assert.equal(item.querySelector(".ai-history-title").textContent, "hello");

  const before = AIPanel.dsh.agent;
  click(item.querySelector(".ai-history-open"));
  await TestUtils.waitForCondition(
    () => AIPanel.dsh.state == "on" && AIPanel.dsh.agent != before,
    "dsh is started again"
  );
  Assert.ok(AIPanel.dsh.agent.resumed, "reopening the session it was in");
  Assert.equal(AIPanel.dsh.agent.sessionId, entry.dsh.sessionId);
  Assert.ok(BrowserTestUtils.isHidden(AIPanel.historyList), "the list closes");
  Assert.equal(AIPanel.conversation.id, entry.id);

  Assert.deepEqual(
    [...doc.querySelectorAll(".ai-turn-user")].map(turn => turn.textContent),
    ["hello", "hello", "again", "and again", "wait"],
    "what was asked is shown again"
  );
  const answers = doc.querySelectorAll(".ai-turn-assistant");
  Assert.equal(
    answers.length,
    4,
    "with an answer to each that dsh was there for"
  );
  const firstAnswer = answers[0];
  Assert.equal(
    firstAnswer.querySelector(".ai-dsh-tool-name").textContent,
    "list_tags",
    "the tools it used"
  );
  Assert.equal(
    firstAnswer.querySelector(".ai-dsh-tool").dataset.status,
    "completed"
  );
  Assert.equal(
    firstAnswer.querySelector(".ai-dsh-tool-output").textContent,
    "3 tags",
    "and what they gave back"
  );
  Assert.ok(
    !firstAnswer.querySelector(".ai-thinking").open,
    "its reasoning, folded"
  );
  Assert.equal(
    JSON.parse(firstAnswer.querySelector(".ai-answer").textContent).said,
    "hello",
    "and its answer"
  );
  Assert.ok(
    answers[3].querySelector(".ai-notice"),
    "the one that was stopped says so"
  );

  send("and then?");
  // Asked again: what was allowed was allowed for the run before.
  await allowEverything();
  await waitForTurnToEnd();
  const report = JSON.parse(
    lastAnswerTurn().querySelector(".ai-answer").textContent
  );
  Assert.equal(
    report.session,
    entry.dsh.sessionId,
    "what is asked now goes on in the same session"
  );
  Assert.ok(report.resumed);
});

add_task(async function testWhenTheSessionCannotBeReopened() {
  // As though dsh had lost it.
  const conversation = AIPanel.conversation;
  const saved = conversation.dsh;
  conversation.dsh = { ...saved, sessionId: "gone" };
  await AIPanel.dsh.restart();
  Assert.ok(!AIPanel.dsh.agent.resumed);
  await TestUtils.waitForCondition(
    () =>
      [...doc.querySelectorAll(".ai-notice")].some(notice =>
        notice.textContent.includes("could not reopen")
      ),
    "the panel says it could not be carried on in dsh"
  );
  send("still there?");
  await allowEverything();
  await waitForTurnToEnd();
  Assert.equal(
    conversation.dsh.sessionId,
    AIPanel.dsh.agent.sessionId,
    "the conversation goes on in the new session"
  );
  // Back to the one it was in, for what follows.
  conversation.dsh = saved;
  await AIPanel.dsh.restart();
  Assert.ok(AIPanel.dsh.agent.resumed);
});

add_task(async function testMessageLinks() {
  const message = [...folder.messages][0];
  send("link");
  await waitForTurnToEnd();
  const links = lastAnswerTurn().querySelectorAll("a.ai-message-link");
  Assert.equal(links.length, 2, "both messages are linked");
  Assert.equal(
    links[0].textContent,
    "the [open] message",
    "a link's text may have brackets in it"
  );

  about3Pane.threadTree.selectedIndex = -1;
  await TestUtils.waitForCondition(
    () => !about3Pane.gDBView.numSelected,
    "nothing is selected"
  );
  click(links[0]);
  await TestUtils.waitForCondition(
    () =>
      about3Pane.gDBView.numSelected == 1 &&
      about3Pane.gDBView.hdrForFirstSelectedMessage.messageKey ==
        message.messageKey,
    "clicking the link shows its message"
  );

  click(links[1]);
  await TestUtils.waitForCondition(
    () => links[1].classList.contains("ai-message-link-missing"),
    "a link to a message that is not there says so"
  );
  await TestUtils.waitForCondition(() => links[1].title, "with a reason");
});

add_task(async function testUnlinkedMentions() {
  send("mention");
  await waitForTurnToEnd();
  const answer = lastAnswerTurn().querySelector(".ai-answer");
  const links = [...answer.querySelectorAll("a.ai-message-link")];
  Assert.equal(
    links.length,
    2,
    "the subject named without a link is linked, next to the one that was"
  );
  Assert.equal(links[0].textContent, "Budget review for the third quarter");
  Assert.equal(
    links[0].getAttribute("href"),
    folder.getUriForMsg([...folder.messages][0]),
    "to the message the tool returned it for"
  );
  Assert.ok(
    !answer.querySelector("a a"),
    "a subject already in a link is not linked again"
  );
  Assert.ok(
    ![...answer.querySelectorAll("a")].some(a => a.textContent == "Hi"),
    "a subject as short as a greeting is not taken for a mention"
  );
});

add_task(async function testDeletingAConversation() {
  const current = AIPanel.conversation;
  const session = current.dsh.sessionId;
  click(AIPanel.historyButton);
  const item = await TestUtils.waitForCondition(
    () => doc.querySelector(".ai-history-item[aria-current='true']"),
    "the conversation shown is marked in the list"
  );

  const asked = PromptTestUtils.waitForPrompt(window, {
    modalType: Ci.nsIPromptService.MODAL_TYPE_WINDOW,
    promptType: "confirm",
  });
  // Clicked from script: the button is drawn only while its row is pointed
  // at, and a synthesized pointer does not count as pointing.
  item.querySelector(".ai-history-delete").click();
  await PromptTestUtils.handlePrompt(await asked, { buttonNumClick: 0 });

  await TestUtils.waitForCondition(
    async () => !(await AIConversations.list()).some(e => e.id == current.id),
    "it is deleted"
  );
  Assert.equal(AIPanel.conversation, null, "a new one is begun in its place");
  Assert.notEqual(AIPanel.dsh.agent.sessionId, session);
  await TestUtils.waitForCondition(
    async () => !(await DshSessions.list()).some(s => s.id == session),
    "with the dsh session it was in"
  );
  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isVisible(AIPanel.historyEmpty),
    "and the list, still open, has nothing left in it"
  );
  await AIPanel.toggleHistory(false);
  Assert.ok(BrowserTestUtils.isVisible(AIPanel.transcript));
});

add_task(async function testTurningItOff() {
  const agent = AIPanel.dsh.agent;
  const token = agent._token;
  click(doc.getElementById("ai-panel-dsh"));
  await TestUtils.waitForCondition(
    () => !agent.running && !AIPanel.dsh.active,
    "dsh stops"
  );
  await TestUtils.waitForCondition(
    async () => !(await MailMcpTokens.verify(token)),
    "and can no longer reach the mailbox"
  );
  Assert.ok(
    BrowserTestUtils.isHidden(doc.getElementById("ai-panel-dsh-model"))
  );
  Assert.equal(
    doc.getElementById("ai-panel-dsh").getAttribute("aria-pressed"),
    "false"
  );

  Assert.ok(
    !Services.prefs.getBoolPref("mail.ai.dsh.on"),
    "that it was turned off is remembered"
  );
  await AIPanel.dsh.restore();
  Assert.equal(
    AIPanel.dsh.state,
    "off",
    "so the panel next opens with its own model answering"
  );
});

add_task(async function testWhenItCannotStart() {
  Services.prefs.setStringPref(
    "mail.ai.dsh.path",
    PathUtils.join(scratch, "nowhere")
  );
  click(doc.getElementById("ai-panel-dsh"));
  const failure = await TestUtils.waitForCondition(
    () => doc.querySelector(".ai-error .ai-dsh-stderr"),
    "the reason is shown"
  );
  Assert.stringContains(failure.textContent, "nowhere");
  Assert.ok(
    failure.parentNode.querySelector("button"),
    "with the way to fix it"
  );
  Assert.equal(AIPanel.dsh.state, "off");
  Assert.ok(
    !Services.prefs.getBoolPref("mail.ai.dsh.on"),
    "a start that failed is not remembered as on"
  );
  Services.prefs.setStringPref("mail.ai.dsh.path", fakeDsh);
});

add_task(async function testClearingSessions() {
  // A session of the stand-in's on record, where dsh would keep it, and a
  // conversation answered in it.
  const home = PathUtils.join(scratch, "dsh-home");
  const session = PathUtils.join(home, "sessions", "--work--", "s-planted");
  await IOUtils.makeDirectory(session, { createAncestors: true });
  Services.env.set("DSH_HOME", home);
  await DshSessions.remember("s-planted", PathUtils.join(scratch, "work"));
  const conversation = AIConversations.create("planted");
  conversation.dsh = { sessionId: "s-planted", workspace: "/work" };
  await AIConversations.save(conversation);

  const confirmed = PromptTestUtils.waitForPrompt(window, {
    modalType: Ci.nsIPromptService.MODAL_TYPE_WINDOW,
    promptType: "confirm",
  });
  const cleared = AIPanel.dsh.clearSessions();
  await PromptTestUtils.handlePrompt(await confirmed, { buttonNumClick: 0 });
  await cleared;

  Assert.ok(!(await IOUtils.exists(session)), "the session is deleted");
  Assert.equal(
    await AIConversations.load(conversation.id),
    null,
    "with its conversation"
  );
  await TestUtils.waitForCondition(
    () =>
      [...doc.querySelectorAll(".ai-notice")]
        .at(-1)
        ?.textContent.includes("Deleted 1 dsh session"),
    "and the panel says so"
  );
  Services.env.set("DSH_HOME", "");
});

add_task(async function testTurningItBackOn() {
  const button = doc.getElementById("ai-panel-dsh");
  Assert.equal(button.getAttribute("aria-pressed"), "false", "off to begin");

  click(button);
  await TestUtils.waitForCondition(
    () => AIPanel.dsh.state == "on",
    "the button starts dsh at once"
  );
  Assert.equal(button.getAttribute("aria-pressed"), "true");
  Assert.ok(
    BrowserTestUtils.isVisible(doc.getElementById("ai-panel-dsh-model")),
    "with its models"
  );
  Assert.ok(
    Services.prefs.getBoolPref("mail.ai.dsh.on"),
    "and that it was turned on is remembered too"
  );
});

add_task(function testRenderingLinks() {
  const { renderMarkdown } = ChromeUtils.importESModule(
    "chrome://messenger/content/ai-markdown.mjs"
  );
  const rendered = renderMarkdown(
    "[in Sent](<imap-message://me@example.com/Sent Items#7>) " +
      "[script](javascript:alert(1)) [web](https://example.com/)",
    doc
  );
  const anchors = [...rendered.querySelectorAll("a")];
  Assert.deepEqual(
    anchors.map(a => a.getAttribute("href")),
    ["imap-message://me@example.com/Sent Items#7", "https://example.com/"],
    "a message link may have spaces in it; a script link is not a link"
  );
  Assert.ok(anchors[0].classList.contains("ai-message-link"));
  Assert.ok(!anchors[1].classList.contains("ai-message-link"));

  const escaped = renderMarkdown(
    "See [\\[ARR\\] August timeline](<mailbox-message://nobody@Local%20Folders/Inbox#1>).",
    doc
  ).querySelector("a");
  Assert.equal(
    escaped?.textContent,
    "[ARR] August timeline",
    "brackets escaped the Markdown way show as brackets"
  );
});
