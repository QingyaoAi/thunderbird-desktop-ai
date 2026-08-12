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

/** The tools offered, and what they take. */
const TOOLS = [
  {
    name: "search_mail",
    description:
      "Search the user's mailbox. `query` is full-text and ranked the way " +
      "Thunderbird's own search ranks it. The other fields narrow the " +
      "results, and may be used without a query as long as a folder is " +
      "given. Dates are ISO 8601.",
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
      "in the reply headers and subject.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        cc: { type: "string" },
        bcc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        from: { type: "string", description: "Which identity to write as" },
        replyTo: { type: "string" },
        inReplyTo: { type: "string", description: "Message id being replied to" },
      },
    },
  },
];

/** MCP tool name to endpoint method. */
const METHOD_FOR_TOOL = {
  search_mail: "search",
  get_message: "getMessage",
  get_thread: "getThread",
  list_folders: "listFolders",
  list_identities: "listIdentities",
  create_draft: "createDraft",
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
