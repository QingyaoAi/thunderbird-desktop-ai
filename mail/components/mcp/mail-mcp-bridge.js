#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Speaks MCP on stdio, and forwards to Thunderbird's local endpoint.
 *
 * The endpoint (MailMcpServer.sys.mjs) is plain JSON over HTTP on loopback,
 * which is easy to test with curl and easy to reason about. MCP clients want
 * JSON-RPC framed on stdin and stdout. This translates between the two, and
 * holds no state and no mail of its own.
 *
 * Usage:
 *
 *   MAIL_MCP_TOKEN=<token> node mail-mcp-bridge.js
 *
 * The port is read from mcp-endpoint.json in the Thunderbird profile, which
 * the endpoint rewrites each time it starts, since the OS picks a new port
 * every time. Set MAIL_MCP_URL to override.
 *
 * In a client's configuration:
 *
 *   {
 *     "mcpServers": {
 *       "thunderbird": {
 *         "command": "node",
 *         "args": ["/path/to/mail-mcp-bridge.js"],
 *         "env": { "MAIL_MCP_TOKEN": "..." }
 *       }
 *     }
 *   }
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const TOKEN = process.env.MAIL_MCP_TOKEN;
if (!TOKEN) {
  process.stderr.write(
    "MAIL_MCP_TOKEN is not set. Create a token in Thunderbird first.\n"
  );
  process.exit(1);
}

/**
 * Where the endpoint recorded its port. The port changes every time
 * Thunderbird starts, so this is read fresh rather than configured once.
 *
 * @returns {string}
 */
function endpointUrl() {
  if (process.env.MAIL_MCP_URL) {
    return process.env.MAIL_MCP_URL;
  }
  const roots = [
    path.join(os.homedir(), "Library", "Thunderbird", "Profiles"),
    path.join(os.homedir(), ".thunderbird"),
    path.join(os.homedir(), "AppData", "Roaming", "Thunderbird", "Profiles"),
  ];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch (ex) {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(root, entry, "mcp-endpoint.json");
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (data.url) {
          return data.url;
        }
      } catch (ex) {
        // Not this profile.
      }
    }
  }
  throw new Error(
    "Could not find mcp-endpoint.json. Is Thunderbird running with " +
      "mail.mcp.enabled set?"
  );
}

/**
 * One call to the endpoint.
 *
 * @param {string} method
 * @param {object} params
 * @returns {Promise<object>}
 */
function callEndpoint(method, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpointUrl());
    const body = JSON.stringify({ method, params });
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      response => {
        let text = "";
        response.on("data", chunk => (text += chunk));
        response.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(text || "{}");
          } catch (ex) {
            reject(new Error(`endpoint returned ${response.statusCode}`));
            return;
          }
          if (parsed.error) {
            reject(new Error(parsed.error));
          } else {
            resolve(parsed.result);
          }
        });
      }
    );
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

/**
 * What create_draft and update_draft both take for a draft's text and for
 * what is chosen in the compose window's Options menu.
 */
const DRAFT_PROPERTIES = {
  body: {
    type: "string",
    description:
      "The text, plain, with a blank line between paragraphs. No Markdown, " +
      "and not the user's signature, which is added. For text that needs " +
      "formatting, give html instead.",
  },
  html: {
    type: "string",
    description:
      "The text as HTML, instead of body, when it needs formatting: bold, " +
      "colour, lists, links, tables. Only what goes in the body, not a " +
      "whole page. A picture is set in the text with an <img> whose src is " +
      "a file's full path. Leave the user's signature out, unless it is in " +
      "HTML you read from the draft.",
  },
  priority: {
    type: "string",
    enum: ["highest", "high", "normal", "low", "lowest"],
  },
  returnReceipt: {
    type: "boolean",
    description: "Ask for a receipt when the message is read",
  },
  deliveryStatusNotification: {
    type: "boolean",
    description: "Ask the mail server to report the message's delivery",
  },
  deliveryFormat: {
    type: "string",
    enum: ["auto", "plain", "html", "both"],
    description:
      "What the message is sent as: auto (plain text unless it has " +
      "formatting), plain, html, or both",
  },
  attachmentReminder: {
    type: "boolean",
    description: "Remind the user to attach something before it is sent",
  },
  attachVCard: {
    type: "boolean",
    description: "Send the user's contact card with the message",
  },
};

/** The tools offered, and what they take. */
// The same eight are in MailMcpServer.sys.mjs's MCP_TOOLS, which serves them
// on /mcp along with the tagging tools; a change to one belongs in both.
const TOOLS = [
  {
    name: "search_mail",
    description:
      "Search the user's mailbox. `query` is full-text and ranked the way " +
      "Thunderbird's own search ranks it. The other fields narrow the " +
      "results, and may be used without a query as long as a folder is " +
      "given. Dates are ISO 8601. Search when the task is about the " +
      "user's mail, or when you have been asked to look there -- not for " +
      "background to work on files or documents, such as instructions, " +
      "comments or someone's details, that nobody said came by email.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Full-text search terms" },
        from: { type: "string", description: "Sender, name or address" },
        to: { type: "string", description: "Recipient, name or address" },
        subject: { type: "string" },
        folder: { type: "string", description: "Folder name or URI" },
        after: { type: "string", description: "Only messages after this date" },
        before: { type: "string", description: "Only messages before this date" },
        tag: { type: "string", description: "Tag key, e.g. $label1" },
        unread: { type: "boolean" },
        flagged: { type: "boolean" },
        hasAttachment: { type: "boolean" },
        headers: {
          type: "object",
          description:
            "Match keywords against any named header, e.g. " +
            '{"list-id": "ntcir"}. Headers the database already holds are ' +
            "free; others cost one message read each, so this is applied " +
            "after the other filters and is bounded.",
          additionalProperties: { type: "string" },
        },
        sort: {
          type: "string",
          enum: ["relevance", "date"],
          description:
            "Order of a text search. relevance (the default) is " +
            "Thunderbird's own ranking, newest first among equal matches; " +
            "date is newest first regardless. Use date for questions about " +
            "the latest or most recent mail. A folder read with no query is " +
            "always newest first.",
        },
        limit: { type: "number", description: "Default 25, maximum 200" },
      },
    },
  },
  {
    name: "get_message",
    description:
      "One message in full: headers, decoded body and the list of its " +
      "attachments. Takes an id from search_mail.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        includeBody: { type: "boolean" },
        html: {
          type: "boolean",
          description:
            "Also return the body as HTML -- for a draft whose formatted " +
            "text is to be changed with update_draft",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_attachment",
    description:
      "Save one attachment of a message to a private temporary file and " +
      "return its path, to read with a file tool -- PDFs and images " +
      "included. Takes the message id and the attachment's index from " +
      "get_message, or its name; with only one attachment, neither is " +
      "needed. Only files stored in the message are served, not detached " +
      "files or links. The file is deleted ten minutes after it was last " +
      "asked for (the result says when); ask again to keep it, or to get " +
      "it back once it has gone.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        index: {
          type: "number",
          description: "Position in get_message's attachments list",
        },
        name: { type: "string", description: "The attachment's file name" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_thread",
    description:
      "Every message in the same conversation as the given one, oldest " +
      "first.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        includeBodies: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_folders",
    description: "Every mail folder, with message and unread counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_identities",
    description: "The addresses the user can write as.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_draft",
    description:
      "Save a draft for the user to review and send by hand. Nothing is " +
      "sent. Pass inReplyTo with a message id to draft a reply, which fills " +
      "in the reply headers and subject. The draft is saved in the format " +
      "the user writes mail in, with their signature after the text and " +
      "the addresses they always copy. Everything the compose window sets " +
      "can be set: formatted text, pictures in it, attachments, priority, " +
      "receipts. Returns the draft's id: link the draft with it, and to " +
      "change the draft pass it to update_draft rather than writing another.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        cc: { type: "string" },
        bcc: { type: "string" },
        subject: { type: "string" },
        ...DRAFT_PROPERTIES,
        from: { type: "string", description: "Which identity to write as" },
        replyTo: { type: "string" },
        inReplyTo: { type: "string", description: "Message id being replied to" },
        attachments: {
          type: "array",
          items: { type: "string" },
          description:
            "Files on this computer to attach, each by its full path -- " +
            "one from get_attachment included",
        },
      },
    },
  },
  {
    name: "update_draft",
    description:
      "Change a draft where it is: one create_draft saved, or any other " +
      "message in a Drafts folder. Give its id and only what is to change; " +
      "everything else stays as it was -- text, formatting, attachments " +
      "and settings. A field given as an empty string is cleared. New text " +
      "replaces the whole text: to change part of a draft and keep its " +
      "formatting, read it with get_message and html: true, change that " +
      "HTML, and give all of it back as html. The draft is saved again, so " +
      "it has a new id, which is returned, and the version it replaces " +
      "goes to the Trash. Nothing is sent.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The draft's id" },
        to: { type: "string" },
        cc: { type: "string" },
        bcc: { type: "string" },
        subject: { type: "string" },
        ...DRAFT_PROPERTIES,
        from: { type: "string", description: "Which identity to write as" },
        replyTo: { type: "string" },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: "Files to add, each by its full path",
        },
        removeAttachments: {
          type: "array",
          items: { type: "string" },
          description: "Attachments to take off, by name",
        },
      },
      required: ["id"],
    },
  },
];

/** MCP tool name to endpoint method. */
const METHOD_FOR_TOOL = {
  search_mail: "search",
  get_message: "getMessage",
  get_attachment: "getAttachment",
  get_thread: "getThread",
  list_folders: "listFolders",
  list_identities: "listIdentities",
  create_draft: "createDraft",
  update_draft: "updateDraft",
};

/**
 * @param {object} message - A JSON-RPC request.
 * @returns {Promise<?object>} The response, or null for a notification.
 */
async function handle(message) {
  const reply = result => ({ jsonrpc: "2.0", id: message.id, result });

  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "thunderbird-mail", version: "1.0.0" },
      });

    case "notifications/initialized":
      return null;

    case "tools/list":
      return reply({ tools: TOOLS });

    case "tools/call": {
      const tool = message.params?.name;
      const endpointMethod = METHOD_FOR_TOOL[tool];
      if (!endpointMethod) {
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: `no such tool: ${tool}` },
        };
      }
      try {
        const result = await callEndpoint(
          endpointMethod,
          message.params?.arguments ?? {}
        );
        return reply({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (ex) {
        // Reported as a tool result rather than a protocol error, so the
        // model can read what went wrong and try something else.
        return reply({
          content: [{ type: "text", text: `Error: ${ex.message}` }],
          isError: true,
        });
      }
    }

    default:
      if (message.id === undefined) {
        return null;
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `unknown method: ${message.method}` },
      };
  }
}

// -- stdio framing --------------------------------------------------------
//
// One JSON object per line, which is what MCP's stdio transport uses.

let buffer = "";
// A request that is still waiting on the endpoint must not be abandoned when
// stdin closes, or the last call of a session is silently dropped.
let pending = 0;
let inputEnded = false;
let draining = false;

function exitWhenIdle() {
  // Lines still in the buffer count as work: the reader loop awaits each
  // call, so later requests sit unread while an earlier one is in flight.
  // Exiting on "nothing pending" alone dropped every call after the first.
  if (inputEnded && pending == 0 && !draining && !buffer.includes("\n")) {
    process.exit(0);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", async chunk => {
  buffer += chunk;
  if (draining) {
    // Already inside the loop below; it will pick this up.
    return;
  }
  draining = true;
  let newline;
  while ((newline = buffer.indexOf("\n")) > -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (ex) {
      continue;
    }
    pending++;
    try {
      const response = await handle(message);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (ex) {
      process.stderr.write(`bridge failed: ${ex.message}\n`);
    } finally {
      pending--;
    }
  }
  draining = false;
  exitWhenIdle();
});

process.stdin.on("end", () => {
  inputEnded = true;
  exitWhenIdle();
});
