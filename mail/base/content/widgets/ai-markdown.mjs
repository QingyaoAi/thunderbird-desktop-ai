/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Just enough Markdown for what a chat model writes back.
 *
 * Models answer in Markdown whether or not they are asked to, so showing the
 * raw text means reading asterisks and backticks. This renders the subset
 * that actually turns up -- headings, emphasis, code, lists, quotes, links,
 * tables are not included -- and leaves anything it does not recognise as
 * plain text rather than guessing.
 *
 * Everything is built as DOM nodes. No string of HTML is ever assembled, so
 * message content -- which is attacker-controlled, and reaches this by way
 * of the model -- cannot introduce markup, and link targets are restricted
 * to schemes that cannot run script.
 */

/** URL schemes a link may point at. */
const SAFE_SCHEMES = ["http:", "https:", "mailto:"];

/** Bare URLs, linkified as a convenience. */
const AUTOLINK_RE = /https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]/g;

/**
 * Whether a link target is safe to use as an href.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isSafeUrl(url) {
  try {
    return SAFE_SCHEMES.includes(new URL(url).protocol);
  } catch {
    // Relative or malformed: nothing sensible to navigate to from here.
    return false;
  }
}

/**
 * How deeply a line is indented, in spaces, with tabs counted as two.
 *
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  const leading = line.match(/^[ \t]*/)[0];
  return leading.replace(/\t/g, "  ").length;
}

/**
 * Inline markup -- code, emphasis, links -- appended to a parent node.
 *
 * Code spans are taken first and not looked into again, so asterisks inside
 * `*` stay literal, which is the whole point of writing them in code.
 *
 * @param {Node} parent
 * @param {string} text
 * @param {Document} doc
 */
function renderInline(parent, text, doc) {
  // Ordered by precedence. Each pattern captures the content to recurse on,
  // except code, which is taken literally.
  const patterns = [
    { re: /`([^`]+)`/, tag: "code", literal: true },
    { re: /\*\*([^*]+)\*\*/, tag: "strong" },
    { re: /__([^_]+)__/, tag: "strong" },
    { re: /~~([^~]+)~~/, tag: "s" },
    // Single-character emphasis, but not the middle of a word like
    // snake_case, and not an unmatched asterisk in prose.
    { re: /(?<![\w*])\*([^*\n]+)\*(?![\w*])/, tag: "em" },
    { re: /(?<![\w_])_([^_\n]+)_(?![\w_])/, tag: "em" },
  ];

  let earliest = null;
  for (const pattern of patterns) {
    const match = pattern.re.exec(text);
    if (match && (!earliest || match.index < earliest.match.index)) {
      earliest = { match, pattern };
    }
  }

  // A link competes with the patterns above for position.
  const linkMatch = /\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(text);
  if (linkMatch && (!earliest || linkMatch.index < earliest.match.index)) {
    renderInline(parent, text.slice(0, linkMatch.index), doc);
    const [whole, label, url] = linkMatch;
    if (isSafeUrl(url)) {
      const anchor = doc.createElement("a");
      anchor.href = url;
      anchor.textContent = label || url;
      parent.appendChild(anchor);
    } else {
      parent.appendChild(doc.createTextNode(whole));
    }
    renderInline(parent, text.slice(linkMatch.index + whole.length), doc);
    return;
  }

  if (!earliest) {
    appendTextWithAutolinks(parent, text, doc);
    return;
  }

  const { match, pattern } = earliest;
  renderInline(parent, text.slice(0, match.index), doc);
  const element = doc.createElement(pattern.tag);
  if (pattern.literal) {
    element.textContent = match[1];
  } else {
    renderInline(element, match[1], doc);
  }
  parent.appendChild(element);
  renderInline(parent, text.slice(match.index + match[0].length), doc);
}

/**
 * Plain text, with bare URLs turned into links.
 *
 * @param {Node} parent
 * @param {string} text
 * @param {Document} doc
 */
function appendTextWithAutolinks(parent, text, doc) {
  if (!text) {
    return;
  }
  let last = 0;
  for (const match of text.matchAll(AUTOLINK_RE)) {
    if (match.index > last) {
      parent.appendChild(doc.createTextNode(text.slice(last, match.index)));
    }
    if (isSafeUrl(match[0])) {
      const anchor = doc.createElement("a");
      anchor.href = match[0];
      anchor.textContent = match[0];
      parent.appendChild(anchor);
    } else {
      parent.appendChild(doc.createTextNode(match[0]));
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parent.appendChild(doc.createTextNode(text.slice(last)));
  }
}

/**
 * Render Markdown into a fragment of DOM nodes.
 *
 * @param {string} text - Markdown source.
 * @param {Document} doc - Document to create nodes in.
 * @returns {DocumentFragment}
 */
export function renderMarkdown(text, doc) {
  const fragment = doc.createDocumentFragment();
  renderBlocks(fragment, (text ?? "").split(/\r?\n/), doc);
  return fragment;
}

/**
 * @param {Node} parent
 * @param {string[]} lines
 * @param {Document} doc
 */
function renderBlocks(parent, lines, doc) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code. An unterminated fence runs to the end, which is what a
    // half-streamed answer looks like.
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      if (fence[1]) {
        code.dataset.language = fence[1];
      }
      code.textContent = body.join("\n");
      pre.appendChild(code);
      parent.appendChild(pre);
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      // Offset so a model's top-level "#" does not outrank the panel's own
      // headings in the document outline.
      const level = Math.min(6, heading[1].length + 2);
      const element = doc.createElement(`h${level}`);
      renderInline(element, heading[2].trim(), doc);
      parent.appendChild(element);
      i++;
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      parent.appendChild(doc.createElement("hr"));
      i++;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || lines[i].trim())) {
        if (!/^\s{0,3}>/.test(lines[i]) && !quoted.length) {
          break;
        }
        quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i++;
      }
      const quote = doc.createElement("blockquote");
      renderBlocks(quote, quoted, doc);
      parent.appendChild(quote);
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
    if (bullet) {
      i = renderList(parent, lines, i, doc);
      continue;
    }

    // Paragraph: everything up to a blank line or the start of another block.
    const paragraph = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s{0,3}#{1,6}\s/.test(lines[i]) &&
      !/^\s{0,3}>/.test(lines[i]) &&
      !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])
    ) {
      paragraph.push(lines[i].trim());
      i++;
    }
    const element = doc.createElement("p");
    // A single newline inside a paragraph is a line break here: models use
    // it to mean one, and nothing in this context wants reflowed prose.
    paragraph.forEach((part, index) => {
      if (index) {
        element.appendChild(doc.createElement("br"));
      }
      renderInline(element, part, doc);
    });
    parent.appendChild(element);
  }
}

/**
 * Render one list, including any nested beneath its items.
 *
 * @param {Node} parent
 * @param {string[]} lines
 * @param {number} start - Index of the first item.
 * @param {Document} doc
 * @returns {number} Index of the first line after the list.
 */
function renderList(parent, lines, start, doc) {
  const first = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[start]);
  const baseIndent = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const list = doc.createElement(ordered ? "ol" : "ul");

  let i = start;
  let item = null;
  let itemLines = [];

  const flush = () => {
    if (!item) {
      return;
    }
    // The first line is the item's own text; anything after it is nested
    // content and gets the full block treatment.
    renderInline(item, itemLines[0] ?? "", doc);
    if (itemLines.length > 1) {
      renderBlocks(item, itemLines.slice(1), doc);
    }
    list.appendChild(item);
    item = null;
    itemLines = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it.
      const next = lines[i + 1];
      if (!next || indentOf(next) < baseIndent || !next.trim()) {
        break;
      }
      i++;
      continue;
    }

    const match = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
    const indent = indentOf(line);

    if (match && indent <= baseIndent) {
      // A numbered list may follow a bulleted one with no blank line
      // between them. They are two lists, and merging them would renumber
      // one of them out of existence.
      if (/\d/.test(match[2]) !== ordered) {
        break;
      }
      flush();
      item = doc.createElement("li");
      itemLines = [line.slice(match[0].length)];
      i++;
      continue;
    }

    if (!item) {
      break;
    }

    if (indent > baseIndent) {
      // Nested list or continuation; dedent so the recursive pass sees it
      // as a block in its own right.
      itemLines.push(line.slice(Math.min(indent, baseIndent + 2)));
      i++;
      continue;
    }

    break;
  }

  flush();
  parent.appendChild(list);
  return i;
}

/**
 * Turn "[1]" style citations in rendered output into links.
 *
 * Runs over the DOM after rendering rather than over the source, so a
 * bracket inside a code span or an existing link is left alone.
 *
 * @param {Node} root - Rendered output to scan.
 * @param {Document} doc
 * @param {function(number): boolean} isKnown - Whether a citation number has
 *   a source behind it. Unknown numbers are left as text.
 * @param {function(number, MouseEvent)} onActivate - Called with the number.
 */
export function linkifyCitations(root, doc, isKnown, onActivate) {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Not inside code, and not inside a link that already goes somewhere.
      if (node.parentElement?.closest("code, pre, a")) {
        return NodeFilter.FILTER_REJECT;
      }
      return /\[\d+\]/.test(node.nodeValue)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets = [];
  while (walker.nextNode()) {
    targets.push(walker.currentNode);
  }

  for (const node of targets) {
    const parts = doc.createDocumentFragment();
    const text = node.nodeValue;
    let last = 0;
    for (const match of text.matchAll(/\[(\d+)\]/g)) {
      const number = Number(match[1]);
      if (!isKnown(number)) {
        continue;
      }
      if (match.index > last) {
        parts.appendChild(doc.createTextNode(text.slice(last, match.index)));
      }
      const link = doc.createElement("a");
      link.className = "ai-citation";
      link.href = "#";
      link.textContent = match[0];
      link.addEventListener("click", event => {
        event.preventDefault();
        onActivate(number, event);
      });
      parts.appendChild(link);
      last = match.index + match[0].length;
    }
    if (!parts.childNodes.length) {
      continue;
    }
    if (last < text.length) {
      parts.appendChild(doc.createTextNode(text.slice(last)));
    }
    node.replaceWith(parts);
  }
}
