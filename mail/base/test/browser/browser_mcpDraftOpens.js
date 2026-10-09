/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A draft the mail endpoint writes opens in the compose window as one saved
 * there would: in the HTML editor, as the identity it was written as, with
 * its formatting, the signature, the identity's own copy, the attachment and
 * what was chosen for it -- and so does a draft the endpoint has changed.
 */

const { MailMcpServer, MailMcpTokens } = ChromeUtils.importESModule(
  "resource:///modules/MailMcpServer.sys.mjs"
);

const SIGNATURE = "Mé Example\nExample University";

let identity, token, notesPath;

/**
 * One call to the endpoint.
 *
 * @param {string} method
 * @param {object} params
 * @returns {Promise<object>} What it answered with.
 */
async function rpc(method, params) {
  const response = await fetch(`http://127.0.0.1:${MailMcpServer.port}/rpc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params }),
  });
  const { result, error } = await response.json();
  Assert.ok(!error, `${method} is done${error ? `: ${error}` : ""}`);
  return result;
}

/**
 * Open a draft to go on writing it, as Edit Draft does.
 *
 * @param {string} id
 * @returns {Promise<Window>} The compose window, ready.
 */
async function openDraft(id) {
  const hdr = MailServices.messageServiceFromURI(id).messageURIToMsgHdr(id);
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(
    null,
    win =>
      win.document.documentURI ==
      "chrome://messenger/content/messengercompose/messengercompose.xhtml"
  );
  MailServices.compose.OpenComposeWindow(
    null,
    hdr,
    id,
    Ci.nsIMsgCompType.Draft,
    Ci.nsIMsgCompFormat.Default,
    null,
    null,
    null
  );
  const win = await opened;
  await TestUtils.waitForCondition(
    () => win.composeEditorReady,
    "waiting for the compose editor to be ready"
  );
  return win;
}

/**
 * @param {Window} win - A compose window.
 * @param {string} row - "to", "cc" or "bcc".
 * @returns {string[]} The addresses in that row.
 */
function addressesIn(win, row) {
  return Array.from(
    win.document.querySelectorAll(`#${row}AddrContainer mail-address-pill`),
    pill => pill.emailAddress
  );
}

/**
 * What every draft here should be in the window.
 *
 * @param {Window} win - A compose window.
 */
function checkDraft(win) {
  Assert.ok(win.gMsgCompose.composeHTML, "it opens in the HTML editor");
  Assert.equal(win.gCurrentIdentity.key, identity.key, "as its identity");
  Assert.equal(win.document.getElementById("msgSubject").value, "Plan");
  Assert.deepEqual(addressesIn(win, "to"), ["zoe@example.com"]);
  Assert.deepEqual(addressesIn(win, "bcc"), ["me@example.com"]);

  const body =
    win.document.getElementById("messageEditor").contentDocument.body;
  Assert.stringContains(body.textContent, "Here is the plan.");
  Assert.equal(body.querySelector("b")?.textContent, "plan", "formatted");
  Assert.equal(win.gMsgCompose.compFields.priority, "High");
  Assert.ok(win.gMsgCompose.compFields.returnReceipt, "with a receipt asked");
  Assert.ok(
    !body.querySelector("pre:not(.moz-signature)"),
    "its text is ordinary text, not preformatted"
  );
  Assert.stringContains(
    body.querySelector(".moz-signature")?.textContent ?? "",
    SIGNATURE,
    "with the signature where the window looks for one"
  );

  const bucket = win.document.getElementById("attachmentBucket");
  Assert.equal(bucket.itemCount, 1, "and its attachment");
  Assert.equal(bucket.getItemAtIndex(0).attachment.name, "notes.txt");
}

add_setup(async function () {
  const account = MailServices.accounts.createAccount();
  account.incomingServer = MailServices.accounts.createIncomingServer(
    "nobody",
    "McpDraftTesting",
    "pop3"
  );
  identity = MailServices.accounts.createIdentity();
  identity.email = "me@example.com";
  identity.fullName = "Mé Example";
  identity.doBcc = true;
  identity.doBccList = "me@example.com";
  identity.htmlSigText = SIGNATURE;
  account.addIdentity(identity);

  notesPath = PathUtils.join(PathUtils.tempDir, "mcpDraftOpens-notes.txt");
  await IOUtils.writeUTF8(notesPath, "Bring the figures.\n");

  Services.prefs.setBoolPref("mail.mcp.enabled", true);
  // Let the system choose, so the test never meets a running Thunderbird.
  Services.prefs.setIntPref("mail.mcp.port", -1);
  MailMcpServer.start();
  token = MailMcpTokens.createEphemeral();

  registerCleanupFunction(async () => {
    MailMcpTokens.revokeEphemeral(token);
    MailMcpServer.stop();
    Services.prefs.clearUserPref("mail.mcp.enabled");
    Services.prefs.clearUserPref("mail.mcp.port");
    await IOUtils.remove(notesPath, { ignoreAbsent: true });
    const drafts = identity.getOrCreateDraftsFolder();
    drafts.deleteMessages([...drafts.messages], null, true, false, null, false);
    MailServices.accounts.removeAccount(account, false);
  });
});

add_task(async function testADraftOpensAsOneSavedInTheWindow() {
  const draft = await rpc("createDraft", {
    from: "me@example.com",
    to: "Zoë Bell <zoe@example.com>",
    subject: "Plan",
    html: "<p>Dear Zoë,</p><p>Here is the <b>plan</b>.</p>",
    priority: "high",
    returnReceipt: true,
    attachments: [{ path: notesPath, name: "notes.txt" }],
  });
  let win = await openDraft(draft.id);
  checkDraft(win);
  Assert.deepEqual(addressesIn(win, "cc"), []);
  await BrowserTestUtils.closeWindow(win);

  const changed = await rpc("updateDraft", {
    id: draft.id,
    cc: "chairs@example.com",
  });
  win = await openDraft(changed.id);
  checkDraft(win);
  Assert.deepEqual(addressesIn(win, "cc"), ["chairs@example.com"]);
  await BrowserTestUtils.closeWindow(win);
});
