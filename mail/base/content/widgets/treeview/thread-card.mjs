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
  MailServices: "resource:///modules/MailServices.sys.mjs",
  MsgHdrToMimeMessage: "resource:///modules/gloda/MimeMessage.sys.mjs",
  mimeMsgToContentSnippetAndMeta:
    "resource:///modules/gloda/GlodaContent.sys.mjs",
});
ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["messenger/messenger.ftl"], true)
);

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

// Which children of a collapsed thread its card is drawn from (see
// cardChildrenFor), keyed by "<thread key>#<child count>". Finding them means
// reading every child's date, and that happens before the preview cache can
// be consulted -- so without this, scrolling past a long conversation
// re-walked the whole thread every time one of its rows was recycled. The
// child count is part of the key so the answer is dropped as soon as the
// thread gains or loses a message. Only indices are kept, never headers, so
// this retains nothing.
const cardChildrenCache = new Map();
const CARD_CHILDREN_CACHE_MAX = 500;

function cacheCardChildren(key, children) {
  if (cardChildrenCache.size >= CARD_CHILDREN_CACHE_MAX) {
    cardChildrenCache.delete(cardChildrenCache.keys().next().value);
  }
  cardChildrenCache.set(key, children);
}

// How many of a collapsed thread's latest writers its sender line names. The
// line ends in an ellipsis when it runs out of room, so on a narrow card it
// is the earlier writer that goes.
const SENDERS_SHOWN = 2;

/**
 * The address a header's first author writes from, to tell writers apart.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {string}
 */
function authorAddress(hdr) {
  const author = hdr.mime2DecodedAuthor || "";
  const [first] = lazy.MailServices.headerParser.parseDecodedHeader(author);
  return (first?.email || author).toLowerCase();
}

/**
 * The children of a collapsed thread its card is drawn from, as indices into
 * the thread: `newest`, whose date, subject and preview stand for the whole
 * conversation, and `senders` -- the newest message from each of the last
 * SENDERS_SHOWN people to write, newest first.
 *
 * @param {nsIMsgThread} thread
 * @returns {{newest: number, senders: number[]}}
 */
function cardChildrenFor(thread) {
  const memoKey = `${thread.threadKey}#${thread.numChildren}`;
  const memo = cardChildrenCache.get(memoKey);
  if (memo) {
    return memo;
  }

  const children = [];
  for (let i = 0; i < thread.numChildren; i++) {
    const hdr = thread.getChildHdrAt(i);
    if (hdr) {
      children.push({ index: i, hdr });
    }
  }
  // Newest first. The sort is stable, so of two dated the same the first
  // child is still the one taken as newest.
  children.sort((a, b) => b.hdr.date - a.hdr.date);

  const senders = [];
  const seen = new Set();
  for (const { index, hdr } of children) {
    const address = authorAddress(hdr);
    if (!seen.has(address)) {
      seen.add(address);
      senders.push(index);
      if (senders.length == SENDERS_SHOWN) {
        break;
      }
    }
  }

  const result = { newest: children[0]?.index ?? -1, senders };
  if (children.length) {
    cacheCardChildren(memoKey, result);
  }
  return result;
}

/**
 * Which header represents the row at `index`: the row's own message
 * normally, but for a *collapsed* thread row -- which stands in for the
 * whole conversation -- the newest message in the thread. This drives both
 * the subject and the body preview, matching the date shown for such rows
 * (see nsMsgDBView's CellTextForColumn: showing the root's old
 * date/subject/body while implying "this is the conversation's current
 * state" would be inconsistent).
 */
function representativeHeaderFor(view, index, isCollapsedThread) {
  const ownHdr = view.getMsgHdrAt(index);
  if (!isCollapsedThread) {
    return ownHdr;
  }
  const thread = view.getThreadContainingIndex(index);
  if (!thread) {
    return ownHdr;
  }
  const { newest } = cardChildrenFor(thread);
  return (newest >= 0 && thread.getChildHdrAt(newest)) || ownHdr;
}

// The sender line's text for an author header, keyed by
// "<mail.displayname.version>|<author>". Formatting looks the address up in
// every address book, too slow to repeat for each row recycled as the list
// scrolls. The version goes up whenever the display prefs change, so a stale
// key is simply never asked for again; a contact edited meanwhile is as
// stale here as in nsMsgDBView's own "sender_name" cache.
const senderTextCache = new Map();
const SENDER_TEXT_CACHE_MAX = 500;

/**
 * The sender as the thread pane displays it, mirroring nsMsgDBView's
 * FetchAuthor(): the address book's name for a known address, otherwise the
 * header's name and address in the form mail.addressDisplayFormat asks for.
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {string}
 */
function senderForHeader(hdr) {
  const author = hdr.mime2DecodedAuthor || "";
  const version = Services.prefs.getIntPref("mail.displayname.version", 0);
  const cacheKey = `${version}|${author}`;
  const cached = senderTextCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const addresses = lazy.MailServices.headerParser.parseDecodedHeader(author);
  if (!addresses.length) {
    return author;
  }
  const { name: headerName, email } = addresses[0];
  let sender = "";
  if (Services.prefs.getBoolPref("mail.showCondensedAddresses", true)) {
    sender = lazy.MailServices.ab.cardForEmailAddress(email)?.displayName ?? "";
  }
  if (!sender) {
    const full =
      headerName && email ? `${headerName} <${email}>` : headerName || email;
    // A name that looks like an address may not be the one it is sent from,
    // so it is not shown alone (NoSpoofingSender).
    const shortName = /@.*\./.test(headerName) ? full : headerName;
    const format = Services.prefs.getIntPref("mail.addressDisplayFormat", 0);
    if (format == 0) {
      sender = full;
    } else if (format == 1 && email) {
      sender = email;
    } else {
      sender = shortName || email;
    }
  }
  if (addresses.length > 1) {
    sender += " " + lazy.l10n.formatValueSync("and-others");
  }

  if (senderTextCache.size >= SENDER_TEXT_CACHE_MAX) {
    senderTextCache.delete(senderTextCache.keys().next().value);
  }
  senderTextCache.set(cacheKey, sender);
  return sender;
}

/**
 * The sender line of a collapsed thread's card: the last people to write,
 * newest first, rather than whoever started the conversation.
 *
 * @param {nsIMsgDBView} view
 * @param {integer} index
 * @returns {?string} null when the row's own sender should stay.
 */
function latestSendersFor(view, index) {
  const thread = view.getThreadContainingIndex(index);
  if (!thread) {
    return null;
  }
  const names = cardChildrenFor(thread)
    .senders.map(i => thread.getChildHdrAt(i))
    .filter(Boolean)
    .map(senderForHeader)
    .filter(Boolean);
  return names.length ? names.join(", ") : null;
}

/**
 * The subject as the thread pane displays it, mirroring nsMsgDBView's
 * FetchSubject(): the decoded subject, with "Re: " put back from the HasRe
 * flag (the prefix is stripped before storage, see NS_MsgStripRE).
 *
 * @param {nsIMsgDBHdr} hdr
 * @returns {string}
 */
function subjectForHeader(hdr) {
  const subject = hdr.mime2DecodedSubject || "";
  return hdr.flags & Ci.nsMsgMessageFlags.HasRe ? "Re: " + subject : subject;
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

    this.dateLine.textContent = data.date;

    const isCollapsedThread =
      this.classList.contains("children") &&
      this.classList.contains("collapsed");

    // A collapsed thread row stands in for the conversation, so name the last
    // people to write in it, newest first, not whoever started it. In an
    // outgoing folder the line shows recipients instead; those stay the
    // root's.
    let displaySender = data.sender;
    if (
      isCollapsedThread &&
      window.threadPane.cardColumns.includes("senderCol")
    ) {
      try {
        displaySender =
          latestSendersFor(this.view, this._index) ?? displaySender;
      } catch (ex) {
        console.error("thread-card sender failed:", ex);
      }
    }
    this.senderLine.textContent = displaySender;
    this.senderLine.title = displaySender;

    const representativeHdr = representativeHeaderFor(
      this.view,
      this._index,
      isCollapsedThread
    );

    // A collapsed thread row stands in for the conversation, so label it with
    // the newest message's subject rather than the root's. Senders who
    // compose each new notice by replying to last year's and editing the
    // subject would otherwise leave the row showing the stale original.
    // data.subject (the root's, already rendered above) stays as the fallback
    // -- this is presentation polish, so it must not break the row.
    let displaySubject = data.subject;
    if (isCollapsedThread && representativeHdr) {
      try {
        const newestSubject = subjectForHeader(representativeHdr);
        if (newestSubject) {
          displaySubject = newestSubject;
          this.subjectLine.textContent = newestSubject;
          this.subjectLine.title = newestSubject;
        }
      } catch (ex) {
        console.error("thread-card subject failed:", ex);
      }
    }

    this.#fillPreview(representativeHdr);

    this.threadCardTags.setAttribute("tags", data.tagKeys);

    // Follow the layout order.
    ariaLabelPromises.push(displaySender);
    ariaLabelPromises.push(data.date);
    ariaLabelPromises.push(displaySubject);
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
   * @param {?nsIMsgDBHdr} msgHdr - The header whose body to preview, from
   *   representativeHeaderFor().
   */
  #fillPreview(msgHdr) {
    if (!this.previewLine) {
      return;
    }

    // The preview is a nice-to-have, not core row functionality (unlike the
    // sender/subject/date cells above, which come from cellDataForColumns
    // and are expected to always succeed). Wrap the whole thing so that any
    // failure here -- an edge-case view state representativeHeaderFor() doesn't
    // handle, a folder access error, whatever -- degrades to "no preview
    // for this row" instead of throwing out of fillRow() and potentially
    // breaking the rest of the row (or the list's rendering loop).
    try {
      this.#fillPreviewUnchecked(msgHdr);
    } catch (ex) {
      console.error("thread-card preview failed:", ex);
      this.previewLine.textContent = "";
    }
  }

  #fillPreviewUnchecked(msgHdr) {
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
