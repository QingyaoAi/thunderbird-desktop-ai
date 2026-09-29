/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests the search behind the tag folders: a message is listed when any
 * message in its thread carries the tag, so a tagged conversation shows up
 * whole -- including replies that arrived after it was tagged.
 */

/* import-globals-from resources/viewWrapperTestUtils.js */
load("resources/viewWrapperTestUtils.js");

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { SmartMailboxUtils } = ChromeUtils.importESModule(
  "resource:///modules/SmartMailboxUtils.sys.mjs"
);
var { ThreadTagSearchTerm, threadTagSearchString } = ChromeUtils.importESModule(
  "resource:///modules/ThreadTagSearchTerm.sys.mjs"
);

initViewWrapperTestUtils({ mode: "local" });
ThreadTagSearchTerm.register();

// Listed flat, so every message the search finds is a row of its own. Whether
// a thread shows expanded is up to the view, not the search being tested.
Services.prefs.setIntPref("mailnews.default_view_flags", 0);

const IMPORTANT = "$label1";

let folder, taggedThread, otherThread, loner;

add_setup(async function () {
  [[folder], taggedThread, otherThread, loner] =
    await messageInjection.makeFoldersWithSets(1, [
      { count: 3, msgsPerThread: 3 },
      { count: 2, msgsPerThread: 2 },
      { count: 1 },
    ]);
  // Only the middle message of the first thread carries the tag.
  taggedThread.slice(1, 2).addTag(IMPORTANT);
});

let virtualFolderCount = 0;

/**
 * A saved search over the test folder, searching the way a tag folder does.
 *
 * @returns {nsIMsgFolder}
 */
function makeTagFolder() {
  return VirtualFolderHelper.createNewVirtualFolder(
    `threadTag${virtualFolderCount++}`,
    folder.rootFolder,
    [folder],
    threadTagSearchString(IMPORTANT),
    false
  ).virtualFolder;
}

add_task(async function test_the_whole_thread_is_listed() {
  const viewWrapper = make_view_wrapper();
  await view_open(viewWrapper, makeTagFolder());
  verify_messages_in_view([taggedThread], viewWrapper);
});

add_task(async function test_a_later_reply_is_listed() {
  const [reply] = await messageInjection.makeNewSetsInFolders(
    [folder],
    [{ count: 1, inReplyTo: taggedThread.synMessages[2] }]
  );
  Assert.ok(
    !reply.msgHdrList[0].getStringProperty("keywords").includes(IMPORTANT),
    "the reply does not carry the tag itself"
  );

  const viewWrapper = make_view_wrapper();
  await view_open(viewWrapper, makeTagFolder());
  verify_messages_in_view([taggedThread, reply], viewWrapper);
  taggedThread = taggedThread.union(reply);
});

add_task(async function test_untagging_takes_the_thread_away() {
  taggedThread.slice(1, 2).removeTag(IMPORTANT);

  const viewWrapper = make_view_wrapper();
  await view_open(viewWrapper, makeTagFolder());
  verify_empty_view(viewWrapper);
});

add_task(async function test_doesnt_contain() {
  otherThread.slice(0, 1).addTag(IMPORTANT);
  const hdrs = [
    ...taggedThread.msgHdrs(),
    ...otherThread.msgHdrs(),
    ...loner.msgHdrs(),
  ];
  const matching = hdrs.filter(hdr =>
    ThreadTagSearchTerm.match(hdr, IMPORTANT, Ci.nsMsgSearchOp.DoesntContain)
  );
  Assert.deepEqual(
    matching.map(hdr => hdr.messageId).sort(),
    [...taggedThread.msgHdrs(), ...loner.msgHdrs()]
      .map(hdr => hdr.messageId)
      .sort(),
    "DoesntContain matches the threads with no tagged message"
  );
});

/**
 * Tag folders made before this searched for the tag on the message alone.
 * Setting up the smart mailbox brings them up to date, and saves that where a
 * restart will read it back.
 */
add_task(async function test_old_tag_folders_are_updated() {
  // As the application does at startup; saving them does nothing before.
  MailServices.accounts.loadVirtualFolders();

  // An account set up by an earlier version: the smart mailbox with its tag
  // folder already there, searching the old way.
  const server = MailServices.accounts.createIncomingServer(
    "nobody",
    "smart mailboxes",
    "none"
  );
  server.hidden = true;
  MailServices.accounts.createAccount().incomingServer = server;
  const root = server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const tags = root
    .createLocalSubfolder("tags")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const tagFolder = tags.createLocalSubfolder(IMPORTANT);
  tagFolder.flags |= Ci.nsMsgFolderFlags.Virtual;
  tagFolder.name = MailServices.tags.getTagForKey(IMPORTANT);
  const folderInfo = tagFolder.msgDatabase.dBFolderInfo;
  folderInfo.setCharProperty("searchStr", `AND (tag,contains,${IMPORTANT})`);
  folderInfo.setCharProperty("searchFolderUri", "*");
  tagFolder.msgDatabase = null;

  const smartMailbox = SmartMailboxUtils.getSmartMailbox();
  const updated = smartMailbox.getTagFolder(
    MailServices.tags.getAllTags().find(tag => tag.key == IMPORTANT)
  );
  Assert.equal(updated.URI, tagFolder.URI, "the existing folder is kept");
  Assert.equal(
    VirtualFolderHelper.wrapVirtualFolder(updated).searchString,
    threadTagSearchString(IMPORTANT),
    "its search now takes in the whole thread"
  );

  const saved = await IOUtils.readUTF8(
    PathUtils.join(PathUtils.profileDir, "virtualFolders.dat")
  );
  Assert.stringContains(
    saved,
    `terms=${threadTagSearchString(IMPORTANT)}`,
    "the new search is saved for the next start"
  );
});
