/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Test that mail is written in Body Text by default, and that Enter keeps it
 * there. Paragraph is still a choice, and once made, Enter goes on making
 * paragraphs.
 *
 * browser_paragraph_state.js covers the paragraph states themselves but cannot
 * run on macOS, since it opens the Format menu. This reads the state from the
 * toolbar selector alone.
 */

var {
  close_compose_window,
  open_compose_new_mail,
  open_compose_with_reply,
  FormatHelper,
} = ChromeUtils.importESModule(
  "resource://testing-common/mail/ComposeHelpers.sys.mjs"
);
var { open_message_from_file } = ChromeUtils.importESModule(
  "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
);

// Typed text comes out in the compose font, whatever that is set to.
const font =
  Services.prefs.getStringPref("msgcompose.font_face", "") || undefined;

add_setup(function () {
  // Set by anything but the shipped default, the tests below would pass
  // without saying anything about it.
  Assert.ok(
    !Services.prefs.prefHasUserValue("mail.compose.default_to_paragraph"),
    "paragraph mode should be at its default"
  );
  Assert.ok(
    !Services.prefs.getBoolPref("mail.compose.default_to_paragraph"),
    "paragraph mode should be off by default"
  );
});

/**
 * Wait for the toolbar selector to show a paragraph state.
 *
 * @param {FormatHelper} formatHelper
 * @param {string} state - "" for Body Text.
 * @param {string} message
 */
async function assertSelectorShows(formatHelper, state, message) {
  await TestUtils.waitForCondition(
    () => formatHelper.paragraphStateSelector.value === state,
    `${message}: the selector should show "${state}"`
  );
}

add_task(async function test_new_message_stays_in_body_text() {
  const win = await open_compose_new_mail();
  const formatHelper = new FormatHelper(win);
  formatHelper.focusMessage();

  await assertSelectorShows(formatHelper, "", "New message");

  await formatHelper.typeInMessage("first line");
  await formatHelper.typeEnterInMessage();
  await formatHelper.typeInMessage("second line");
  formatHelper.assertMessageBodyContent(
    [{ text: "first line<BR>second line", font }],
    "Enter in Body Text should break the line"
  );
  await assertSelectorShows(formatHelper, "", "After Enter in Body Text");

  await formatHelper.selectParagraphState("p");
  await formatHelper.typeEnterInMessage();
  await formatHelper.typeInMessage("third line");
  formatHelper.assertMessageBodyContent(
    [
      { text: "first line", font },
      { block: "P", content: [{ text: "second line", font }] },
      { block: "P", content: [{ text: "third line", font }] },
    ],
    "Enter after choosing Paragraph should start a new paragraph"
  );
  await assertSelectorShows(formatHelper, "p", "After Enter in Paragraph");

  await close_compose_window(win);
});

add_task(async function test_reply_stays_in_body_text() {
  const file = new FileUtils.File(getTestFilePath("data/sampleContent.eml"));
  const msgWin = await open_message_from_file(file);
  const win = await open_compose_with_reply(msgWin);
  const formatHelper = new FormatHelper(win);

  // Type where the reply put the caret. focusMessage() would click the middle
  // of the editor, which in a reply is inside the quote.
  formatHelper.messageEditor.focus();
  await assertSelectorShows(formatHelper, "", "New reply");

  await formatHelper.typeInMessage("first line");
  await formatHelper.typeEnterInMessage();
  await formatHelper.typeInMessage("second line");
  await assertSelectorShows(formatHelper, "", "After Enter in a reply");

  const body = formatHelper.messageEditor.contentDocument.body;
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const lines = {};
  while (walker.nextNode()) {
    if (["first line", "second line"].includes(walker.currentNode.data)) {
      lines[walker.currentNode.data] = walker.currentNode;
    }
  }
  for (const text of ["first line", "second line"]) {
    Assert.ok(lines[text], `"${text}" should be in the reply`);
    Assert.equal(
      lines[text].parentElement.closest("p"),
      null,
      `"${text}" should not have been made a paragraph`
    );
  }
  Assert.equal(
    lines["first line"].nextSibling?.nodeName,
    "BR",
    "the two lines should be separated by a line break"
  );

  await close_compose_window(win);
  await BrowserTestUtils.closeWindow(msgWin);
});
