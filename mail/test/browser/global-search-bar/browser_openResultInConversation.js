/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Test that double clicking a search result opens it in its conversation, with
 * the result selected and shown, rather than the message on its own.
 */

"use strict";

const { be_in_folder, create_folder } = ChromeUtils.importESModule(
  "resource://testing-common/mail/FolderDisplayHelpers.sys.mjs"
);
const { inboxFolder, make_message_sets_in_folders } =
  ChromeUtils.importESModule(
    "resource://testing-common/mail/MessageInjectionHelpers.sys.mjs"
  );
const { Gloda } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaPublic.sys.mjs"
);
const { GlodaMsgIndexer } = ChromeUtils.importESModule(
  "resource:///modules/gloda/IndexMsg.sys.mjs"
);

requestLongerTimeout(2);

const tabmail = document.getElementById("tabmail");
let folder;
let thread;

add_setup(async function () {
  folder = await create_folder("ConversationSearch");
  await be_in_folder(folder);

  // Three messages in one thread, and only the middle one holds the word
  // searched for. Anything more than one message in the tab that opens came
  // from the conversation, not from the search.
  const [root] = await make_message_sets_in_folders([folder], [{ count: 1 }]);
  const [middle] = await make_message_sets_in_folders(
    [folder],
    [
      {
        count: 1,
        inReplyTo: root,
        body: { body: "The quillfeather estimate is attached.\r\n" },
      },
    ]
  );
  const [last] = await make_message_sets_in_folders(
    [folder],
    [{ count: 1, inReplyTo: middle }]
  );
  thread = [root, middle, last].map(set => set.msgHdrList[0]);

  GlodaMsgIndexer.indexFolder(folder, { force: true });
  await TestUtils.waitForCondition(
    () => thread.every(hdr => Gloda.isMessageIndexed(hdr)),
    "the thread should be indexed",
    100,
    300
  );

  registerCleanupFunction(async () => {
    while (tabmail.tabInfo.length > 1) {
      tabmail.closeTab(1);
    }
    await be_in_folder(inboxFolder);
    folder.deleteSelf(null);
  });
});

add_task(async function test_double_click_opens_the_conversation() {
  const searchBar = document.querySelector(
    "#unifiedToolbarContent .search-bar"
  );
  EventUtils.synthesizeMouseAtCenter(searchBar, {}, window);
  EventUtils.sendString("quillfeather", window);
  EventUtils.synthesizeKey("KEY_Enter", {}, window);

  await TestUtils.waitForCondition(
    () =>
      tabmail.selectedTab.browser?.src ==
      "chrome://messenger/content/glodaFacetView.xhtml",
    "the search results tab should open"
  );
  const facetWindow = tabmail.selectedTab.browser.contentWindow;
  await TestUtils.waitForCondition(
    () =>
      facetWindow.FacetContext?.rootWin &&
      facetWindow.document.querySelector("facet-result-message"),
    "the search should list its results",
    100,
    300
  );

  const results = facetWindow.document.querySelectorAll(
    "facet-result-message"
  );
  Assert.equal(results.length, 1, "only the middle message should match");
  Assert.equal(
    results[0].message.headerMessageID,
    thread[1].messageId,
    "the result should be the middle message"
  );

  const tabCount = tabmail.tabInfo.length;
  const date = results[0].querySelector(".message-date");
  EventUtils.synthesizeMouseAtCenter(date, { clickCount: 1 }, facetWindow);
  EventUtils.synthesizeMouseAtCenter(date, { clickCount: 2 }, facetWindow);

  await TestUtils.waitForCondition(
    () => tabmail.tabInfo.length == tabCount + 1,
    "a tab should open for the conversation"
  );
  const tab = tabmail.currentTabInfo;
  Assert.equal(tab.mode.name, "mail3PaneTab", "it should be a mail tab");
  const about3Pane = tab.chromeBrowser.contentWindow;

  await TestUtils.waitForCondition(
    () => about3Pane.gDBView?.numMsgsInView == thread.length,
    "the whole thread should be listed, not just the result"
  );
  await TestUtils.waitForCondition(
    () =>
      about3Pane.gDBView.hdrForFirstSelectedMessage?.messageId ==
      thread[1].messageId,
    "the result should be selected in its thread"
  );
  await TestUtils.waitForCondition(
    () =>
      about3Pane.messageBrowser.contentWindow.gMessage?.messageId ==
      thread[1].messageId,
    "the result should be shown in the message pane"
  );

  Assert.ok(
    !Services.wm.getMostRecentWindow("mail:messageWindow"),
    "no message window should open"
  );
});
