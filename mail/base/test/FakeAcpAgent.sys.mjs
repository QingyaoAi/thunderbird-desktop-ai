/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A stand-in for dsh in ACP mode, for tests: a small Python program that
 * speaks just enough of the Agent Client Protocol to be driven the way the
 * AI panel drives dsh.
 *
 * At session/new it checks that the MCP server it was given answers to the
 * token it was given. Each prompt then produces a thought, one tool call that
 * asks for permission, and a message reporting what the agent saw, as JSON.
 * A prompt of "wait" stays open until it is cancelled; "crash" exits; "link"
 * answers with a link to the message sent with it, and one to a message that
 * does not exist; "mention" has a mail tool return that message and names it
 * without a link.
 */

/**
 * The program. Run it as a program in its own right -- it is not a script
 * for node -- so the "node" setting only decides what leads its PATH.
 */
export const FAKE_ACP_AGENT = `#!/usr/bin/env python3
import json, os, sys, urllib.request

def send(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()

def result(rid, value):
    send({"jsonrpc": "2.0", "id": rid, "result": value})

def update(value):
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": "s1", "update": value}})

inbox = []
cancelled = []

def read():
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    return json.loads(line)

def wait_for_response(rid):
    while True:
        message = read()
        if message.get("id") == rid and "method" not in message:
            return message
        if message.get("method") == "session/cancel":
            cancelled.append(True)
        else:
            inbox.append(message)

model = "deepseek/v4"
def model_options():
    return [{"id": "model", "name": "Model", "type": "select",
             "currentValue": model,
             "options": [{"group": "deepseek", "name": "DeepSeek", "options": [
                 {"value": "deepseek/v4", "name": "v4"},
                 {"value": "deepseek/v4-pro", "name": "v4 pro"}]}]}]

tools = None
cwd = None
while True:
    message = inbox.pop(0) if inbox else read()
    method = message.get("method")
    rid = message.get("id")
    params = message.get("params") or {}
    if method == "initialize":
        result(rid, {"protocolVersion": 1,
                     "agentCapabilities": {"mcpCapabilities": {"http": True}}})
    elif method == "session/new":
        server = params["mcpServers"][0]
        headers = {h["name"]: h["value"] for h in server["headers"]}
        headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            server["url"], headers=headers,
            data=json.dumps({"jsonrpc": "2.0", "id": 1,
                             "method": "tools/list"}).encode())
        answer = json.load(urllib.request.urlopen(request, timeout=10))
        tools = len(answer["result"]["tools"])
        cwd = params["cwd"]
        result(rid, {"sessionId": "s1", "configOptions": model_options()})
    elif method == "session/prompt":
        text = "".join(b.get("text", "") for b in params["prompt"]
                       if b.get("type") == "text")
        links = [b["uri"] for b in params["prompt"]
                 if b.get("type") == "resource_link"]
        if text == "crash":
            sys.stderr.write("the stand-in fell over\\n")
            sys.stderr.flush()
            os._exit(3)
        if text == "mention":
            update({"sessionUpdate": "tool_call", "toolCallId": "m1",
                    "title": "mcp__thunderbird__search_mail", "kind": "other",
                    "status": "in_progress", "rawInput": {"query": "budget"}})
            found = {"messages": [
                {"id": links[0], "subject": "Budget review for the third quarter"},
                {"id": "imap-message://nobody@nowhere/INBOX#9", "subject": "Hi"}]}
            update({"sessionUpdate": "tool_call_update", "toolCallId": "m1",
                    "status": "completed",
                    "content": [{"type": "content", "content": {
                        "type": "text", "text": json.dumps(found)}}]})
            update({"sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text":
                        "See 《Budget review for the third quarter》. Hi. " +
                        "Also [Budget review for the third quarter](<" +
                        links[0] + ">)."}})
            result(rid, {"stopReason": "end_turn"})
            continue
        if text == "link":
            update({"sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text":
                        "See [the [open] message](<" + links[0] + ">) and " +
                        "[a made-up one](<imap-message://nobody@nowhere/INBOX#1>)."}})
            result(rid, {"stopReason": "end_turn"})
            continue
        if text == "wait":
            while not cancelled:
                later = read()
                if later.get("method") == "session/cancel":
                    cancelled.append(True)
                else:
                    inbox.append(later)
            cancelled.clear()
            result(rid, {"stopReason": "cancelled"})
            continue
        update({"sessionUpdate": "agent_thought_chunk",
                "content": {"type": "text", "text": "thinking"}})
        update({"sessionUpdate": "tool_call", "toolCallId": "t1",
                "title": "mcp__thunderbird__list_tags", "kind": "other",
                "status": "in_progress", "rawInput": {}})
        send({"jsonrpc": "2.0", "id": "perm-1",
              "method": "session/request_permission",
              "params": {"sessionId": "s1", "toolCall": {"toolCallId": "t1"},
                         "options": [
                             {"optionId": "allow-once", "name": "Allow once",
                              "kind": "allow_once"},
                             {"optionId": "reject-once", "name": "Reject",
                              "kind": "reject_once"}]}})
        outcome = wait_for_response("perm-1")["result"]["outcome"]
        chosen = (outcome.get("optionId") if outcome["outcome"] == "selected"
                  else "cancelled")
        update({"sessionUpdate": "tool_call_update", "toolCallId": "t1",
                "status": "completed" if chosen == "allow-once" else "failed",
                "content": [{"type": "content",
                             "content": {"type": "text", "text": "3 tags"}}]})
        same_dir = os.path.realpath(os.getcwd()) == os.path.realpath(cwd)
        report = {"said": text, "tools": tools, "sameDir": same_dir,
                  "path": os.environ["PATH"].split(":")[0],
                  "permission": chosen, "links": links,
                  "argv": sys.argv[1:]}
        update({"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": json.dumps(report)}})
        result(rid, {"stopReason": "end_turn"})
    elif method == "session/set_config_option":
        model = params["value"]
        result(rid, {"configOptions": model_options()})
    elif method == "session/close":
        result(rid, {})
    elif rid is not None:
        send({"jsonrpc": "2.0", "id": rid,
              "error": {"code": -32601, "message": "not here"}})
`;

/**
 * Write the stand-in into a folder, ready to run.
 *
 * @param {string} dir
 * @returns {Promise<string>} Its path.
 */
export async function writeFakeAcpAgent(dir) {
  const path = PathUtils.join(dir, "fake-dsh");
  await IOUtils.writeUTF8(path, FAKE_ACP_AGENT);
  await IOUtils.setPermissions(path, 0o755);
  return path;
}
