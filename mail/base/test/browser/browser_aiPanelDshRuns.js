/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * How long a run of dsh goes on. A conversation left while dsh is answering
 * in it: dsh goes on answering out of sight, the list says so, and the
 * conversation comes back as it was left -- or, once dsh is done, as it was
 * kept. Waiting on a permission, "allow all" staying with its own run, how
 * many may go on at once, and turning dsh off, deleting and clearing
 * sessions while one does. Then the runs that are stopped without being
 * asked to: dsh sitting idle in the conversation shown, and one left that
 * waits too long on a permission. dsh itself is replaced by a stand-in
 * (FakeAcpAgent.sys.mjs).
 */

const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { MailMcpServer } = ChromeUtils.importESModule(
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

let AIPanel, scratch;

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
  // element is on screen.
  element.scrollIntoView({ block: "center" });
  const box = element.getClientRects()[0];
  EventUtils.synthesizeMouseAtPoint(
    box.left + box.width / 2,
    box.top + box.height / 2,
    {},
    about3Pane
  );
}

/**
 * Wait until every button in a row has its label from the localisation
 * system: until then there is nothing to click.
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
 * @returns {Promise<HTMLElement>} The permission buttons dsh's tool asks with.
 */
async function permissionButtons() {
  const buttons = await TestUtils.waitForCondition(
    () => doc.querySelector(".ai-dsh-permission-buttons"),
    "dsh asks before using its tool"
  );
  await labelled(buttons);
  return buttons;
}

async function waitForTurnToEnd() {
  await TestUtils.waitForCondition(
    () => !AIPanel.dsh.busy,
    "the turn should end"
  );
}

/**
 * Send something, and wait until dsh is answering it.
 *
 * @param {string} text
 * @returns {Promise<{agent: object, conversation: object}>}
 */
async function ask(text) {
  send(text);
  await TestUtils.waitForCondition(
    () => AIPanel.dsh.agent && AIPanel.dsh.run.turn?.body,
    "dsh is answering"
  );
  return { agent: AIPanel.dsh.agent, conversation: AIPanel.conversation };
}

/**
 * Begin a new conversation with the button, which leaves the one shown at
 * once, and wait for dsh to be started for it.
 *
 * @returns {Promise<object>} The run started.
 */
async function beginAnother() {
  const before = AIPanel.dsh.agent;
  click(doc.getElementById("ai-panel-new"));
  await TestUtils.waitForCondition(
    () =>
      AIPanel.dsh.state == "on" &&
      AIPanel.dsh.agent &&
      AIPanel.dsh.agent != before,
    "dsh is started for the new conversation"
  );
  return AIPanel.dsh.agent;
}

/**
 * @param {string} id - A conversation's.
 * @returns {Promise<HTMLElement>} Its row in the list, which is opened.
 */
async function rowFor(id) {
  if (!AIPanel._historyOpen) {
    click(AIPanel.historyButton);
  }
  return TestUtils.waitForCondition(
    () => doc.querySelector(`.ai-history-item[data-conversation="${id}"]`),
    "the conversation is listed"
  );
}

/** Turn dsh off and on again, with a new conversation: as each task begins. */
async function reset() {
  await AIPanel.dsh.stop();
  await AIPanel.dsh.restore();
  await AIPanel.newConversation();
  await AIPanel.toggleHistory(false);
}

add_setup(async function () {
  const python = await Subprocess.pathSearch("python3");
  scratch = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "dshleft");
  const fakeDsh = await writeFakeAcpAgent(scratch);
  // Where deleting a session looks for it: not the dsh of whoever runs this.
  Services.env.set("DSH_HOME", PathUtils.join(scratch, "dsh-home"));

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
  const folder = rootFolder
    .createLocalSubfolder("aiPanelDshLeft")
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
  await AIPanel.dsh.restore();

  registerCleanupFunction(async () => {
    await AIPanel.dsh.stop();
    for (const pref of [
      "mail.ai.dsh.node",
      "mail.ai.dsh.path",
      "mail.ai.dsh.workspace",
      "mail.ai.dsh.on",
      "mail.ai.dsh.idleSeconds",
      "mail.ai.dsh.unansweredSeconds",
      "mail.mcp.enabled",
    ]) {
      Services.prefs.clearUserPref(pref);
    }
    await AIPanel.dsh.restore();
    await AIPanel.newConversation();
    await IOUtils.remove(
      PathUtils.join(PathUtils.profileDir, "ai-conversations"),
      { recursive: true, ignoreAbsent: true }
    );
    MailMcpServer.stop();
    Services.env.set("DSH_HOME", "");
    MailServices.accounts.removeAccount(account, false);
    await IOUtils.remove(scratch, { recursive: true });
  });
});

add_task(async function testItGoesOnOutOfSight() {
  const { agent, conversation } = await ask("slow");
  const mark = doc.getElementById("ai-panel-out-of-sight");
  Assert.ok(BrowserTestUtils.isHidden(mark), "nothing is out of sight yet");

  const started = beginAnother();
  Assert.equal(
    AIPanel.dsh.outOfSight().get(conversation.id),
    "answering",
    "the one left is being answered out of sight"
  );
  const next = await started;
  Assert.ok(agent.running, "dsh goes on in the conversation left");
  Assert.notEqual(next, agent, "and the new one has a run of its own");
  Assert.ok(!doc.querySelector(".ai-turn"), "nothing of it is on screen");
  Assert.ok(
    BrowserTestUtils.isVisible(AIPanel.sendButton),
    "and the new one can be asked something at once"
  );
  Assert.ok(BrowserTestUtils.isVisible(mark), "the header says one goes on");
  Assert.ok(!mark.classList.contains("waiting"));

  const row = await rowFor(conversation.id);
  const note = row.querySelector(".ai-history-status");
  Assert.ok(BrowserTestUtils.isVisible(note), "so does the list");
  await TestUtils.waitForCondition(
    () => note.textContent == "dsh is answering…",
    "in place of its date"
  );
  Assert.ok(BrowserTestUtils.isHidden(row.querySelector(".ai-history-date")));
  await AIPanel.toggleHistory(false);

  await TestUtils.waitForCondition(
    () => !AIPanel.dsh.outOfSight().size,
    "dsh finishes answering"
  );
  await TestUtils.waitForCondition(
    () => !agent.running,
    "and the run that answered is stopped"
  );
  Assert.ok(BrowserTestUtils.isHidden(mark), "the header no longer says so");
  Assert.ok(next.running, "the conversation shown keeps its own");

  await TestUtils.waitForCondition(async () => {
    const kept = await AIConversations.load(conversation.id);
    return kept?.turns
      .at(-1)
      .parts.some(part => part.type == "answer" && part.text == "done slowly");
  }, "the answer is kept with its conversation");

  click((await rowFor(conversation.id)).querySelector(".ai-history-open"));
  await TestUtils.waitForCondition(
    () => AIPanel.dsh.state == "on" && AIPanel.dsh.agent?.resumed,
    "opened again, it is carried on in its session"
  );
  Assert.equal(AIPanel.dsh.agent.sessionId, conversation.dsh.sessionId);
  Assert.equal(
    lastAnswerTurn().querySelector(".ai-answer").textContent,
    "done slowly",
    "showing what dsh answered while it was out of sight"
  );
  Assert.ok(
    lastAnswerTurn().querySelector(".ai-thinking-done"),
    "with its reasoning folded away"
  );
});

add_task(async function testComingBackToAPermission() {
  await reset();
  const { agent, conversation } = await ask("hello");
  await permissionButtons();

  const next = await beginAnother();
  Assert.equal(
    AIPanel.dsh.outOfSight().get(conversation.id),
    "waiting",
    "the one left waits on its permission"
  );
  const mark = doc.getElementById("ai-panel-out-of-sight");
  Assert.ok(mark.classList.contains("waiting"), "which the header shows");
  Assert.ok(
    (await AIConversations.list()).some(e => e.id == conversation.id),
    "it is kept, though its first answer is not done"
  );

  const row = await rowFor(conversation.id);
  const note = row.querySelector(".ai-history-status");
  await TestUtils.waitForCondition(
    () => note.textContent == "Waiting for you to allow a tool",
    "the list says what it waits for"
  );
  click(row.querySelector(".ai-history-open"));
  await TestUtils.waitForCondition(
    () => AIPanel.dsh.agent == agent,
    "it comes back with the run that is answering it, not a new one"
  );
  await TestUtils.waitForCondition(
    () => !next.running,
    "and the run of the conversation left unused is stopped"
  );
  Assert.equal(AIPanel.conversation, conversation);
  Assert.ok(AIPanel.dsh.busy, "still being answered");
  Assert.ok(BrowserTestUtils.isVisible(AIPanel.stopButton));
  Assert.ok(!AIPanel.dsh.outOfSight().size, "nothing is out of sight now");
  Assert.ok(BrowserTestUtils.isHidden(mark));

  const buttons = await permissionButtons();
  Assert.equal(buttons.firstElementChild.textContent, "Allow once");
  click(buttons.firstElementChild);
  await waitForTurnToEnd();
  const report = JSON.parse(
    lastAnswerTurn().querySelector(".ai-answer").textContent
  );
  Assert.equal(report.permission, "allow-once", "the answer reached dsh");
  Assert.equal(report.session, conversation.dsh.sessionId);
  Assert.ok(agent.running, "the run goes on, as the conversation shown's");
});

add_task(async function testAllowingAllIsOneRunsOwn() {
  await reset();
  // Asks only once the conversation has been left and everything allowed
  // in the next one.
  const { conversation } = await ask("later");
  await beginAnother();
  send("hello");
  const buttons = await permissionButtons();
  click(buttons.lastElementChild);
  await waitForTurnToEnd();
  Assert.ok(AIPanel.dsh.run.allowAll, "everything is allowed in this one");

  await TestUtils.waitForCondition(
    () => AIPanel.dsh.outOfSight().get(conversation.id) == "waiting",
    "and the one left still asks"
  );
});

add_task(async function testAsManyAsMayGoOn() {
  await reset();
  const first = await ask("wait");
  await beginAnother();
  const second = await ask("wait");
  await beginAnother();
  Assert.equal(AIPanel.dsh.outOfSight().size, 2, "two go on out of sight");

  const third = await ask("wait");
  await beginAnother();
  Assert.ok(
    !third.agent.running,
    "a third is stopped as it is left, as before they could go on"
  );
  Assert.deepEqual(
    [...AIPanel.dsh.outOfSight().keys()].sort(),
    [first.conversation.id, second.conversation.id].sort(),
    "the two before it go on"
  );
  await TestUtils.waitForCondition(
    () =>
      [...doc.querySelectorAll(".ai-notice")].some(notice =>
        notice.textContent.includes("stopped answering in the conversation")
      ),
    "and the panel says why the third was stopped"
  );
  Assert.ok(
    third.conversation.turns
      .at(-1)
      .parts.some(part => part.id == "ai-panel-stopped"),
    "which is recorded as stopped"
  );
});

add_task(async function testTurningItOffStopsThemAll() {
  // Still going from the last task.
  const ids = [...AIPanel.dsh.outOfSight().keys()];
  Assert.equal(ids.length, 2);
  const agents = ids.map(
    id =>
      [...AIPanel.dsh._background.values()].find(
        run => run.conversation.id == id
      ).agent
  );

  click(doc.getElementById("ai-panel-dsh"));
  await TestUtils.waitForCondition(
    () => !AIPanel.dsh.active && agents.every(agent => !agent.running),
    "turning dsh off stops it in the conversations left as well"
  );
  Assert.ok(!AIPanel.dsh.outOfSight().size);
  for (const id of ids) {
    await TestUtils.waitForCondition(async () => {
      const kept = await AIConversations.load(id);
      return kept?.turns.at(-1).parts.at(-1)?.id == "ai-panel-stopped";
    }, "each is kept as stopped");
  }
  click(doc.getElementById("ai-panel-dsh"));
  await TestUtils.waitForCondition(() => AIPanel.dsh.state == "on", "on again");
});

add_task(async function testDeletingOneThatGoesOn() {
  await reset();
  const left = await ask("wait");
  await beginAnother();
  const session = left.conversation.dsh.sessionId;

  // And the one shown, still being answered as it is deleted. Listed, as
  // something has been answered in it already.
  send("slow");
  await TestUtils.waitForCondition(() => AIPanel.dsh.busy, "asked");
  await waitForTurnToEnd();
  const shown = await ask("wait");
  const shownSession = shown.conversation.dsh.sessionId;

  for (const { agent, conversation } of [left, shown]) {
    const row = await rowFor(conversation.id);
    const asked = PromptTestUtils.waitForPrompt(window, {
      modalType: Ci.nsIPromptService.MODAL_TYPE_WINDOW,
      promptType: "confirm",
    });
    // Clicked from script: the button is drawn only while its row is
    // pointed at.
    row.querySelector(".ai-history-delete").click();
    await PromptTestUtils.handlePrompt(await asked, { buttonNumClick: 0 });
    await TestUtils.waitForCondition(
      async () =>
        !agent.running &&
        !(await AIConversations.list()).some(e => e.id == conversation.id),
      "dsh stops answering in it, and it is deleted"
    );
  }
  Assert.ok(!AIPanel.dsh.outOfSight().size, "nothing goes on in either");
  await TestUtils.waitForCondition(async () => {
    const ids = (await DshSessions.list()).map(s => s.id);
    return !ids.includes(session) && !ids.includes(shownSession);
  }, "with the sessions they were in");

  // Their prompts have settled by now, and saved what they had: that must
  // not have brought either back.
  const kept = (await AIConversations.list()).map(e => e.id);
  Assert.ok(!kept.includes(left.conversation.id));
  Assert.ok(!kept.includes(shown.conversation.id));
  await AIPanel.toggleHistory(false);
});

add_task(async function testClearingSessionsKeepsThoseInUse() {
  await reset();
  const left = await ask("wait");
  await beginAnother();
  const session = left.conversation.dsh.sessionId;
  // Something else on record, so that there is something to clear.
  await DshSessions.remember("s-other", PathUtils.join(scratch, "work"));

  const confirmed = PromptTestUtils.waitForPrompt(window, {
    modalType: Ci.nsIPromptService.MODAL_TYPE_WINDOW,
    promptType: "confirm",
  });
  const cleared = AIPanel.dsh.clearSessions();
  await PromptTestUtils.handlePrompt(await confirmed, { buttonNumClick: 0 });
  await cleared;

  const ids = (await DshSessions.list()).map(s => s.id);
  Assert.ok(!ids.includes("s-other"), "the others are cleared");
  Assert.ok(
    ids.includes(session),
    "the one dsh answers in out of sight is not"
  );
  Assert.ok(left.agent.running, "and dsh goes on in it");
  Assert.ok(
    (await AIConversations.list()).some(e => e.id == left.conversation.id),
    "as does its conversation"
  );
  await AIPanel.dsh.stop();
});

add_task(async function testStoppedWhenIdle() {
  await reset();
  send("hello");
  click((await permissionButtons()).firstElementChild);
  await waitForTurnToEnd();
  const agent = AIPanel.dsh.agent;
  const conversation = AIPanel.conversation;
  const notices = doc.querySelectorAll(".ai-notice").length;

  Services.prefs.setIntPref("mail.ai.dsh.idleSeconds", 1);
  // Which, as using dsh, starts the time it may sit idle afresh.
  const dshModels = doc.getElementById("ai-panel-dsh-model");
  dshModels.value = "deepseek/v4-pro";
  dshModels.dispatchEvent(new Event("change"));
  await TestUtils.waitForCondition(
    () => AIPanel.dsh._modelOf(agent) == "deepseek/v4-pro",
    "another model is chosen"
  );

  await TestUtils.waitForCondition(
    () => !agent.running && AIPanel.dsh.state == "ready",
    "dsh is stopped once it has sat idle"
  );
  Assert.equal(AIPanel.conversation, conversation, "the conversation stays");
  Assert.equal(
    doc.querySelectorAll(".ai-notice").length,
    notices,
    "and nothing is said about it"
  );
  Assert.ok(
    BrowserTestUtils.isVisible(dshModels) && !dshModels.disabled,
    "its model can still be chosen"
  );
  Assert.equal(dshModels.value, "deepseek/v4-pro");
  Assert.ok(
    (await DshSessions.list()).some(s => s.id == conversation.dsh.sessionId),
    "and its session is kept"
  );

  send("and again");
  click((await permissionButtons()).firstElementChild);
  await waitForTurnToEnd();
  const report = JSON.parse(
    lastAnswerTurn().querySelector(".ai-answer").textContent
  );
  Assert.ok(report.resumed, "the next question starts it again");
  Assert.equal(report.session, conversation.dsh.sessionId, "in its session");
  Assert.equal(
    AIPanel.dsh._modelOf(AIPanel.dsh.agent),
    "deepseek/v4-pro",
    "with the model it had"
  );
  Assert.equal(dshModels.value, "deepseek/v4-pro");
  Assert.equal(
    doc.querySelectorAll(".ai-notice").length,
    notices,
    "still without a word about it"
  );
});

add_task(async function testNotStoppedWhileItAnswers() {
  Services.prefs.setIntPref("mail.ai.dsh.idleSeconds", 2);
  await reset();
  // Three seconds, longer than it may sit idle.
  const { agent } = await ask("slow");
  await waitForTurnToEnd();
  const turn = lastAnswerTurn();
  Assert.equal(turn.querySelector(".ai-answer")?.textContent, "done slowly");
  Assert.ok(!turn.querySelector(".ai-notice"), "it was not stopped");
  Assert.ok(agent.running);

  // A run nothing is asked in, which is begun with the conversation.
  const fresh = await beginAnother();
  const unused = fresh.sessionId;
  await TestUtils.waitForCondition(
    () => !fresh.running && AIPanel.dsh.state == "ready",
    "is stopped too once it has sat idle"
  );
  await TestUtils.waitForCondition(
    async () => !(await DshSessions.list()).some(s => s.id == unused),
    "and its session, which nothing could reopen, deleted"
  );
  send("hello");
  click((await permissionButtons()).firstElementChild);
  await waitForTurnToEnd();
  const report = JSON.parse(
    lastAnswerTurn().querySelector(".ai-answer").textContent
  );
  Assert.ok(!report.resumed, "what is asked then begins a session");
  Assert.notEqual(report.session, unused);
  Services.prefs.clearUserPref("mail.ai.dsh.idleSeconds");
});

add_task(async function testWaitingTooLongOutOfSight() {
  Services.prefs.setIntPref("mail.ai.dsh.unansweredSeconds", 1);
  await reset();
  // Something answered first, so that the conversation is listed.
  send("slow");
  await TestUtils.waitForCondition(() => AIPanel.dsh.busy, "asked");
  await waitForTurnToEnd();
  const { agent, conversation } = await ask("hello");
  await permissionButtons();

  await beginAnother();
  Assert.equal(AIPanel.dsh.outOfSight().get(conversation.id), "waiting");
  await TestUtils.waitForCondition(
    () => !AIPanel.dsh.outOfSight().size && !agent.running,
    "dsh is stopped once it has waited too long"
  );
  await TestUtils.waitForCondition(async () => {
    const kept = await AIConversations.load(conversation.id);
    return kept?.turns.at(-1).parts.at(-1)?.id == "ai-panel-dsh-unanswered";
  }, "which is kept with the conversation");

  click((await rowFor(conversation.id)).querySelector(".ai-history-open"));
  await TestUtils.waitForCondition(
    () =>
      lastAnswerTurn()
        ?.querySelector(".ai-notice")
        ?.textContent.startsWith("Stopped: dsh waited 1 minute"),
    "and shown, saying why, when it is opened again"
  );
  Services.prefs.clearUserPref("mail.ai.dsh.unansweredSeconds");
});
