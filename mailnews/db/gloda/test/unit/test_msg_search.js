/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Test GlodaMsgSearcher.sys.mjs our heuristic-based fulltext search mechanism.  Things we
 *  generally want to verify:
 * - fulltext weighting by where the match happened works.
 * - static interestingness impacts things appropriately.
 *
 * Our general strategy is to create two messages each with a unique string
 *  placed in controlled places and whatever intentional message manipulation
 *  is required to set things up.  Then we query using a GlodaMsgSearcher with
 *  the limit set to 1.  Only the message we expect should come back.
 * Keep in mind in all tests that our underlying ranking mechanism is based on
 *  time so the date of each message is relevant but should not be significant
 *  because our score boost factor should always be well in excess of the one
 *  hour increment between messages.
 *
 * Previously, we relied on the general equivalence of the logic in
 *  test_query_core to our message search logic.
 */

var {
  assertExpectedMessagesIndexed,
  glodaTestHelperInitialize,
  waitForGlodaIndexer,
} = ChromeUtils.importESModule(
  "resource://testing-common/gloda/GlodaTestHelper.sys.mjs"
);
var { queryExpect } = ChromeUtils.importESModule(
  "resource://testing-common/gloda/GlodaQueryHelper.sys.mjs"
);
var { GlodaMsgSearcher } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs"
);
var { waitForGlodaDBFlush } = ChromeUtils.importESModule(
  "resource://testing-common/gloda/GlodaTestHelperFunctions.sys.mjs"
);
var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
var { MessageInjection } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageInjection.sys.mjs"
);

var uniqueCounter = 0;
var messageInjection;

add_setup(async function () {
  const msgGen = new MessageGenerator();
  messageInjection = new MessageInjection({ mode: "local" }, msgGen);
  glodaTestHelperInitialize(messageInjection);
});

/**
 * Verify that the ranking function is using the weights as expected.  We do not
 *  need to test all the permutations
 */
add_task(async function test_fulltext_weighting_by_column() {
  const ustr = unique_string();
  const [, subjSet, bodySet] = await messageInjection.makeFoldersWithSets(1, [
    { count: 1, subject: ustr },
    { count: 1, body: { body: ustr } },
  ]);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([subjSet, bodySet]));
  await asyncMsgSearcherExpect(ustr, subjSet);
});

/**
 * A term mentioned 3 times in the body is worth more than twice in the subject.
 * (This is because the subject saturates at one occurrence worth 2.0 and the
 * body does not saturate until 10, each worth 1.0.)
 */
add_task(async function test_fulltext_weighting_saturation() {
  const ustr = unique_string();
  const double_ustr = ustr + " " + ustr;
  const thrice_ustr = ustr + " " + ustr + " " + ustr;
  const [, subjSet, bodySet] = await messageInjection.makeFoldersWithSets(1, [
    { count: 1, subject: double_ustr },
    { count: 1, body: { body: thrice_ustr } },
  ]);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([subjSet, bodySet]));
  await asyncMsgSearcherExpect(ustr, bodySet);
});

/**
 * Use a starred message with the same fulltext match characteristics as another
 * message to verify the preference goes the right way.  Have the starred
 * message be the older message for safety.
 */
add_task(async function test_static_interestingness_boost_works() {
  const ustr = unique_string();
  const [, starred, notStarred] = await messageInjection.makeFoldersWithSets(
    1,
    [
      { count: 1, subject: ustr },
      { count: 1, subject: ustr },
    ]
  );
  // Index in their native state.
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([starred, notStarred]));
  // Star and index.
  starred.setStarred(true);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([starred]));
  // Stars upon thars wins.
  await asyncMsgSearcherExpect(ustr, starred);
});

/**
 * The scores a searcher hands on, which Search Messages sorts its results by,
 * count a week of age as a point, as DASCORE does.  A star (16 points) still
 * lifts a message above one a day old when it is two weeks old, but not when
 * it is a year old.
 */
add_task(async function test_scores_count_age() {
  const ustr = unique_string();
  const [, oldStarred, recent, recentStarred] =
    await messageInjection.makeFoldersWithSets(1, [
      { count: 1, subject: ustr, age: { weeks: 52 } },
      { count: 1, subject: ustr, age: { days: 1 } },
      { count: 1, subject: ustr, age: { weeks: 2 } },
    ]);
  await waitForGlodaIndexer();
  Assert.ok(
    ...assertExpectedMessagesIndexed([oldStarred, recent, recentStarred])
  );
  oldStarred.setStarred(true);
  recentStarred.setStarred(true);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([oldStarred, recentStarred]));

  const scoreOf = await searchScores(ustr);
  Assert.greater(scoreOf(recentStarred), scoreOf(recent));
  Assert.greater(scoreOf(recent), scoreOf(oldStarred));
});

/**
 * A "field:" prefix limits its term to that field, quoted or not, where an
 * unprefixed term matches anywhere.
 */
add_task(async function test_field_prefixes() {
  const ustr = unique_string();
  const [, subjSet, bodySet, fromSet] =
    await messageInjection.makeFoldersWithSets(1, [
      { count: 1, subject: ustr },
      { count: 1, body: { body: ustr } },
      { count: 1, from: [ustr + " Person", ustr + "@example.com"] },
    ]);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([subjSet, bodySet, fromSet]));

  await asyncMsgSearcherExpect("subject:" + ustr, subjSet, 3);
  await asyncMsgSearcherExpect('subject:"' + ustr + '"', subjSet, 3);
  await asyncMsgSearcherExpect("body:" + ustr, bodySet, 3);
  await asyncMsgSearcherExpect("from:" + ustr, fromSet, 3);
  await asyncMsgSearcherExpect(ustr, subjSet.union(bodySet).union(fromSet), 3);
});

/**
 * A term of several tokens -- a phrase, or CJK text of more than two
 * characters, which the tokenizer takes a pair of characters at a time --
 * gets a score like any other, and a field prefix restricts CJK text too.
 */
add_task(async function test_multi_token_terms() {
  const ustr = unique_string();
  const ustr2 = unique_string();
  const cjk = "精品课程";
  const [, cjkSet, phraseSet] = await messageInjection.makeFoldersWithSets(1, [
    { count: 1, subject: encodeSubject("关于" + cjk + "复审") },
    { count: 1, subject: ustr + " " + ustr2 },
  ]);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([cjkSet, phraseSet]));

  for (const [query, set] of [
    [cjk, cjkSet],
    ['"' + ustr + " " + ustr2 + '"', phraseSet],
  ]) {
    const scoreOf = await searchScores(query);
    Assert.ok(Number.isFinite(scoreOf(set)), `${query} scores a number`);
  }

  await asyncMsgSearcherExpect("subject:" + cjk, cjkSet, 2);
  await asyncMsgSearcherExpect("body:" + cjk, [], 2);
});

/**
 * Make sure that the query does not retrieve more than actually matches.
 */
add_task(async function test_joins_do_not_return_everybody() {
  const ustr = unique_string();
  const [, subjSet] = await messageInjection.makeFoldersWithSets(1, [
    { count: 1, subject: ustr },
  ]);
  await waitForGlodaIndexer();
  Assert.ok(...assertExpectedMessagesIndexed([subjSet]));
  await asyncMsgSearcherExpect(ustr, subjSet, 2);
});

/**
 * Generate strings like "aaaaa", "aabaa", "aacaa", etc.  The idea with the
 * suffix is to avoid the porter stemmer from doing something weird that
 * collapses things.
 */
function unique_string() {
  const uval = uniqueCounter++;
  const s =
    String.fromCharCode(97 + Math.floor(uval / (26 * 26))) +
    String.fromCharCode(97 + (Math.floor(uval / 26) % 26)) +
    String.fromCharCode(97 + (uval % 26)) +
    "aa";
  return s;
}

/**
 * Search for aFulltextStr and return a function giving the score the searcher
 * gave the one message of a set.
 *
 * @param {string} aFulltextStr - The fulltext query string.
 * @returns {Function} From a SyntheticMessageSet to its message's score.
 */
async function searchScores(aFulltextStr) {
  Services.prefs.setIntPref("mailnews.database.global.search.msg.limit", 10);
  const searcher = new GlodaMsgSearcher(null, aFulltextStr);
  const collection = await new Promise(resolve =>
    searcher.getCollection({
      onItemsAdded() {},
      onItemsModified() {},
      onItemsRemoved() {},
      onQueryCompleted: resolve,
    })
  );
  return set => {
    const index = collection.items.findIndex(
      item => item.headerMessageID == set.synMessages[0].messageId
    );
    Assert.greaterOrEqual(index, 0, "the message is in the results");
    return searcher.scores[index];
  };
}

/**
 * MIME-encode a subject that is not ASCII, as a mail client would.
 *
 * @param {string} aText
 * @returns {string}
 */
function encodeSubject(aText) {
  const bytes = new TextEncoder().encode(aText);
  return "=?UTF-8?B?" + btoa(String.fromCharCode(...bytes)) + "?=";
}

/**
 * Wrap the construction of a GlodaMsgSearcher with a limit of 1 and feed it to
 * queryExpect.
 *
 * @param {string} aFulltextStr - The fulltext query string which
 *   GlodaMsgSearcher will parse.
 * @param {object} aExpectedSet The expected result set.  Make sure that the
 *   size of the set is consistent with aLimit.
 * @param {integer} [aLimit=1] - Limit.
 *
 * Use like so:
 *  await asyncMsgSearchExpect("foo bar", someSynMsgSet);
 */
async function asyncMsgSearcherExpect(aFulltextStr, aExpectedSet, aLimit) {
  const limit = aLimit ? aLimit : 1;
  Services.prefs.setIntPref("mailnews.database.global.search.msg.limit", limit);
  const searcher = new GlodaMsgSearcher(null, aFulltextStr);
  await queryExpect(searcher.buildFulltextQuery(), aExpectedSet);
}
