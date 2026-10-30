/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Gloda } from "resource:///modules/gloda/GlodaPublic.sys.mjs";

import { GlodaConstants } from "resource:///modules/gloda/GlodaConstants.sys.mjs";
import { GlodaDatastore } from "resource:///modules/gloda/GlodaDatastore.sys.mjs";

/**
 * How much time boost should a 'score point' amount to?  The authoritative,
 *  incontrivertible answer, across all time and space, is a week.
 *  Note that gloda stores timestamps as PRTimes for no exceedingly good
 *  reason.
 */
var FUZZSCORE_TIMESTAMP_FACTOR = 1000 * 1000 * 60 * 60 * 24 * 7;

/**
 * The weight of each messagesText column -- body, subject, attachment names,
 *  author, recipients -- both in the ranking that picks which matches are
 *  retrieved (glodaRank, in DASCORE) and in the one that orders them
 *  (scoreBM25F).
 *
 * These, and BM25F's parameters below, are what found a sought message best
 *  in 400 simulated searches of a real mailbox of a hundred thousand
 *  messages (October 2026): two words of a message's subject, three of its
 *  body, or its sender's name, ranked among everything the search found.
 *  The weights gloda had, 2 for a subject and 1.5 for a person, let a body
 *  that repeats a word outrank a subject that has it.  Around these values
 *  the results hardly change.
 */
var COLUMN_WEIGHTS = [1, 20, 20, 5, 5];

var RANK_USAGE =
  "glodaRank(matchinfo(messagesText), " + COLUMN_WEIGHTS.join(", ") + ")";

/**
 * User-facing field prefixes for multi-field search (e.g. "subject:budget",
 * 'from:"Jane Doe"'), mapped to the messagesText FTS3 column the term is
 * then restricted to. Every column is searched anyway for an unscoped
 * term; this just lets a query target one explicitly. Only these
 * whitelisted names are treated as field prefixes, so an incidental colon
 * elsewhere in a query (a time like "10:30", a URL) is left alone.
 */
var FIELD_ALIASES = {
  body: "body",
  subject: "subject",
  attachment: "attachmentNames",
  attachments: "attachmentNames",
  from: "author",
  author: "author",
  to: "recipients",
  cc: "recipients",
  recipient: "recipients",
  recipients: "recipients",
};

/**
 * A run of text in the scripts written without spaces between words: han,
 *  hiragana and katakana.  Hangul is left out, as Korean puts spaces between
 *  its words.  The group makes split() keep the runs it splits at.
 */
var CJK_RUN =
  /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc]+)/u;

/**
 * Function words a search for CJK text is better off without.  Searching for
 *  "意大利的签证" must not demand the 的, nor "去意大利" the 去.  Only where
 *  the segmenter took them for words of their own, and a character only as
 *  below.
 *
 * Particles go wherever they are.
 */
var CJK_PARTICLES = new Set("的地得了着吗呢吧啊呀么のはをにがでとへやかも");
/**
 * These characters go only where all the single characters around them are
 *  function words too ("护照寄回来了吗"): many of them are found in people's
 *  names as well ("王有才"), and the characters of a name the segmenter does
 *  not know come out single.
 */
var CJK_STOP_CHARS = new Set(
  "过和与及或跟同并在于是把被将给对从向往到由为以之其而且也都就才又还但这那此该" +
    "我你您他她它们个些去来有没请能"
);
var CJK_STOP_WORDS = new Set([
  "我的",
  "你的",
  "您的",
  "他的",
  "她的",
  "它的",
  "我们",
  "你们",
  "他们",
  "她们",
  "关于",
  "有关",
  "以及",
  "还有",
  "一个",
  "这个",
  "那个",
  "什么",
  "什么时候",
  "为什么",
  "哪个",
  "哪些",
  "哪里",
  "怎么",
  "怎样",
  "怎么样",
  "如何",
  "是否",
  "是不是",
  "有没有",
  "一下",
]);

var wordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });

/**
 * Split a run of CJK text into the words a search for it should require.
 *
 * Without this, a run went to FTS3 whole, as one phrase, and matched only
 *  text that had all of it in that order with nothing between: "意大利签证"
 *  missed a mail saying "意大利使领馆正在审核签证申请".  The segmenter's
 *  dictionary splits the run into words, which are then required one by
 *  one.  It splits what it does not know -- most people's names -- into
 *  single characters, though, and the index cannot find a single character
 *  well: it holds CJK text as overlapping pairs, so a character can only be
 *  looked for as the start of a pair, and one that ends its run of text is
 *  not found at all.  So the single characters are put back together: two
 *  or more in a row ("韩", "怡") make one word, and one on its own joins the
 *  word before it ("大使", "馆"), or after it when it comes first ("王",
 *  "小明").
 *
 * @param {string} aRun - CJK characters only.
 * @returns {string[]} Its words, each a substring of the run; the run itself
 *   if it is nothing but function words.
 */
function splitCJKRun(aRun) {
  const segments = Array.from(wordSegmenter.segment(aRun), s => s.segment);

  // Runs of words with the function words taken out, each word a list of
  //  segments: one for a word the segmenter knew, the characters for one it
  //  did not.
  const runs = [[]];
  let chars = [];
  const endChars = () => {
    if (chars.some(char => !CJK_STOP_CHARS.has(char))) {
      runs.at(-1).push(chars);
    } else if (chars.length) {
      runs.push([]);
    }
    chars = [];
  };
  for (const segment of segments) {
    if (CJK_PARTICLES.has(segment)) {
      endChars();
      runs.push([]);
    } else if (segment.length == 1) {
      chars.push(segment);
    } else {
      endChars();
      if (CJK_STOP_WORDS.has(segment)) {
        runs.push([]);
      } else {
        runs.at(-1).push([segment]);
      }
    }
  }
  endChars();

  const words = [];
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      if (run[i].length == 1 && run[i][0].length == 1 && run.length > 1) {
        if (i > 0) {
          run[i - 1].push(run[i][0]);
        } else {
          run[i + 1].unshift(run[i][0]);
        }
        run.splice(i--, 1);
      }
    }
    words.push(...run.map(word => word.join("")));
  }
  return words.length ? words : [aRun];
}

/**
 * Split a search term into the words a search for it should require: the CJK
 *  text in it into its words (see splitCJKRun), and away from the text in
 *  other scripts beside it, which loses the punctuation around it.  A term
 *  with no CJK text is returned as it is.
 *
 * @param {string} aTerm - A term with no whitespace in it.
 * @returns {string[]}
 */
export function splitSearchTerm(aTerm) {
  const parts = aTerm.split(CJK_RUN);
  if (parts.length == 1) {
    return [aTerm];
  }
  const words = [];
  for (const [i, part] of parts.entries()) {
    if (i % 2) {
      words.push(...splitCJKRun(part));
    } else {
      const trimmed = part.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
      if (trimmed) {
        words.push(trimmed);
      }
    }
  }
  return words;
}

var DASCORE =
  "(((" +
  RANK_USAGE +
  " + messages.notability) * " +
  FUZZSCORE_TIMESTAMP_FACTOR +
  ") + messages.date)";

/**
 * A new optimization decision we are making is that we do not want to carry
 *  around any data in our ephemeral tables that is not used for whittling the
 *  result set.  The idea is that the btree page cache or OS cache is going to
 *  save us from the disk seeks and carrying around the extra data is just going
 *  to be CPU/memory churn that slows us down.
 *
 * Additionally, we try and avoid row lookups that would have their results
 *  discarded by the LIMIT.  Because of limitations in FTS3 (which might
 *  be addressed in FTS4 by a feature request), we can't avoid the 'messages'
 *  lookup since that has the message's date and static notability but we can
 *  defer the 'messagesText' lookup.
 *
 * This is the access pattern we are after here:
 * 1) Order the matches with minimized lookup and result storage costs.
 * - The innermost MATCH does the doclist magic and provides us with
 *    matchinfo() support which does not require content row retrieval
 *    from messagesText.  Unfortunately, this is not enough to whittle anything
 *    because we still need static interestingness, so...
 * - Based on the match we retrieve the date and notability for that row from
 *    'messages' using this in conjunction with matchinfo() to provide a score
 *    that we can then use to LIMIT our results.
 * 2) We reissue the MATCH query so that we will be able to use matchinfo() and
 *    the lengths of the columns, but we intersect the results of this MATCH
 *    against our LIMITed results from step 1.
 * - We use 'docid IN (phase 1 query)' to accomplish this because it results in
 *    efficient lookup.  If we just use a join, we get O(mn) performance because
 *    a cartesian join ends up being performed where either we end up performing
 *    the fulltext query M times and table scan intersect with the results from
 *    phase 1 or we do the fulltext once but traverse the entire result set from
 *    phase 1 N times.
 * - We believe that the re-execution of the MATCH query should have no disk
 *    costs because it should still be cached by SQLite or the OS.  In the case
 *    where memory is so constrained this is not true our behavior is still
 *    probably preferable than the old way because that would have caused lots
 *    of swapping.
 * - This part of the query otherwise resembles the basic gloda query but with
 *    the inclusion of what scoreBM25F needs.  The messages table lookup
 *    should not involve any disk traffic because the pages should still be
 *    cached (SQLite or OS) from phase 1.  The messagesText lookup is new, and
 *    this is the major disk-seek reduction optimization we are making.  (Since
 *    we avoid this lookup for all of the documents that were excluded by the
 *    LIMIT.)  Since the column lengths also need the row from messagesText
 *    there is a nice synergy there.
 * - matchinfo() is a blob, which the row reader does not take, so it comes
 *    hex-encoded.  Each row has its own counts ('pcy'); the counts over all
 *    messages ('x'), the same for every row, come once, from a subquery
 *    SQLite runs once: asked for row by row they made a search slower by
 *    half.  (offsets() went: nothing reads it any more, and it ran the
 *    tokenizer over the whole of each message again.)
 */
var NUEVO_FULLTEXT_SQL =
  "SELECT messages.*, messagesText.*," +
  " hex(matchinfo(messagesText, 'pcy')) AS minfo," +
  " (SELECT hex(matchinfo(messagesText, 'x')) FROM messagesText" +
  " WHERE messagesText MATCH ?1 LIMIT 1) AS ginfo," +
  " printf('%d %d %d %d %d', octet_length(messagesText.body)," +
  " octet_length(messagesText.subject)," +
  " octet_length(messagesText.attachmentNames)," +
  " octet_length(messagesText.author)," +
  " octet_length(messagesText.recipients)) AS lengths " +
  "FROM messagesText, messages " +
  "WHERE" +
  " messagesText MATCH ?1 " +
  " AND messagesText.docid IN (" +
  "SELECT docid " +
  "FROM messagesText JOIN messages ON messagesText.docid = messages.id " +
  "WHERE messagesText MATCH ?1 " +
  "ORDER BY " +
  DASCORE +
  " DESC " +
  "LIMIT ?2" +
  " )" +
  " AND messages.id = messagesText.docid " +
  " AND +messages.deleted = 0" +
  " AND +messages.folderID IS NOT NULL" +
  " AND +messages.messageKey IS NOT NULL";

/**
 * BM25F's parameters: k1, how soon more occurrences of a term stop adding to
 *  a message's score, and b, how far a column's length against the average
 *  discounts them.  Chosen as COLUMN_WEIGHTS were; Anserini's defaults (0.9
 *  and 0.4) found the sought message less often.  A k1 this high suits the
 *  weights, which make one word in a subject twenty occurrences.
 */
var BM25F_K1 = 3;
var BM25F_B = 0.85;

/**
 * The points a message's text earns for a full BM25F score; it earns a share
 *  of them (see scoreBM25F).  This sets what the text is worth against a
 *  message's notability and its age, a point a week.  Chosen as
 *  COLUMN_WEIGHTS were, scoring a sought message's rank both as it is and
 *  weighted to recent messages, as people mostly look for those: the more
 *  of the two counts, the less the date (the scores this replaced, and the
 *  80 first given here to match them, found the sought message less often).
 *  Where texts score alike, as for a word everything has, the date still
 *  decides.
 */
var BM25F_SCALE = 320;

/**
 * The pref the index's statistics are kept in between sessions (see
 *  loadCollectionStats).
 */
var STATS_PREF = "mailnews.database.global.search.bm25fStats";

/**
 * What stands in for the index's statistics until they are counted, as on a
 *  profile's first search: about those of a hundred thousand messages.
 */
var DEFAULT_STATS = { docs: 100000, avgLengths: [2800, 55, 6, 52, 127] };

/**
 * The index's statistics, as counted this session or the last: `docs`, the
 *  number of messages, and `avgLengths`, the mean length of each column.
 *
 * @type {?{docs: number, avgLengths: number[]}}
 */
var collectionStats = null;
try {
  const stored = JSON.parse(Services.prefs.getStringPref(STATS_PREF, "null"));
  if (stored?.docs > 0 && stored.avgLengths?.length == COLUMN_WEIGHTS.length) {
    collectionStats = stored;
  }
} catch (ex) {
  // Not stored, or not as we store it: counted again soon enough.
}
var collectionStatsPromise = null;

/**
 * Count the statistics of the index BM25F needs and FTS3 does not keep
 *  (FTS4's matchinfo() has them): how many messages there are, and the mean
 *  length of each column, in UTF-8 bytes -- tokens would mean running the
 *  tokenizer over everything.  It reads every row of the fulltext table, a
 *  second with a cold cache for a hundred thousand messages, so it runs once
 *  a session, after a search, and the result is kept for the first searches
 *  of the next.  It reads FTS3's own table of the text, where octet_length()
 *  takes a length from the row without reading the text itself.
 *
 * @returns {Promise<?object>} The statistics, as collectionStats has them.
 */
export function loadCollectionStats() {
  if (!collectionStatsPromise) {
    collectionStatsPromise = new Promise(resolve => {
      let stats = null;
      const statement = GlodaDatastore._createAsyncStatement(
        "SELECT count(*), avg(octet_length(c0body))," +
          " avg(octet_length(c1subject))," +
          " avg(octet_length(c2attachmentNames))," +
          " avg(octet_length(c3author))," +
          " avg(octet_length(c4recipients)) " +
          "FROM messagesText_content",
        true
      );
      statement.executeAsync({
        handleResult(aResultSet) {
          const row = aResultSet.getNextRow();
          stats = {
            docs: row.getInt64(0),
            avgLengths: [1, 2, 3, 4, 5].map(i => row.getDouble(i)),
          };
        },
        handleError(aError) {
          console.error("Could not count the search index:", aError.message);
        },
        handleCompletion() {
          GlodaDatastore._asyncCompleted();
          if (stats?.docs > 0) {
            collectionStats = stats;
            Services.prefs.setStringPref(STATS_PREF, JSON.stringify(stats));
          }
          resolve(collectionStats);
        },
      });
      statement.finalize();
      GlodaDatastore._pendingAsyncStatements++;
    });
  }
  return collectionStatsPromise;
}

/**
 * Score the message's text by BM25F (Robertson, Zaragoza and Taylor, "Simple
 *  BM25 extension to multiple weighted fields", 2004): a term's occurrences
 *  in each column are weighted by the column and discounted by the column's
 *  length against its average, and only their sum is saturated, once for
 *  the term.
 *
 * The terms are the query's phrases -- a quoted term, a word of CJK text --
 *  and the counts are matchinfo()'s, for each phrase and column: how often
 *  it occurs in this message ('pcy'), and in how many messages ('x', its
 *  third number of three).  That is the IDF's document frequency; FTS3
 *  counts it only column by column, and the largest of those stands in for
 *  the count over the whole message.  The column lengths are in UTF-8
 *  bytes, as the averages are.
 *
 * The sum is divided by the most the query could score -- every phrase,
 *  endlessly often -- so that what the text counts for against notability
 *  and age does not depend on how rare the query's words are; then scaled by
 *  BM25F_SCALE.  (So BM25's k1 + 1 factor, the same above and below, is left
 *  out.)
 *
 * @param {GlodaMessage} aMessage
 * @param {object} aContext - The search's stashedColumns, and the index
 *   statistics it scores with as `stats`.
 * @returns {number}
 */
function scoreBM25F(aMessage, aContext) {
  const [matchinfo, globalMatchinfo, lengths] =
    aContext.stashedColumns[aMessage.id];
  if (!matchinfo || !globalMatchinfo) {
    return 0;
  }
  const decode = hex => new Uint32Array(Uint8Array.fromHex(hex).buffer);
  const info = decode(matchinfo);
  const globalInfo = decode(globalMatchinfo);
  const [phraseCount, columnCount] = info;
  const columnLengths = lengths.split(" ").map(Number);
  const { docs, avgLengths } = aContext.stats;

  let score = 0;
  let maxScore = 0;
  for (let iPhrase = 0; iPhrase < phraseCount; iPhrase++) {
    let tf = 0;
    let df = 0;
    for (let iColumn = 0; iColumn < columnCount; iColumn++) {
      const at = iPhrase * columnCount + iColumn;
      const lengthRatio = avgLengths[iColumn]
        ? columnLengths[iColumn] / avgLengths[iColumn]
        : 1;
      tf +=
        (COLUMN_WEIGHTS[iColumn] * info[2 + at]) /
        (1 - BM25F_B + BM25F_B * lengthRatio);
      df = Math.max(df, globalInfo[3 * at + 2]);
    }
    // Lucene's IDF, which never goes below zero.
    const idf = Math.log(1 + (Math.max(docs, df) - df + 0.5) / (df + 0.5));
    score += (idf * tf) / (BM25F_K1 + tf);
    maxScore += idf;
  }
  return maxScore ? (score / maxScore) * BM25F_SCALE : 0;
}

/**
 * Score the message on its date, at the exchange rate DASCORE uses: a point
 *  for each week.  This is the DASCORE date term divided through by
 *  FUZZSCORE_TIMESTAMP_FACTOR, so a message a week newer is worth one more
 *  point.  Without it the relevance order kept the date only as a tie-break:
 *  a star and a tag (24 points) put a message above every unstarred one
 *  however old it was, so searching for a person listed their 2023 mail
 *  before this year's.
 *
 * @param {GlodaMessage} aMessage
 */
function scoreDate(aMessage) {
  return ((aMessage.date ?? 0) * 1000) / FUZZSCORE_TIMESTAMP_FACTOR;
}

/**
 * What a message earns for each CJK phrase the search split into words (see
 *  splitCJKRun) that it has as typed, the words together and in order.  The
 *  words found apart are a weaker match -- before the split they were no
 *  match at all -- and this keeps them below the text that was asked for
 *  unless they are a good deal newer: some five months.
 */
var PHRASE_MATCH_SCORE = 20;

/**
 * Score the message on the split CJK phrases (aContext.phrases) it has as
 *  typed.  Author and recipients are not loaded with a search's results, and
 *  are left out.
 *
 * @param {GlodaMessage} aMessage
 * @param {object} aContext
 */
function scorePhrases(aMessage, aContext) {
  let score = 0;
  for (const phrase of aContext.phrases) {
    if (
      aMessage.subject?.includes(phrase) ||
      aMessage.indexedBodyText?.includes(phrase) ||
      aMessage.attachmentNames?.some(name => name.includes(phrase))
    ) {
      score += PHRASE_MATCH_SCORE;
    }
  }
  return score;
}

/**
 * The searcher basically looks like a query, but is specialized for fulltext
 *  search against messages.  Most of the explicit specialization involves
 *  crafting a SQL query that attempts to order the matches by likelihood that
 *  the user was looking for it.  This is based on full-text matches combined
 *  with an explicit (generic) interest score value placed on the message at
 *  indexing time.  This is followed by using the more generic gloda scoring
 *  mechanism to explicitly score the messages given the search context in
 *  addition to the more generic score adjusting rules.
 */
export function GlodaMsgSearcher(aListener, aSearchString, aAndTerms) {
  this.listener = aListener;

  this.searchString = aSearchString;
  this.fulltextTerms = this.parseSearchString(aSearchString);
  this.andTerms = aAndTerms != null ? aAndTerms : true;

  this.query = null;
  this.collection = null;

  this.scores = null;
}

GlodaMsgSearcher.prototype = {
  /**
   * Number of messages to retrieve initially.
   */
  get retrievalLimit() {
    return Services.prefs.getIntPref(
      "mailnews.database.global.search.msg.limit"
    );
  },

  /**
   * Parse the string into terms/phrases by finding matching double-quotes.
   * Each returned term is `{ text, field, phrase }`, where `field` is the
   * messagesText column (see FIELD_ALIASES) that a "field:" prefix
   * restricted the term to, or null for a normal unscoped term, and `phrase`
   * says the term was quoted.
   */
  parseSearchString(aSearchString) {
    // Any space separates terms, including the ideographic one a Chinese or
    //  Japanese input method types, which the tokenizer does not take for a
    //  space at all.
    aSearchString = aSearchString.replace(/\s/g, " ").trim();
    const terms = [];

    /*
     * Add the term as long as the trim on the way in didn't obliterate it.
     *
     * In the future this might have other helper logic; it did once before.
     */
    function addTerm(aTerm, aField, aPhrase = false) {
      if (aTerm) {
        terms.push({ text: aTerm, field: aField || null, phrase: aPhrase });
      }
    }

    while (aSearchString) {
      // Pull off a recognized "field:" prefix first, so that both
      // "subject:budget" and 'from:"Jane Doe"' work.
      let field = null;
      const fieldMatch = /^([A-Za-z]+):(\S.*)?$/s.exec(aSearchString);
      if (fieldMatch) {
        const alias = fieldMatch[1].toLowerCase();
        if (Object.hasOwn(FIELD_ALIASES, alias)) {
          field = FIELD_ALIASES[alias];
          aSearchString = fieldMatch[2] || "";
        }
      }

      if (aSearchString.startsWith('"')) {
        const endIndex = aSearchString.indexOf(aSearchString[0], 1);
        // eat the quote if it has no friend
        if (endIndex == -1) {
          aSearchString = aSearchString.substring(1);
          continue;
        }

        addTerm(aSearchString.substring(1, endIndex).trim(), field, true);
        aSearchString = aSearchString.substring(endIndex + 1);
        continue;
      }

      const spaceIndex = aSearchString.indexOf(" ");
      if (spaceIndex == -1) {
        addTerm(aSearchString, field);
        break;
      }

      addTerm(aSearchString.substring(0, spaceIndex), field);
      aSearchString = aSearchString.substring(spaceIndex + 1);
    }

    return terms;
  },

  buildFulltextQuery() {
    const query = Gloda.newQuery(GlodaConstants.NOUN_MESSAGE, {
      noMagic: true,
      explicitSQL: NUEVO_FULLTEXT_SQL,
      limitClauseAlreadyIncluded: true,
      // minfo, ginfo and lengths are 0-based column numbers 14 to 16
      // (volatile to column changes); save them for scoreBM25F
      stashColumns: [14, 15, 16],
    });

    query.fulltextMatches(this.buildFulltextQueryString());
    query.limit(this.retrievalLimit);

    return query;
  },

  /**
   * The FTS3 MATCH expression for our terms.
   *
   * @returns {string}
   */
  buildFulltextQueryString() {
    // Our tokenizer treats anything at/above 0x2000 as CJK for now.
    const isSingleCJK = text =>
      text.length == 1 && text.charCodeAt(0) >= 0x2000;
    const isSearchable = text =>
      (text.length == 2 &&
        text.charCodeAt(0) >= 0x2000 &&
        text.charCodeAt(1) >= 0x2000) ||
      text.length >= 3;

    const queryParts = [];
    // [field, character] for each single CJK character a field restricts.
    const fieldPrefixes = [];
    for (const { text, field, phrase } of this.fulltextTerms) {
      if (field) {
        // A "field:" prefix restricts the term to one FTS3 column.  FTS3
        //  takes a column filter only on a bare word, not a quoted one, so
        //  each word of the term goes in bare, with the characters quoting
        //  would have kept from being read as query syntax dropped.
        for (let word of text.split(/[\s"()]+/)) {
          word = word.replace(/^-+/, "");
          for (const piece of splitSearchTerm(word)) {
            const chars = Array.from(piece);
            if (isSingleCJK(piece)) {
              fieldPrefixes.push([field, piece]);
            } else if (chars.length > 1 && chars.every(c => c >= "\u2000")) {
              // FTS3 takes only the first token of a bare word, and the
              //  tokenizer makes one of each pair of these characters; the
              //  rest went unrestricted, or unsearched.  So each pair goes
              //  in as a word of its own.
              for (let i = 1; i < chars.length; i++) {
                queryParts.push(field + ":" + chars[i - 1] + chars[i]);
              }
            } else if (isSearchable(piece)) {
              queryParts.push(field + ":" + piece);
            }
          }
        }
        continue;
      }

      // Put our term in quotes.  This is needed for the tokenizer to be able
      //  to do useful things.  The exception is people clever enough to use
      //  NEAR.
      if (/^NEAR(\/\d+)?$/.test(text)) {
        queryParts.push(text);
        continue;
      }
      // A quoted term is a phrase, wanted as it is; any other is split into
      //  the words it should match by.
      for (const word of phrase ? [text] : splitSearchTerm(text)) {
        if (isSingleCJK(word)) {
          // This is a single-character CJK search query, so add a wildcard.
          //  Inside the quotes, as the tokenizer only lets a wildcard follow
          //  a single character at the very end of the text FTS3 gives it:
          //  bare, the character was dropped unless it came last.
          queryParts.push('"' + word + '*"');
        } else if (isSearchable(word)) {
          queryParts.push('"' + word + '"');
        }
      }
    }

    // A field restricts a character only bare, and so only last (see above);
    //  any others are searched for in every field.
    const lastPrefix = fieldPrefixes.pop();
    for (const [, char] of fieldPrefixes) {
      queryParts.push('"' + char + '*"');
    }
    if (lastPrefix) {
      queryParts.push(lastPrefix[0] + ":" + lastPrefix[1] + "*");
    }

    return queryParts.join(this.andTerms ? " " : " OR ");
  },

  /**
   * The runs of CJK text in our unquoted terms that are searched for as more
   *  than one word (see scorePhrases).
   *
   * @type {string[]}
   */
  get splitPhrases() {
    if (!this._splitPhrases) {
      this._splitPhrases = [];
      for (const { text, field, phrase } of this.fulltextTerms) {
        if (field || phrase) {
          continue;
        }
        const runs = text.split(CJK_RUN).filter((part, i) => i % 2);
        for (const run of runs) {
          if (splitCJKRun(run).length > 1) {
            this._splitPhrases.push(run);
          }
        }
      }
    }
    return this._splitPhrases;
  },

  getCollection(aListenerOverride, aData) {
    if (aListenerOverride) {
      this.listener = aListenerOverride;
    }

    // The statistics this search is scored with, all of it, even if fresher
    //  ones are counted while it runs.
    this.stats = collectionStats ?? DEFAULT_STATS;
    this.query = this.buildFulltextQuery();
    this.collection = this.query.getCollection(this, aData);
    this.completed = false;

    return this.collection;
  },

  sortBy: "-dascore",

  onItemsAdded(aItems, aCollection) {
    const newScores = Gloda.scoreNounItems(
      aItems,
      {
        terms: this.fulltextTerms,
        stashedColumns: aCollection.stashedColumns,
        stats: this.stats,
        phrases: this.splitPhrases,
      },
      [scoreBM25F, scoreDate, scorePhrases]
    );
    if (this.scores) {
      this.scores = this.scores.concat(newScores);
    } else {
      this.scores = newScores;
    }

    if (this.listener) {
      this.listener.onItemsAdded(aItems, aCollection);
    }
  },
  onItemsModified(aItems, aCollection) {
    if (this.listener) {
      this.listener.onItemsModified(aItems, aCollection);
    }
  },
  onItemsRemoved(aItems, aCollection) {
    if (this.listener) {
      this.listener.onItemsRemoved(aItems, aCollection);
    }
  },
  onQueryCompleted(aCollection) {
    this.completed = true;
    if (this.listener) {
      this.listener.onQueryCompleted(aCollection);
    }
    // Once a session, and after the search rather than before it, which
    //  would wait behind the counting.
    loadCollectionStats();
  },
};
