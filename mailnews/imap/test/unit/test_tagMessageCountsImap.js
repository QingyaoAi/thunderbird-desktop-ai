/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that the per-tag counts survive a message being moved between IMAP
 * folders on one account.
 *
 * IMAP reports a move in more pieces than a local folder does, and at more
 * different times: a move that can be undone puts a placeholder in the
 * destination at once and swaps it for the real header when the folder is
 * next synchronised; one that cannot waits for the server; and on an account
 * that marks deleted mail rather than removing it, the source stays behind
 * until it is expunged. The count kept from notifications should agree with
 * a fresh count of what the databases hold after each of them.
 */

/* import-globals-from head_server.js */

const { TagMessageCounts } = ChromeUtils.importESModule(
  "resource:///modules/TagMessageCounts.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const WORK = "$label2";

let secondFolder;

/**
 * @param {nsIMsgFolder} folder
 */
async function update(folder) {
  const listener = new PromiseTestUtils.PromiseUrlListener();
  folder.updateFolderWithListener(null, listener);
  await listener.promise;
}

/** Bring both folders up to date with the server. */
async function resync() {
  await update(secondFolder);
  await update(IMAPPump.inbox);
}

/**
 * @param {nsIMsgFolder} folder
 * @returns {nsIMsgDBHdr[]}
 */
function headersIn(folder) {
  return [...folder.msgDatabase.enumerateMessages()];
}

/**
 * @param {string} name
 * @returns {object} The fake server's mailbox of that name.
 */
function serverMailbox(name) {
  return name == "INBOX" ? IMAPPump.mailbox : IMAPPump.daemon.getMailbox(name);
}

/**
 * Give the messages the server has just moved into a mailbox the tag they
 * were moved with.
 *
 * A real server keeps a message's keywords when it copies or moves it. The
 * fake one loses them: its ImapMessage constructor walks the flags it is
 * given with for...in, so the copy carries their indices -- "0" -- instead.
 * Changing that would change what every other test using the fake server
 * sees, so the tag is put back here, the way a real server would have kept
 * it.
 *
 * @param {string} name - The server mailbox moved into.
 */
function keepTagOnServer(name) {
  for (const msg of serverMailbox(name)._messages) {
    msg.flags = msg.flags.filter(flag => !/^\d+$/.test(flag));
    msg.setFlag(WORK);
  }
}

/**
 * Move every message in one folder to another.
 *
 * @param {nsIMsgFolder} from
 * @param {nsIMsgFolder} to
 * @param {boolean} allowUndo - True for the path a person's move takes, which
 *   puts placeholders in the destination; false for the one junk handling and
 *   filters take, which waits for the server.
 */
async function moveAll(from, to, allowUndo) {
  const listener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyMessages(
    from,
    headersIn(from),
    to,
    true,
    listener,
    null,
    allowUndo
  );
  await listener.promise;
}

/**
 * The count kept from notifications, next to a fresh count of the databases.
 *
 * @returns {Promise<{kept: number, recounted: number}>}
 */
async function counts() {
  // Let anything the last operation set off arrive first.
  await TestUtils.waitForTick();
  const kept = TagMessageCounts.get(WORK);
  await TagMessageCounts.refresh();
  return { kept, recounted: TagMessageCounts.get(WORK) };
}

add_setup(async function () {
  Services.prefs.setBoolPref(
    "mail.server.default.autosync_offline_stores",
    false
  );
  setupIMAPPump();
  IMAPPump.daemon.createMailbox("secondFolder", { subscribed: true });

  const synth = new MessageGenerator().makeMessage();
  IMAPPump.mailbox.addMessage(
    new ImapMessage(
      `data:text/plain;base64,${btoa(synth.toMessageString())}`,
      IMAPPump.mailbox.uidnext++,
      []
    )
  );
  // Updating the inbox also discovers the other folder on the server.
  await update(IMAPPump.inbox);
  secondFolder = IMAPPump.incomingServer.rootFolder
    .getChildNamed("secondFolder")
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  await update(secondFolder);

  TagMessageCounts.start();
  registerCleanupFunction(() => TagMessageCounts.stop());
  await TagMessageCounts.refresh();

  IMAPPump.inbox.addKeywordsToMessages(headersIn(IMAPPump.inbox), WORK);
  await TestUtils.waitForCondition(
    () => TagMessageCounts.get(WORK) == 1,
    "tagging the message should count it"
  );
});

add_task(async function testAMoveThatCanBeUndone() {
  await moveAll(IMAPPump.inbox, secondFolder, true);
  let { kept, recounted } = await counts();
  Assert.equal(kept, recounted, "the placeholder is counted as it arrives");
  Assert.equal(kept, 1, "in place of the message it stands in for");

  // The move is played back to the server on a timer.
  await TestUtils.waitForCondition(
    () => serverMailbox("secondFolder")._messages.length == 1,
    "the move should reach the server"
  );
  keepTagOnServer("secondFolder");
  await resync();
  ({ kept, recounted } = await counts());
  Assert.equal(kept, recounted, "the real header replaces the placeholder");
  Assert.equal(kept, 1, "one tagged message, moved, is one tagged message");
});

add_task(async function testAMoveThatWaitsForTheServer() {
  await moveAll(secondFolder, IMAPPump.inbox, false);
  keepTagOnServer("INBOX");
  await resync();
  const { kept, recounted } = await counts();
  Assert.equal(kept, recounted, "the source is taken off once");
  Assert.equal(kept, 1, "one tagged message, moved, is one tagged message");
});

add_task(async function testAMoveThatLeavesTheSourceBehind() {
  IMAPPump.incomingServer.deleteModel = Ci.nsMsgImapDeleteModels.IMAPDelete;
  registerCleanupFunction(() => {
    IMAPPump.incomingServer.deleteModel = Ci.nsMsgImapDeleteModels.MoveToTrash;
  });

  await moveAll(IMAPPump.inbox, secondFolder, false);
  keepTagOnServer("secondFolder");
  await resync();
  let { kept, recounted } = await counts();
  Assert.equal(
    kept,
    recounted,
    "a source marked deleted rather than removed is still counted"
  );

  const listener = new PromiseTestUtils.PromiseUrlListener();
  IMAPPump.inbox.expunge(listener, null);
  await listener.promise;
  await resync();
  ({ kept, recounted } = await counts());
  Assert.equal(kept, recounted, "and taken off once, when it is expunged");
  Assert.equal(kept, 1, "leaving one tagged message");
});
