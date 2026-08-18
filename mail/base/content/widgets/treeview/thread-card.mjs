/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

import { TreeViewTableRow } from "chrome://messenger/content/tree-view.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://messenger/content/thread-card-tags.mjs";

// These are system modules (.sys.mjs), which live in the shared system
// global and cannot be pulled in with a static `import` from a module
// loaded into a document global -- doing so throws and takes this whole
// module down with it (which in turn means thread-card never gets
// registered as a custom element). Load them the way the sibling widget
// modules do, lazily, so gloda also isn't loaded until a preview is
// actually rendered.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Gloda: "resource:///modules/gloda/GlodaPublic.sys.mjs",
  MsgHdrToMimeMessage: "resource:///modules/gloda/MimeMessage.sys.mjs",
  mimeMsgToContentSnippetAndMeta:
    "resource:///modules/gloda/GlodaContent.sys.mjs",
});

// How many characters of body text to keep for the preview; the CSS clamps
// the display to PREVIEW_LINES lines regardless, so this only needs to be
// long enough to fill that many lines on a wide row.
const PREVIEW_SNIPPET_LENGTH = 420;

// Body-preview text keyed by "<folder URI>#<message key>", shared by every
// card row instance so scrolling back to an already-fetched row is instant
// instead of re-parsing the message. Capped (FIFO-ish eviction) so a long
// session skimming a huge mailbox doesn't grow this without bound.
const previewCache = new Map();
const PREVIEW_CACHE_MAX = 500;

function cachePreview(key, text) {
  if (previewCache.size >= PREVIEW_CACHE_MAX) {
    previewCache.delete(previewCache.keys().next().value);
  }
  previewCache.set(key, text);
}

// Which child of a collapsed thread is the newest, keyed by
// "<thread key>#<child count>". Finding it means reading every child's date,
// and that happens before the preview cache can be consulted -- so without
// this, scrolling past a long conversation re-walked the whole thread every
// time one of its rows was recycled. The child count is part of the key so
// the answer is dropped as soon as the thread gains or loses a message.
// Only the index is kept, never the header, so this retains nothing.
const newestChildCache = new Map();
const NEWEST_CHILD_CACHE_MAX = 500;

function cacheNewestChild(key, childIndex) {
  if (newestChildCache.size >= NEWEST_CHILD_CACHE_MAX) {
    newestChildCache.delete(newestChildCache.keys().next().value);
  }
  newestChildCache.set(key, childIndex);
}

/**
 * Which header's body should be previewed for the row at `index`: the
 * row's own message normally, but for a *collapsed* thread row -- which
 * stands in for the whole conversation -- the newest message in the
 * thread, matching the date shown for such rows (see nsMsgDBView's
 * CellTextForColumn: showing the root's old date/body while implying
 * "this is the conversation's current state" would be inconsistent).
 */
function previewHeaderFor(view, index, isCollapsedThread) {
  const ownHdr = view.getMsgHdrAt(index);
  if (!isCollapsedThread) {
    return ownHdr;
  }
  const thread = view.getThreadContainingIndex(index);
  if (!thread) {
    return ownHdr;
  }
  const numChildren = thread.numChildren;
  const memoKey = `${thread.threadKey}#${numChildren}`;
  const memo = newestChildCache.get(memoKey);
  if (memo !== undefined) {
    const hdr = thread.getChildHdrAt(memo);
    if (hdr) {
      return hdr;
    }
  }
  let newestHdr = null;
  let newestDate = -1;
  let newestIndex = -1;
  for (let i = 0; i < numChildren; i++) {
    const hdr = thread.getChildHdrAt(i);
    if (hdr && hdr.date > newestDate) {
      newestDate = hdr.date;
      newestHdr = hdr;
      newestIndex = i;
    }
  }
  if (newestIndex >= 0) {
    cacheNewestChild(memoKey, newestIndex);
  }
  return newestHdr || ownHdr;
}

/**
 * The tr element row of the TreeView table for the cards view layout.
 * NOTE: The main child is a clone of the `#threadPaneCardTemplate` template.
 *
 * @tagname thread-row
 * @augments {TreeViewTableRow}
 */
class ThreadCard extends TreeViewTableRow {
  // Overwritten dynamically by about3Pane.js's densityChange() before any
  // real rendering happens (based on UI font size / density / rowCount,
  // now including the body-preview row); this is just the pre-init value.
  static ROW_HEIGHT = 46;

  connectedCallback() {
    if (this.hasConnected) {
      return;
    }

    super.connectedCallback();

    this.setAttribute("draggable", "true");
    this.classList.add("card-layout");

    this.appendChild(
      document.getElementById("threadPaneCardTemplate").content.cloneNode(true)
    );

    this.cardCell = this.querySelector("td");
    this.accountIndicator = this.querySelector(".account-indicator");
    this.senderLine = this.querySelector(".sender");
    this.subjectLine = this.querySelector(".subject");
    this.dateLine = this.querySelector(".date");
    this.starButton = this.querySelector(".button-star");
    this.threadCardTags = this.querySelector("thread-card-tags");
    this.replies = this.querySelector(".thread-replies");
    this.twistyButton = this.querySelector("button.twisty");
    this.sortHeaderDetails = this.querySelector(".sort-header-details");
    this.statusIndicator = this.querySelector(".read-status");
    this.previewLine = this.querySelector(".preview");
  }

  fillRow() {
    super.fillRow();

    if (this.getAttribute("role") == "row") {
      this.cardCell.setAttribute("role", "gridcell");
    }

    // XPCOM calls here must be keep to a minimum. Collect all of the
    // required data in one go.
    const properties = {};
    const threadLevel = {};

    const cellTexts = this.view.cellDataForColumns(
      this._index,
      window.threadPane.cardColumns,
      properties,
      threadLevel
    );

    // Collect the various strings and fluent IDs to build the full string for
    // the message row aria-label.
    const ariaLabelPromises = [];
    // Use static mapping instead of threadPane.cardColumns since the name of
    // the sender column changes. (see getProperSenderForCardsView)
    const KEYS = [
      "subject",
      "sender",
      "date",
      "tagKeys",
      "total",
      "unread",
      "account",
      "serverKey",
    ];
    const data = Object.fromEntries(KEYS.map((key, i) => [key, cellTexts[i]]));

    this.accountIndicator.style.setProperty(
      "--account-color",
      `var(--server-${CSS.escape(data.serverKey)}-color)`
    );
    this.accountIndicator.title = data.account;

    if (threadLevel.value) {
      properties.value += " thread-children";
    }
    const propertiesSet = new Set(properties.value.split(" "));
    this.dataset.properties = properties.value.trim();
    this.#updateTwistyButton();

    this.subjectLine.textContent = data.subject;
    this.subjectLine.title = data.subject;

    // Handle a different style and data if this is a dummy row.
    if (propertiesSet.has("dummy")) {
      const unread = Number(data.unread);
      const total = Number(data.total);

      if (unread) {
        document.l10n.setAttributes(
          this.sortHeaderDetails,
          "threadpane-sort-header-unread-count",
          {
            unread,
            total,
          }
        );
        return;
      }

      document.l10n.setAttributes(
        this.sortHeaderDetails,
        "threadpane-sort-header-count",
        {
          total,
        }
      );
      return;
    }

    this.senderLine.textContent = data.sender;
    this.senderLine.title = data.sender;
    this.dateLine.textContent = data.date;

    this.#fillPreview(
      this.classList.contains("children") && this.classList.contains("collapsed")
    );

    this.threadCardTags.setAttribute("tags", data.tagKeys);

    // Follow the layout order.
    ariaLabelPromises.push(data.sender);
    ariaLabelPromises.push(data.date);
    ariaLabelPromises.push(data.subject);
    ariaLabelPromises.push(data.tags);

    if (propertiesSet.has("flagged")) {
      document.l10n.setAttributes(
        this.starButton,
        "tree-list-view-row-flagged"
      );
      ariaLabelPromises.push(
        document.l10n.formatValue("threadpane-flagged-cell-label")
      );
    } else {
      document.l10n.setAttributes(this.starButton, "tree-list-view-row-flag");
    }

    if (propertiesSet.has("junk")) {
      ariaLabelPromises.push(
        document.l10n.formatValue("threadpane-spam-cell-label")
      );
    }

    if (propertiesSet.has("new")) {
      document.l10n.setAttributes(
        this.statusIndicator,
        "tree-list-view-row-new-status"
      );
      ariaLabelPromises.push(
        document.l10n.formatValue("threadpane-new-cell-label")
      );
    } else if (propertiesSet.has("read")) {
      ariaLabelPromises.push(
        document.l10n.formatValue("threadpane-read-cell-label")
      );
    } else if (propertiesSet.has("unread")) {
      document.l10n.setAttributes(
        this.statusIndicator,
        "tree-list-view-row-not-read-status"
      );
      ariaLabelPromises.push(
        document.l10n.formatValue("threadpane-unread-cell-label")
      );
    }

    if (propertiesSet.has("attach")) {
      ariaLabelPromises.push(
        document.l10n.formatValue("threadpane-attachments-cell-label")
      );
    }

    // Display number of replies in the twisty button.
    const repliesCount = parseInt(data.total) - 1;
    if (repliesCount > 0) {
      document.l10n.setAttributes(this.replies, "threadpane-replies", {
        count: repliesCount,
      });
    }
    // Set either way, not just when there are replies: rows are recycled as
    // the list scrolls, so anything left set from the previous message would
    // be wrong for this one.
    this.classList.toggle("no-replies", repliesCount <= 0);

    Promise.allSettled(ariaLabelPromises).then(results => {
      this.setAttribute(
        "aria-label",
        results
          .map(settledPromise => settledPromise.value ?? "")
          .filter(value => value.trim() != "")
          .join(", ")
      );
    });
  }

  /**
   * Populate the body-preview line, fetching/parsing the message
   * asynchronously (with caching) if it isn't already in previewCache.
   *
   * @param {boolean} isCollapsedThread - Whether this row is a collapsed
   *   thread standing in for the whole conversation (see previewHeaderFor).
   */
  #fillPreview(isCollapsedThread) {
    if (!this.previewLine) {
      return;
    }

    // The preview is a nice-to-have, not core row functionality (unlike the
    // sender/subject/date cells above, which come from cellDataForColumns
    // and are expected to always succeed). Wrap the whole thing so that any
    // failure here -- an edge-case view state previewHeaderFor() doesn't
    // handle, a folder access error, whatever -- degrades to "no preview
    // for this row" instead of throwing out of fillRow() and potentially
    // breaking the rest of the row (or the list's rendering loop).
    try {
      this.#fillPreviewUnchecked(isCollapsedThread);
    } catch (ex) {
      console.error("thread-card preview failed:", ex);
      this.previewLine.textContent = "";
    }
  }

  #fillPreviewUnchecked(isCollapsedThread) {
    const msgHdr = previewHeaderFor(this.view, this._index, isCollapsedThread);
    if (!msgHdr) {
      this.previewLine.textContent = "";
      return;
    }

    const cacheKey = `${msgHdr.folder.URI}#${msgHdr.messageKey}`;
    const cached = previewCache.get(cacheKey);
    if (cached !== undefined) {
      this.previewLine.textContent = cached;
      return;
    }

    // Preferred source: the snippet Thunderbird already stored on the
    // header (same one the folder summary and new-mail notifications use).
    // It costs nothing to read, needs no MIME parsing, and is available
    // without waiting -- important here, because this runs for every row
    // the user scrolls past.
    const storedPreview = msgHdr.getStringProperty("preview");
    if (storedPreview) {
      const text =
        storedPreview.length > PREVIEW_SNIPPET_LENGTH
          ? storedPreview.substring(0, PREVIEW_SNIPPET_LENGTH - 1) + "…"
          : storedPreview;
      cachePreview(cacheKey, text);
      this.previewLine.textContent = text;
      return;
    }

    this.previewLine.textContent = "";
    // Invalidated by the next #fillPreview call on this row instance (row
    // elements get recycled for different messages as the list scrolls),
    // so a slow fetch from a since-scrolled-past row can't clobber
    // whatever this row now shows.
    const requestToken = (this._previewRequestToken =
      (this._previewRequestToken || 0) + 1);

    try {
      // mimeMsgToContentSnippetAndMeta() extracts the body text using the
      // "whittlers" registered when Gloda's attribute providers are set
      // up (GlodaFundAttr is the one that actually pulls out body text).
      // With an empty whittler registry it quietly returns an empty
      // string rather than failing -- which is exactly how this preview
      // ended up blank. GlodaPublic is the entry point that pulls in
      // Everybody.sys.mjs and hence those providers; importing plain
      // Gloda.sys.mjs is NOT enough (verified: still empty).
      void lazy.Gloda;

      lazy.MsgHdrToMimeMessage(
        msgHdr,
        null,
        (messageHeader, mimeMessage) => {
          if (
            requestToken !== this._previewRequestToken ||
            mimeMessage == null
          ) {
            return;
          }
          const [rawText] = lazy.mimeMsgToContentSnippetAndMeta(
            mimeMessage,
            messageHeader.folder,
            PREVIEW_SNIPPET_LENGTH
          );
          // The snippet keeps the body's line breaks; collapse them so the
          // single display line doesn't gain stray gaps where they were.
          const text = rawText.replace(/\s+/g, " ").trim();
          cachePreview(cacheKey, text);
          this.previewLine.textContent = text;
        },
        false,
        { saneBodySize: true }
      );
    } catch {
      // Offline messages can throw synchronously (see the same pattern in
      // multimessageview.js); leave the preview blank rather than
      // breaking the row.
    }
  }

  #updateTwistyButton() {
    if (!this.classList.contains("children")) {
      this.twistyButton.removeAttribute("data-l10n-id");
      this.twistyButton.removeAttribute("aria-expanded");
      this.twistyButton.removeAttribute("aria-label");
      return;
    }

    const isCollapsed = this.classList.contains("collapsed");
    document.l10n.setAttributes(
      this.twistyButton,
      isCollapsed
        ? "tree-list-view-row-expand-thread-button"
        : "tree-list-view-row-collapse-thread-button"
    );
    this.twistyButton.ariaExpanded = String(!isCollapsed);
  }
}
customElements.define("thread-card", ThreadCard, {
  extends: "tr",
});
