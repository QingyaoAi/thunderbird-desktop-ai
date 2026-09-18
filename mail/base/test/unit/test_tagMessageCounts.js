/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that the per-tag counts follow a message as it is tagged, moved,
 * copied and deleted, without a full recount.
 */

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
const { TagMessageCounts } = ChromeUtils.importESModule(
  "resource:///modules/TagMessageCounts.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const WORK = "$label2";

let source, destination;

/**
 * @param {nsIMsgFolder} folder
 * @returns {nsIMsgDBHdr} The one message in it.
 */
function onlyMessage(folder) {
  const headers = [...folder.msgDatabase.enumerateMessages()];
  Assert.equal(headers.length, 1, `${folder.name} holds one message`);
  return headers[0];
}

/**
 * Move or copy a folder's one message to another folder, and wait for it.
 *
 * @param {nsIMsgFolder} from
 * @param {nsIMsgFolder} to
 * @param {boolean} isMove
 */
async function transfer(from, to, isMove) {
  const listener = new PromiseTestUtils.PromiseCopyListener();
  MailServices.copy.copyMessages(
    from,
    [onlyMessage(from)],
    to,
    isMove,
    listener,
    null,
    false
  );
  await listener.promise;
  // The notifications that follow the copy itself.
  await TestUtils.waitForTick();
}

add_setup(async function () {
  const account = MailServices.accounts.createLocalMailAccount();
  const root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  source = root
    .createLocalSubfolder("source")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  destination = root
    .createLocalSubfolder("destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  source.addMessage(new MessageGenerator().makeMessage().toMessageString());

  TagMessageCounts.start();
  registerCleanupFunction(() => TagMessageCounts.stop());
  await TagMessageCounts.refresh();
});

add_task(async function testTaggingIsCounted() {
  Assert.equal(TagMessageCounts.get(WORK), 0, "nothing is tagged yet");

  source.addKeywordsToMessages([onlyMessage(source)], WORK);

  await TestUtils.waitForCondition(
    () => TagMessageCounts.get(WORK) == 1,
    "tagging a message should count it"
  );
});

/**
 * A move between local folders is reported as msgsMoveCopyCompleted and
 * nothing else -- no msgAdded for the arrival, no msgsDeleted for the
 * departure -- so both ends have to be counted from that one notification.
 */
add_task(async function testAMoveLeavesTheCountAlone() {
  await transfer(source, destination, true);

  Assert.ok(
    onlyMessage(destination).getStringProperty("keywords").includes(WORK),
    "the tag travelled with the message"
  );
  Assert.equal(
    TagMessageCounts.get(WORK),
    1,
    "one tagged message, moved, is still one tagged message"
  );
});

add_task(async function testACopyIsCounted() {
  await transfer(destination, source, false);

  Assert.equal(
    TagMessageCounts.get(WORK),
    2,
    "a copy of a tagged message is a second tagged message"
  );
});

add_task(async function testDeletingIsCounted() {
  for (const folder of [source, destination]) {
    const before = TagMessageCounts.get(WORK);
    folder.deleteMessages(
      [onlyMessage(folder)],
      null,
      true,
      false,
      null,
      false
    );
    await TestUtils.waitForCondition(
      () => TagMessageCounts.get(WORK) == before - 1,
      `deleting the message in ${folder.name} should take it out of the count`
    );
  }
  Assert.equal(TagMessageCounts.get(WORK), 0, "nothing tagged is left");
});
