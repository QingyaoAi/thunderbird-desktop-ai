/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Test migration logic by artificially inducing or simulating the problem, then
 *  trigger the migration logic, then verify things ended up correct, including
 *  the schema version so a second pass of the logic doesn't happen.  (As
 *  opposed to checking in an example of a broken database and running against
 *  that.)
 */

var {
  assertExpectedMessagesIndexed,
  glodaTestHelperInitialize,
  nukeGlodaCachesAndCollections,
  waitForGlodaIndexer,
} = ChromeUtils.importESModule(
  "resource://testing-common/gloda/GlodaTestHelper.sys.mjs"
);
var { waitForGlodaDBFlush, makeABCardForAddressPair } =
  ChromeUtils.importESModule(
    "resource://testing-common/gloda/GlodaTestHelperFunctions.sys.mjs"
  );
var { sqlRun } = ChromeUtils.importESModule(
  "resource://testing-common/gloda/GlodaQueryHelper.sys.mjs"
);
var { GlodaMsgIndexer } = ChromeUtils.importESModule(
  "resource:///modules/gloda/IndexMsg.sys.mjs"
);
var { GlodaDatastore } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaDatastore.sys.mjs"
);
var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
var { MessageInjection } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageInjection.sys.mjs"
);

const GLODA_OLD_BAD_MESSAGE_ID = 1;

var msgGen;
var messageInjection;

add_setup(function () {
  msgGen = new MessageGenerator();
  messageInjection = new MessageInjection({ mode: "local" }, msgGen);
  glodaTestHelperInitialize(messageInjection);
});

/**
 * Fix the fallout from bug 732372 (with this patch for bug 734507) which left
 *  identities whose e-mails were in the address book without contacts and then
 *  broke messages involving them.
 */
add_task(async function test_fix_missing_contacts_and_fallout() {
  // -- Setup

  // - Create 4 e-mail addresses, 2 of which are in the address book.  (We want
  //    to make sure we have to iterate, hence >1).
  const abPeeps = msgGen.makeNamesAndAddresses(2);
  const nonAbPeeps = msgGen.makeNamesAndAddresses(2);
  makeABCardForAddressPair(abPeeps[0]);
  makeABCardForAddressPair(abPeeps[1]);

  // - Create messages of the genres [from, to]: [inAB, inAB], [inAB, !inAB],
  //    [!inAB, inAB], [!inAB, !inAB].  The permutations are black box overkill.
  // Smear the messages over multiple folders for realism.
  const [, yesyesMsgSet, yesnoMsgSet, noyesMsgSet, nonoMsgSet] =
    await messageInjection.makeFoldersWithSets(3, [
      { count: 2, from: abPeeps[0], to: [abPeeps[1]] },
      { count: 2, from: abPeeps[1], to: nonAbPeeps },
      { count: 2, from: nonAbPeeps[0], to: abPeeps },
      { count: 2, from: nonAbPeeps[1], to: [nonAbPeeps[0]] },
    ]);

  // Union the yeses together; we don't care about their composition.
  const yesMsgSet = yesyesMsgSet.union(yesnoMsgSet).union(noyesMsgSet),
    noMsgSet = nonoMsgSet;

  // - Let gloda index the messages so the identities get created.
  await waitForGlodaIndexer();
  Assert.ok(
    ...assertExpectedMessagesIndexed([yesMsgSet, noMsgSet], { augment: true })
  );
  // The messages are now indexed and the contacts created.

  // - Compel an indexing sweep so the folder's dirty statuses get cleared
  GlodaMsgIndexer.initialSweep();
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([])); // (no new messages to index)

  // - Force a DB commit so the pending commit tracker gets emptied out
  // (otherwise we need to worry about its state overriding our clobbering)
  await waitForGlodaDBFlush();

  // - Delete the contact records for the people in the address book.
  await sqlRun(
    "DELETE FROM contacts WHERE id IN (" +
      yesMsgSet.glodaMessages[0].from.contact.id +
      ", " +
      yesMsgSet.glodaMessages[0].to[0].contact.id +
      ")"
  );

  // - Nuke the gloda caches so we totally forget those contact records.
  nukeGlodaCachesAndCollections();

  // - Manually mark the messages involving the inAB people with the _old_ bad
  //    id marker so that our scan will see them.
  for (const msgHdr of yesMsgSet.msgHdrs()) {
    msgHdr.setUint32Property("gloda-id", GLODA_OLD_BAD_MESSAGE_ID);
  }

  // - Mark the db schema version to the version with the bug (26).
  // Sanity check that gloda actually populates the value with the current
  //  version correctly.
  Assert.equal(
    GlodaDatastore._actualSchemaVersion,
    GlodaDatastore._schemaVersion
  );
  GlodaDatastore._actualSchemaVersion = 26;
  await sqlRun("PRAGMA user_version = 26");
  // Make sure that took, since we check it below as a success indicator.
  let verRows = await sqlRun("PRAGMA user_version");
  Assert.equal(verRows[0].getInt64(0), 26);

  // -- Test
  // - Trigger the migration logic and request an indexing sweep.
  GlodaMsgIndexer.disable();
  GlodaMsgIndexer.enable();
  GlodaMsgIndexer.initialSweep();

  // - Wait for the indexer to complete, expecting that the messages that we
  //    marked bad will get indexed but not the good messages.
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([yesMsgSet], { augment: true }));

  // - Verify that the identities have contacts again.
  // Must have the contact object.
  Assert.notEqual(yesMsgSet.glodaMessages[0].from.contact, undefined);
  // The contact's name should come from the address book card
  Assert.equal(yesMsgSet.glodaMessages[0].from.contact.name, abPeeps[0][0]);

  // - Verify that the schema version changed from gloda's perspective and from
  //    the db's perspective.
  verRows = await sqlRun("PRAGMA user_version");
  Assert.equal(verRows[0].getInt64(0), GlodaDatastore._schemaVersion);
  Assert.equal(
    GlodaDatastore._actualSchemaVersion,
    GlodaDatastore._schemaVersion
  );
});

const VERSION_PREF = "mailnews.database.global.datastore.notabilityVersion";

/**
 * The notability stored with each of a set's messages.
 *
 * @param {SyntheticMessageSet} aMsgSet - Indexed with { augment: true }.
 * @returns {Promise<number[]>}
 */
async function storedNotabilities(aMsgSet) {
  const ids = aMsgSet.glodaMessages.map(message => message.id).join(", ");
  const rows = await sqlRun(
    `SELECT notability FROM messages WHERE id IN (${ids})`
  );
  return rows.map(row => row.getInt64(0));
}

/**
 * Store a number for each of a set's messages as an older version of the
 *  rules did, and have the repair rescore them from that version.
 *
 * @param {SyntheticMessageSet} aMsgSet
 * @param {number} aNotability - What the older rules stored.
 * @param {number} aVersion - Which rules those were.
 */
async function repairFrom(aMsgSet, aNotability, aVersion) {
  const ids = aMsgSet.glodaMessages.map(message => message.id).join(", ");
  await sqlRun(
    `UPDATE messages SET notability = ${aNotability} WHERE id IN (${ids})`
  );
  nukeGlodaCachesAndCollections();
  Services.prefs.setIntPref(VERSION_PREF, aVersion);

  GlodaMsgIndexer._notabilityRepairInitiated = false;
  GlodaMsgIndexer.disable();
  GlodaMsgIndexer.enable();
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([]));
  await waitForGlodaDBFlush();
  Assert.equal(
    Services.prefs.getIntPref(VERSION_PREF),
    GlodaDatastore._notabilityVersion,
    "the repair records the rules it rescored by"
  );
}

/**
 * A sender or recipient without an address book card adds no notability, and
 *  a database indexed while each of them counted as having one is rescored
 *  once.
 */
add_task(async function test_fix_inflated_notability() {
  // A database gloda creates has nothing to repair.
  Assert.equal(
    Services.prefs.getIntPref(VERSION_PREF),
    GlodaDatastore._notabilityVersion
  );

  // - Mail from someone without a card to four people, one with a card.
  const abPeeps = msgGen.makeNamesAndAddresses(1);
  const nonAbPeeps = msgGen.makeNamesAndAddresses(4);
  makeABCardForAddressPair(abPeeps[0]);
  const [, msgSet] = await messageInjection.makeFoldersWithSets(1, [
    { count: 2, from: nonAbPeeps[0], to: [...nonAbPeeps.slice(1), abPeeps[0]] },
  ]);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([msgSet], { augment: true }));
  await waitForGlodaDBFlush();

  // Only the recipient with a card counts, as the first address book contact
  //  involved: 8 points.
  Assert.deepEqual(await storedNotabilities(msgSet), [8, 8]);

  // -- Test: what counting everyone gave -- 10 for the sender, 8 + 3 * 2 for
  //    the recipients -- is put right.
  await repairFrom(msgSet, 24, 0);
  Assert.deepEqual(await storedNotabilities(msgSet), [8, 8]);
});

/**
 * However many people from the address book a message involves, they add no
 *  more than a star -- when it is indexed, and when a database scored without
 *  that limit is rescored.
 */
add_task(async function test_addr_book_involvement_is_capped() {
  const abPeeps = msgGen.makeNamesAndAddresses(6);
  for (const peep of abPeeps) {
    makeABCardForAddressPair(peep);
  }
  const [, msgSet] = await messageInjection.makeFoldersWithSets(1, [
    { count: 1, from: msgGen.makeNameAndAddress(), to: abPeeps },
  ]);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([msgSet], { augment: true }));
  await waitForGlodaDBFlush();

  // 8 for the first and 2 for each of the other five would be 18.
  Assert.deepEqual(await storedNotabilities(msgSet), [16]);

  // -- Test
  await repairFrom(msgSet, 18, 1);
  Assert.deepEqual(await storedNotabilities(msgSet), [16]);
});
