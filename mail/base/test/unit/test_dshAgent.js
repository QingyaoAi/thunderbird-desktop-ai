/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests running an ACP agent the way the AI panel runs dsh: starting it,
 * giving it the mailbox, relaying what it does, answering its permission
 * requests, cancelling, and stopping it cleanly. The agent here is a small
 * stand-in written for the test, which speaks just enough of the protocol.
 */

const { MailMcpServer, MailMcpTokens } = ChromeUtils.importESModule(
  "resource:///modules/MailMcpServer.sys.mjs"
);
const { AcpConnection, DshAgent, DshError, DshSessions, DshSettings } =
  ChromeUtils.importESModule("resource:///modules/DshAgent.sys.mjs");
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { writeFakeAcpAgent } = ChromeUtils.importESModule(
  "resource://testing-common/FakeAcpAgent.sys.mjs"
);

let scratch, python, agent;
let updates = [];
let permissionAnswer = "allow-once";
let exits = [];

/**
 * Write an executable script.
 *
 * @param {string} name
 * @param {string} text
 * @returns {Promise<string>} Its path.
 */
async function writeScript(name, text) {
  const path = PathUtils.join(scratch, name);
  await IOUtils.writeUTF8(path, text);
  await IOUtils.setPermissions(path, 0o755);
  return path;
}

/** @returns {DshAgent} An agent recording what it is told. */
function makeAgent() {
  return new DshAgent({
    onUpdate: update => updates.push(update),
    onPermission: async () => permissionAnswer,
    onExit: info => exits.push(info),
  });
}

/** @returns {object} The report in the last message the agent sent. */
function lastReport() {
  const message = updates.findLast(
    u => u.sessionUpdate == "agent_message_chunk"
  );
  return JSON.parse(message.content.text);
}

add_setup(async function () {
  python = await Subprocess.pathSearch("python3");
  scratch = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "dshtest");
  const fake = await writeFakeAcpAgent(scratch);

  Services.prefs.setBoolPref("mail.mcp.enabled", true);
  // The agent here is a program of its own, not a script for node, so the
  // "node" setting only decides what goes first on its PATH.
  DshSettings.set("node", python);
  DshSettings.set("dsh", fake);
  DshSettings.set("workspace", PathUtils.join(scratch, "work"));

  registerCleanupFunction(async () => {
    await agent?.stop();
    MailMcpServer.stop();
    await IOUtils.remove(scratch, { recursive: true });
  });
});

add_task(async function testLineFraming() {
  const seen = [];
  const connection = new AcpConnection(() => {}, {
    onNotification: (method, params) => seen.push([method, params.n]),
    onRequest: () => ({}),
  });
  connection.receive('{"jsonrpc":"2.0","method":"a","params":{"n":1}}\n{"js');
  connection.receive('onrpc":"2.0","method":"b","params":{"n":2}}\nnot json\n');
  connection.receive('\n{"jsonrpc":"2.0","method":"c","params":{"n":3}}\n');
  Assert.deepEqual(
    seen,
    [
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ],
    "messages split across reads are put back together; a stray line is skipped"
  );
});

add_task(async function testStartOpensASession() {
  agent = makeAgent();
  await agent.start();
  Assert.ok(agent.running);
  Assert.equal(agent.sessionId, "s1");
  Assert.equal(agent.configOptions[0].currentValue, "deepseek/v4");
  Assert.ok(
    await IOUtils.exists(PathUtils.join(scratch, "work")),
    "the working folder is made if it is not there"
  );
});

add_task(async function testAPromptAndItsPermission() {
  updates = [];
  const stopReason = await agent.prompt([
    { type: "text", text: "hello" },
    { type: "resource_link", uri: "imap-message://x#1", name: "Hi" },
  ]);
  Assert.equal(stopReason, "end_turn");
  Assert.deepEqual(
    updates.map(u => u.sessionUpdate),
    [
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
    ],
    "what the agent did arrives in order"
  );
  const report = lastReport();
  Assert.equal(report.said, "hello");
  Assert.deepEqual(report.links, ["imap-message://x#1"]);
  Assert.equal(report.tools, 9, "the mailbox was reachable with its token");
  Assert.ok(report.sameDir, "the agent runs in the working folder");
  Assert.equal(
    report.path,
    PathUtils.parent(python),
    "the node setting's folder leads the PATH"
  );
  Assert.equal(report.permission, "allow-once");
  Assert.equal(updates[2].status, "completed");

  const patchAt = report.argv.indexOf("--patch");
  Assert.deepEqual(
    report.argv.slice(0, 2),
    ["--profile", "acp"],
    "dsh is started in its ACP mode"
  );
  Assert.greater(patchAt, -1, "with a patch layer of Thunderbird's own");
  Assert.stringContains(
    await IOUtils.readUTF8(report.argv[patchAt + 1]),
    "You are the mail assistant",
    "which says what it is there for"
  );
  Assert.stringContains(
    await IOUtils.readUTF8(report.argv[patchAt + 1]),
    "Start from what they have open",
    "to begin with the message that is open"
  );
  Assert.stringContains(
    await IOUtils.readUTF8(report.argv[patchAt + 1]),
    "Link every message you cite",
    "and to link the messages it cites"
  );
});

add_task(async function testARefusedPermission() {
  updates = [];
  permissionAnswer = null;
  await agent.prompt([{ type: "text", text: "again" }]);
  Assert.equal(lastReport().permission, "cancelled");
  Assert.equal(
    updates.find(u => u.sessionUpdate == "tool_call_update").status,
    "failed"
  );
  permissionAnswer = "allow-once";
});

add_task(async function testCancel() {
  const pending = agent.prompt([{ type: "text", text: "wait" }]);
  await TestUtils.waitForTick();
  agent.cancel();
  Assert.equal(await pending, "cancelled");
});

add_task(async function testChangingTheModel() {
  const options = await agent.setConfigOption("model", "deepseek/v4-pro");
  Assert.equal(options[0].currentValue, "deepseek/v4-pro");
  Assert.equal(agent.configOptions[0].currentValue, "deepseek/v4-pro");
});

add_task(async function testStopRevokesTheToken() {
  const token = agent._token;
  Assert.ok(await MailMcpTokens.verify(token), "valid while it runs");
  await agent.stop();
  Assert.ok(!agent.running);
  Assert.ok(!(await MailMcpTokens.verify(token)), "revoked when it stops");
  Assert.deepEqual(exits, [], "stopping on purpose is not reported as exit");
});

add_task(async function testAnAgentThatDies() {
  agent = makeAgent();
  await agent.start();
  const token = agent._token;
  await Assert.rejects(
    agent.prompt([{ type: "text", text: "crash" }]),
    /stopped/,
    "the prompt fails"
  );
  await TestUtils.waitForCondition(() => exits.length, "the exit is reported");
  Assert.equal(exits[0].exitCode, 3);
  Assert.stringContains(exits[0].stderr, "the stand-in fell over");
  Assert.ok(!agent.running);
  Assert.ok(!(await MailMcpTokens.verify(token)), "its token is revoked");
});

add_task(async function testWhatStopsItStarting() {
  const fake = Services.prefs.getStringPref("mail.ai.dsh.path");

  DshSettings.set("dsh", PathUtils.join(scratch, "nowhere"));
  await Assert.rejects(
    makeAgent().start(),
    e => e instanceof DshError && e.code == "no-dsh",
    "a dsh that is not there"
  );

  DshSettings.set(
    "dsh",
    await writeScript(
      "broken-dsh",
      "#!/bin/sh\necho 'no profile named acp' >&2\nexit 1\n"
    )
  );
  await Assert.rejects(
    makeAgent().start(),
    e => e.code == "failed" && e.message.includes("no profile named acp"),
    "what the program said is passed on"
  );

  Services.prefs.setBoolPref("mail.mcp.enabled", false);
  MailMcpServer.stop();
  DshSettings.set("dsh", fake);
  await Assert.rejects(
    makeAgent().start(),
    e => e.code == "mail-access-off",
    "no mailbox to give it"
  );
  Services.prefs.setBoolPref("mail.mcp.enabled", true);
});

/**
 * Clearing deletes the sessions Thunderbird started -- their logs and cached
 * projections -- and nothing else: not the one in use, and not dsh's own.
 */
add_task(async function testClearingSessions() {
  const home = PathUtils.join(scratch, "dsh-home");
  Services.env.set("DSH_HOME", home);
  const project = PathUtils.join(home, "sessions", "--a-working-folder--");
  const elsewhere = PathUtils.join(home, "sessions", "--another-folder--");
  const cache = PathUtils.join(
    home,
    "storages",
    "session_projcache",
    "sessions"
  );
  for (const dir of [project, elsewhere, cache]) {
    await IOUtils.makeDirectory(dir, { createAncestors: true });
  }
  const makeSession = async (dir, id) => {
    await IOUtils.makeDirectory(PathUtils.join(dir, id));
    await IOUtils.writeUTF8(PathUtils.join(dir, id, "log.jsonl"), "{}");
    await IOUtils.writeUTF8(PathUtils.join(cache, `${id}.json`), "{}");
  };
  // "s1" is the stand-in's, from the runs above; the last is dsh's own.
  for (const id of ["s1", "tb-2", "tb-3"]) {
    await makeSession(project, id);
  }
  await makeSession(elsewhere, "started-in-dsh");

  await DshSessions.remember("tb-2", "/work");
  await DshSessions.remember("tb-3", "/work");
  await DshSessions.remember("../escape", "/work");
  Assert.deepEqual(
    (await DshSessions.list()).map(session => session.id).sort(),
    ["s1", "tb-2", "tb-3"],
    "the sessions started here are on record, an unsafe id is not"
  );

  Assert.equal(await DshSessions.clear(["tb-3"]), 2, "two deleted");
  for (const id of ["s1", "tb-2"]) {
    Assert.ok(
      !(await IOUtils.exists(PathUtils.join(project, id))),
      `${id} log`
    );
    Assert.ok(
      !(await IOUtils.exists(PathUtils.join(cache, `${id}.json`))),
      `${id} cache`
    );
  }
  Assert.ok(
    await IOUtils.exists(PathUtils.join(project, "tb-3")),
    "the session in use is kept"
  );
  Assert.ok(
    await IOUtils.exists(PathUtils.join(elsewhere, "started-in-dsh")),
    "a session started in dsh itself is not touched"
  );
  Assert.ok(await IOUtils.exists(PathUtils.join(cache, "started-in-dsh.json")));
  Assert.deepEqual(
    (await DshSessions.list()).map(session => session.id),
    ["tb-3"],
    "only the kept one is still on record"
  );
  Services.env.set("DSH_HOME", "");
});

add_task(async function testSettingsDefaults() {
  const saved = await DshSettings.get();
  for (const key of ["node", "dsh", "workspace"]) {
    DshSettings.set(key, "");
  }

  const defaults = await DshSettings.get();
  Assert.equal(
    defaults.workspace,
    PathUtils.join(PathUtils.tempDir, "thunderbird-dsh"),
    "dsh works in a folder of its own under the temporary folder"
  );
  const usual = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ];
  let expected = "";
  for (const candidate of usual) {
    if (await IOUtils.exists(candidate)) {
      expected = candidate;
      break;
    }
  }
  Assert.equal(
    defaults.node,
    expected,
    "node is looked for where it usually is"
  );

  const dshUsual = [
    ...(expected ? [PathUtils.join(PathUtils.parent(expected), "dsh")] : []),
    "/opt/homebrew/bin/dsh",
    "/usr/local/bin/dsh",
  ];
  expected = "";
  for (const candidate of dshUsual) {
    if (await IOUtils.exists(candidate)) {
      expected = candidate;
      break;
    }
  }
  Assert.equal(
    defaults.dsh,
    expected,
    "an installed dsh is looked for beside node, then where it usually is"
  );

  DshSettings.set("node", saved.node);
  DshSettings.set("dsh", saved.dsh);
  DshSettings.set("workspace", saved.workspace);
  Assert.deepEqual(await DshSettings.get(), saved, "settings are kept");
});

/**
 * dsh is what answers in the AI panel from the start, but only where it can:
 * not once its button has turned it off, and not without a dsh to run or the
 * mail access it reads the mail through.
 */
add_task(async function testAnsweringByDefault() {
  Assert.ok(
    !Services.prefs.prefHasUserValue("mail.ai.dsh.on"),
    "nothing has turned it on or off yet"
  );
  Assert.ok(await DshSettings.answersByDefault(), "it does, where it can");

  DshSettings.leftOn(false);
  Assert.ok(
    !(await DshSettings.answersByDefault()),
    "not once it has been turned off"
  );
  DshSettings.leftOn(true);
  Assert.ok(await DshSettings.answersByDefault(), "until it is turned on");
  Services.prefs.clearUserPref("mail.ai.dsh.on");

  Services.prefs.setBoolPref("mail.mcp.enabled", false);
  Assert.ok(
    !(await DshSettings.answersByDefault()),
    "not with mail access off, when it could not read the mail"
  );
  Services.prefs.setBoolPref("mail.mcp.enabled", true);

  const fake = Services.prefs.getStringPref("mail.ai.dsh.path");
  DshSettings.set("dsh", PathUtils.join(scratch, "nowhere"));
  Assert.ok(
    !(await DshSettings.answersByDefault()),
    "and not where there is no dsh to run"
  );
  DshSettings.set("dsh", fake);
  Assert.ok(await DshSettings.answersByDefault());
});
