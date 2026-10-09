/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests the mail endpoint's MCP route: MCP over Streamable HTTP on `/mcp`,
 * as the harness the AI panel starts uses it, including tagging -- the one
 * change to a message the endpoint allows.
 */

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MailMcpServer, MailMcpTokens } = ChromeUtils.importESModule(
  "resource:///modules/MailMcpServer.sys.mjs"
);
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

let folder, token;

/**
 * POST one MCP message, or several, to `/mcp`.
 *
 * @param {object|object[]} body
 * @param {string} [bearer] - The token to present.
 * @returns {Promise<Response>}
 */
function post(body, bearer = token) {
  return fetch(`http://127.0.0.1:${MailMcpServer.port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
}

let nextId = 1;

/**
 * Call a tool and return what it said, parsed.
 *
 * @param {string} name
 * @param {object} args
 * @returns {Promise<{isError: boolean, result: *}>}
 */
async function callTool(name, args) {
  const response = await post({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  Assert.equal(response.status, 200, `${name} is answered`);
  const { result } = await response.json();
  const text = result.content[0].text;
  return {
    isError: Boolean(result.isError),
    result: result.isError ? text : JSON.parse(text),
  };
}

/** @returns {nsIMsgDBHdr[]} */
function headers() {
  return [...folder.msgDatabase.enumerateMessages()];
}

/**
 * @param {nsIMsgDBHdr} hdr
 * @returns {string[]}
 */
function keywordsOf(hdr) {
  return (hdr.getStringProperty("keywords") || "").split(" ").filter(Boolean);
}

add_setup(async function () {
  const account = MailServices.accounts.createLocalMailAccount();
  const root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  folder = root
    .createLocalSubfolder("mcpProtocol")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  folder.addMessageBatch(
    new MessageGenerator()
      .makeMessages({ count: 2 })
      .map(message => message.toMessageString())
  );

  Services.prefs.setBoolPref("mail.mcp.enabled", true);
  MailMcpServer.start();
  token = MailMcpTokens.createEphemeral();
  registerCleanupFunction(() => {
    MailMcpTokens.revokeEphemeral(token);
    MailMcpServer.stop();
  });
});

add_task(async function testATokenIsRequired() {
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  Assert.equal((await post(ping, "wrong")).status, 401, "a wrong token");

  const passing = MailMcpTokens.createEphemeral();
  Assert.equal((await post(ping, passing)).status, 200, "an in-memory token");
  MailMcpTokens.revokeEphemeral(passing);
  Assert.equal(
    (await post(ping, passing)).status,
    401,
    "a revoked in-memory token is refused"
  );
});

add_task(async function testInitialize() {
  const response = await post({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  Assert.equal(response.status, 200);
  const message = await response.json();
  Assert.equal(message.id, 0, "an id of 0 is a request, not a notification");
  Assert.equal(
    message.result.protocolVersion,
    "2025-03-26",
    "a revision it knows is answered in kind"
  );
  Assert.ok(message.result.capabilities.tools, "it offers tools");
  Assert.stringContains(
    message.result.instructions,
    "(<id>)",
    "and says how to link a message"
  );

  const notified = await post({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  Assert.equal(notified.status, 202, "a notification is only accepted");
  Assert.equal(await notified.text(), "", "with nothing said back");
});

add_task(async function testNoServerStream() {
  const response = await fetch(`http://127.0.0.1:${MailMcpServer.port}/mcp`, {
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
    },
  });
  Assert.equal(response.status, 405, "there is no stream to open");
  Assert.equal(response.headers.get("Allow"), "POST");
});

add_task(async function testToolsList() {
  const response = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const { tools } = (await response.json()).result;
  Assert.deepEqual(
    tools.map(t => t.name),
    [
      "search_mail",
      "get_message",
      "get_attachment",
      "get_thread",
      "list_folders",
      "list_identities",
      "create_draft",
      "update_draft",
      "list_tags",
      "tag_messages",
    ]
  );
  for (const tool of tools) {
    Assert.equal(tool.inputSchema?.type, "object", `${tool.name} has a schema`);
    Assert.ok(!("method" in tool), `${tool.name} keeps its method to itself`);
  }
});

add_task(async function testTagging() {
  const { result: tagList } = await callTool("list_tags", {});
  Assert.ok(
    tagList.tags.some(t => t.key == "$label1" && t.name == "Important"),
    "Important is among the tags"
  );

  const [first, second] = headers();
  const ids = [first, second].map(hdr => folder.getUriForMsg(hdr));

  const added = await callTool("tag_messages", {
    ids,
    add: ["important", "$label2"],
  });
  Assert.ok(!added.isError, "tagging by name and by key");
  for (const hdr of [first, second]) {
    Assert.ok(keywordsOf(hdr).includes("$label1"), "tagged by its name");
    Assert.ok(keywordsOf(hdr).includes("$label2"), "tagged by its key");
  }
  Assert.ok(
    added.result.messages.every(m => m.tags.includes("$label2")),
    "the messages come back as they now are"
  );

  const removed = await callTool("tag_messages", {
    ids: [ids[0]],
    remove: ["Work"],
  });
  Assert.ok(!removed.isError);
  Assert.ok(!keywordsOf(first).includes("$label2"), "a tag comes off");
  Assert.ok(keywordsOf(second).includes("$label2"), "only where asked");
});

add_task(async function testTaggingMistakes() {
  const id = folder.getUriForMsg(headers()[0]);

  const unknown = await callTool("tag_messages", {
    ids: [id],
    add: ["Imprtant"],
  });
  Assert.ok(unknown.isError, "an unknown tag is refused");
  Assert.stringContains(unknown.result, "Important ($label1)");
  Assert.ok(
    !MailServices.tags.getAllTags().some(t => t.tag == "Imprtant"),
    "and no tag is made for it"
  );

  Assert.ok(
    (await callTool("tag_messages", { add: ["Work"] })).isError,
    "ids are required"
  );
  Assert.ok(
    (await callTool("tag_messages", { ids: [id] })).isError,
    "so is something to do"
  );
});

add_task(async function testBatchesAndErrors() {
  const response = await post([
    { jsonrpc: "2.0", id: 10, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 11, method: "no/such/method" },
  ]);
  Assert.equal(response.status, 200);
  const answers = await response.json();
  Assert.deepEqual(
    answers.map(a => a.id),
    [10, 11],
    "each request answered in order, the notification not at all"
  );
  Assert.equal(answers[1].error.code, -32601, "an unknown method");

  const unknownTool = await (
    await post({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "send_mail", arguments: {} },
    })
  ).json();
  Assert.equal(unknownTool.error.code, -32602, "there is no tool to send mail");
});

add_task(async function testTheOtherRouteStillWorks() {
  const response = await fetch(`http://127.0.0.1:${MailMcpServer.port}/rpc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ method: "listTags", params: {} }),
  });
  Assert.equal(response.status, 200);
  Assert.ok((await response.json()).result.tags.length, "/rpc answers too");
});
