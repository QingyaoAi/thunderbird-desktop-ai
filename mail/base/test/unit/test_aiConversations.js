/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for AIConversations: keeping the AI panel's conversations, listing
 * them latest first, reading one back whole, and deleting them -- one by one,
 * or with the dsh session they were answered in.
 */

const { AIConversations } = ChromeUtils.importESModule(
  "resource:///modules/AIConversations.sys.mjs"
);

const dir = () => PathUtils.join(PathUtils.profileDir, "ai-conversations");

/**
 * A conversation with one exchange in it, as the panel records one.
 *
 * @param {string} question
 * @returns {object}
 */
function makeConversation(question) {
  const record = AIConversations.create(question);
  record.turns.push(
    { role: "user", text: question },
    {
      role: "assistant",
      agent: "model",
      parts: [{ type: "answer", text: `An answer to ${question}` }],
    }
  );
  record.messages.push(
    { role: "user", content: question },
    { role: "assistant", content: `An answer to ${question}` }
  );
  return record;
}

add_task(async function testNothingYet() {
  Assert.deepEqual(await AIConversations.list(), [], "no conversations");
  Assert.equal(await AIConversations.load("nothing-here"), null);
});

add_task(function testTitles() {
  Assert.equal(
    AIConversations.titleFor("  What did\n  they   decide?  "),
    "What did they decide?",
    "a question is put on one line"
  );
  const long = AIConversations.titleFor("word ".repeat(40));
  Assert.equal(long.length, 80, "a long one is cut short");
  Assert.ok(long.endsWith("…"), "and says so");
});

add_task(async function testSavingAndReading() {
  const record = makeConversation("When is the meeting?");
  record.mentions.set("Budget review", "imap-message://x/INBOX#7");
  record.dsh = { sessionId: "s-1", workspace: "/work" };
  await AIConversations.save(record);

  const listed = await AIConversations.list();
  Assert.equal(listed.length, 1);
  Assert.deepEqual(
    Object.keys(listed[0]).sort(),
    ["created", "dsh", "id", "title", "updated"],
    "the list has what it shows, not the conversation itself"
  );
  Assert.equal(listed[0].title, "When is the meeting?");
  Assert.deepEqual(listed[0].dsh, { sessionId: "s-1", workspace: "/work" });

  const loaded = await AIConversations.load(record.id);
  Assert.deepEqual(loaded.turns, record.turns, "what was shown comes back");
  Assert.deepEqual(
    loaded.messages,
    record.messages,
    "and what the model was sent"
  );
  // A Map of the module's own global, so not an instanceof this one's Map.
  Assert.equal(
    Object.prototype.toString.call(loaded.mentions),
    "[object Map]",
    "mentions come back as a Map"
  );
  Assert.equal(loaded.mentions.size, 1);
  Assert.equal(
    loaded.mentions.get("Budget review"),
    "imap-message://x/INBOX#7"
  );
});

add_task(async function testLatestFirst() {
  const older = makeConversation("older");
  older.updated = "2026-01-01T00:00:00.000Z";
  await AIConversations.save(older);
  // Saving is what marks a conversation as updated in the panel; here it is
  // set by hand so the order does not depend on the clock.
  const index = PathUtils.join(dir(), "index.json");
  const { conversations } = await IOUtils.readJSON(index);
  Assert.equal(conversations.length, 2);

  const newer = makeConversation("newer");
  newer.updated = "2027-01-01T00:00:00.000Z";
  await AIConversations.save(newer);
  const titles = (await AIConversations.list()).map(entry => entry.title);
  Assert.deepEqual(titles, ["newer", "When is the meeting?", "older"]);

  // Saved again with a later time, the oldest comes first.
  older.updated = "2028-01-01T00:00:00.000Z";
  older.turns.push({ role: "user", text: "and then?" });
  await AIConversations.save(older);
  Assert.equal((await AIConversations.list())[0].title, "older");
  Assert.equal(
    (await AIConversations.list()).length,
    3,
    "saving again does not list it twice"
  );
  Assert.equal((await AIConversations.load(older.id)).turns.length, 3);
});

add_task(async function testALostIndexIsRebuilt() {
  const before = await AIConversations.list();
  await IOUtils.remove(PathUtils.join(dir(), "index.json"));
  // Something that is not a conversation, beside them.
  await IOUtils.writeUTF8(PathUtils.join(dir(), "notes.json"), "not json");
  Assert.deepEqual(
    await AIConversations.list(),
    before,
    "the list is worked out from the files"
  );
});

add_task(async function testRemoving() {
  const [first, second] = await AIConversations.list();
  const removed = await AIConversations.remove([first.id, "../escape"]);
  Assert.deepEqual(
    removed.map(entry => entry.id),
    [first.id],
    "the one asked for, and nothing outside the folder"
  );
  Assert.equal(await AIConversations.load(first.id), null, "it is gone");
  Assert.ok(!(await IOUtils.exists(PathUtils.join(dir(), `${first.id}.json`))));
  Assert.ok(
    (await AIConversations.list()).every(entry => entry.id != first.id),
    "and off the list"
  );
  Assert.ok(await AIConversations.load(second.id), "the others are kept");
});

add_task(async function testASaveAfterRemovingDoesNotBringItBack() {
  const record = makeConversation("short-lived");
  await AIConversations.save(record);
  // As when an answer ends just after its conversation was deleted.
  const removing = AIConversations.remove([record.id]);
  const saving = AIConversations.save(record);
  await Promise.all([removing, saving]);
  Assert.equal(await AIConversations.load(record.id), null);
});

add_task(async function testRemovingWithDshSessions() {
  const answeredByDsh = makeConversation("asked dsh");
  answeredByDsh.dsh = { sessionId: "s-gone", workspace: "/work" };
  await AIConversations.save(answeredByDsh);
  const kept = makeConversation("asked dsh too");
  kept.dsh = { sessionId: "s-kept", workspace: "/work" };
  await AIConversations.save(kept);

  const removed = await AIConversations.removeForDshSessions([
    "s-gone",
    "s-never-heard-of",
  ]);
  Assert.deepEqual(removed, [answeredByDsh.id]);
  Assert.equal(await AIConversations.load(answeredByDsh.id), null);
  Assert.ok(await AIConversations.load(kept.id), "another session's is kept");
  Assert.ok(
    (await AIConversations.list()).some(entry => !entry.dsh),
    "and so is one dsh did not answer"
  );
});
