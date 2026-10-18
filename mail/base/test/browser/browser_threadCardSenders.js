/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests that a collapsed thread's card names the last people to write in it,
 * newest first, rather than whoever started the conversation.
 */

const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
const { ensure_cards_view } = ChromeUtils.importESModule(
  "resource://testing-common/MailViewHelpers.sys.mjs"
);

const tabmail = document.getElementById("tabmail");
const about3Pane = tabmail.currentAbout3Pane;
const { threadTree } = about3Pane;

const ALICE = ["Alice Archer", "alice@example.com"];
const BOB = ["Bob Baker", "bob@example.com"];
const CAROL = ["Carol Cooper", "carol@example.com"];
const DAVE = ["Dave Dyer", "dave@example.com"];

let testFolder, messages;

add_setup(async function () {
  const account = MailServices.accounts.createLocalMailAccount();
  account.addIdentity(MailServices.accounts.createIdentity());
  const rootFolder = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  testFolder = rootFolder
    .createLocalSubfolder("threadCardSenders")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);

  const generator = new MessageGenerator();
  const write = (from, days, args = {}) => {
    const message = generator.makeMessage({ ...args, age: { days } });
    // A reply is addressed from whoever the message it answers was sent to,
    // so say who wrote it afterwards.
    message.from = from;
    return message;
  };

  // Alice starts it, Bob and Carol answer, and Bob has the last word.
  const plans = write(ALICE, 8, { subject: "Plans" });
  const plansBob = write(BOB, 7, { inReplyTo: plans });
  const plansCarol = write(CAROL, 6, { inReplyTo: plansBob });
  const plansBobAgain = write(BOB, 5, { inReplyTo: plansCarol });
  // Dave follows up on his own message, and nobody else writes.
  const notes = write(DAVE, 4, { subject: "Notes" });
  const notesDave = write(DAVE, 3, { inReplyTo: notes });

  messages = { plans, plansBob, plansCarol, plansBobAgain, notes, notesDave };
  testFolder.addMessageBatch(
    Object.values(messages).map(message => message.toMessageString())
  );

  about3Pane.displayFolder(testFolder.URI);
  about3Pane.paneLayout.messagePaneVisible = false;
  await ensure_cards_view(document);
  goDoCommand("cmd_sort", { target: { value: "threaded" } });

  registerCleanupFunction(() => {
    MailServices.accounts.removeAccount(account, false);
    about3Pane.paneLayout.messagePaneVisible = true;
  });
});

/**
 * The sender line of every card, by the name its message has in `messages`.
 *
 * @returns {{[name: string]: string}}
 */
async function cardSenders() {
  await new Promise(resolve => about3Pane.requestAnimationFrame(resolve));
  const names = Object.fromEntries(
    Object.entries(messages).map(([name, message]) => [message.messageId, name])
  );
  const senders = {};
  for (let i = 0; i < about3Pane.gDBView.rowCount; i++) {
    const hdr = about3Pane.gDBView.getMsgHdrAt(i);
    senders[names[hdr.messageId]] = threadTree
      .getRowAtIndex(i)
      .querySelector(".sender").textContent;
  }
  return senders;
}

add_task(async function testCollapsedThreadNamesLatestSenders() {
  // Expanded first, so every card names its own message's sender in the
  // view's own words -- which is what the collapsed card has to match.
  goDoCommand("cmd_expandAllThreads");
  const own = await cardSenders();
  Assert.equal(
    own.plansBobAgain,
    "Bob Baker <bob@example.com>",
    "an expanded card should name its own message's sender"
  );
  Assert.equal(
    own.plans,
    "Alice Archer <alice@example.com>",
    "an expanded thread's first card still names who started it"
  );

  goDoCommand("cmd_collapseAllThreads");
  const collapsed = await cardSenders();
  Assert.deepEqual(
    Object.keys(collapsed).sort(),
    ["notes", "plans"],
    "only the two threads' first messages should have cards"
  );
  Assert.equal(
    collapsed.plans,
    `${own.plansBobAgain}, ${own.plansCarol}`,
    "a collapsed thread should name its last two writers, newest first"
  );
  Assert.equal(
    collapsed.notes,
    own.notesDave,
    "someone who wrote twice should be named once"
  );
});
