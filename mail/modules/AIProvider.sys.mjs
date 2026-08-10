/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Talking to a chat model, in either of the two request/response shapes the
 * industry has settled on.
 *
 * Callers use one method -- `chat()` -- and get back a normalized result, so
 * nothing above this file needs to know which format an endpoint speaks. The
 * format is a property of the endpoint, not of the vendor: DeepSeek, for one,
 * serves both, and most self-hosted servers speak the OpenAI shape.
 *
 * This module deliberately knows nothing about mail, and nothing about where
 * the API key came from -- the caller passes one in. See AIConfig.sys.mjs for
 * where keys are stored (the login manager, never a file).
 */

/**
 * Endpoint formats we can speak.
 *
 * @enum {string}
 */
export const AIFormat = {
  /** POST {baseUrl}/chat/completions, "Authorization: Bearer". */
  OPENAI: "openai",
  /** POST {baseUrl}/v1/messages, "x-api-key" + "anthropic-version". */
  ANTHROPIC: "anthropic",
};

/** Sent as anthropic-version; the shape below is stable across it. */
const ANTHROPIC_VERSION = "2023-06-01";

/** Default ceiling on a reply, when a caller doesn't specify one. */
const DEFAULT_MAX_TOKENS = 2048;

/**
 * A request failed in a way worth telling the user about. Carries the HTTP
 * status when there was one, so callers can distinguish "your key is wrong"
 * (401) from "the service is down" (5xx) from "we never got that far".
 */
export class AIProviderError extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {?number} [options.status] - HTTP status, if a response arrived.
   * @param {Error} [options.cause]
   */
  constructor(message, { status = null, cause } = {}) {
    super(message, { cause });
    this.name = "AIProviderError";
    this.status = status;
  }

  /**
   * Whether retrying the identical request could plausibly succeed. A bad
   * key or a malformed request will fail again; a 429 or a 503 might not.
   *
   * @returns {boolean}
   */
  get isTransient() {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

/**
 * Turn an HTTP error response into something a person can act on. Providers
 * disagree on the error envelope, so try the common shapes before falling
 * back to the raw body.
 *
 * @param {number} status
 * @param {string} bodyText
 * @returns {AIProviderError}
 */
function errorFromResponse(status, bodyText) {
  let detail = bodyText?.trim() ?? "";
  try {
    const parsed = JSON.parse(bodyText);
    // OpenAI: {error: {message}}. Anthropic: {error: {message}} too, but
    // some gateways use {message} or {detail} at the top level.
    detail =
      parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? detail;
  } catch {
    // Not JSON; the raw body is the best we have.
  }
  if (detail.length > 500) {
    detail = detail.slice(0, 500) + "…";
  }

  let summary;
  switch (status) {
    case 401:
    case 403:
      summary = "The API key was rejected";
      break;
    case 404:
      summary = "The endpoint or model was not found";
      break;
    case 429:
      summary = "Rate limited by the provider";
      break;
    default:
      summary = status >= 500 ? "The provider had an error" : "Request failed";
  }

  return new AIProviderError(
    detail ? `${summary}: ${detail}` : `${summary} (HTTP ${status})`,
    { status }
  );
}

/**
 * Join a base URL and a path without doubling or dropping the slash between
 * them. Base URLs get pasted in by hand, so both "…/anthropic" and
 * "…/anthropic/" have to work.
 *
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Build the OpenAI-shaped request.
 *
 * @param {object} args
 * @returns {{url: string, headers: object, body: object}}
 */
function buildOpenAIRequest({ baseUrl, apiKey, model, system, messages, maxTokens, temperature }) {
  // In this shape the system prompt is just the first message.
  const allMessages = system
    ? [{ role: "system", content: system }, ...messages]
    : messages;

  return {
    url: joinUrl(baseUrl, "chat/completions"),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: {
      model,
      messages: allMessages,
      max_tokens: maxTokens,
      ...(temperature === undefined ? {} : { temperature }),
    },
  };
}

/**
 * Build the Anthropic-shaped request.
 *
 * @param {object} args
 * @returns {{url: string, headers: object, body: object}}
 */
function buildAnthropicRequest({ baseUrl, apiKey, model, system, messages, maxTokens, temperature }) {
  return {
    url: joinUrl(baseUrl, "v1/messages"),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: {
      model,
      // Here the system prompt is a top-level field, not a message.
      ...(system ? { system } : {}),
      messages,
      max_tokens: maxTokens,
      ...(temperature === undefined ? {} : { temperature }),
    },
  };
}

/**
 * Pull the assistant's text out of an OpenAI-shaped response.
 *
 * @param {object} data
 * @returns {{text: string, usage: object}}
 */
function parseOpenAIResponse(data) {
  const message = data?.choices?.[0]?.message;
  if (typeof message?.content !== "string") {
    throw new AIProviderError(
      "The provider returned a response with no message content."
    );
  }
  return {
    text: message.content,
    // Surfaced so a truncated reply can be told apart from a genuinely
    // empty one: "length" means the output budget ran out.
    finishReason: data?.choices?.[0]?.finish_reason ?? null,
    // Reasoning models return their scratch work separately. It is not part
    // of the answer, but it is worth keeping for debugging.
    reasoning: message.reasoning_content ?? null,
    usage: {
      inputTokens: data?.usage?.prompt_tokens ?? null,
      outputTokens: data?.usage?.completion_tokens ?? null,
    },
  };
}

/**
 * Pull the assistant's text out of an Anthropic-shaped response.
 *
 * @param {object} data
 * @returns {{text: string, usage: object}}
 */
function parseAnthropicResponse(data) {
  const blocks = data?.content;
  if (!Array.isArray(blocks)) {
    throw new AIProviderError(
      "The provider returned a response with no content blocks."
    );
  }

  // The content array is a sequence of typed blocks, and for a reasoning
  // model the first one is "thinking" rather than "text" -- so this has to
  // select by type rather than taking blocks[0].
  const text = blocks
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text)
    .join("");

  const reasoning =
    blocks
      .filter(block => block?.type === "thinking")
      .map(block => block.thinking)
      .join("") || null;

  if (!text) {
    throw new AIProviderError(
      "The provider returned no text content (only reasoning or tool blocks)."
    );
  }

  return {
    text,
    reasoning,
    finishReason: data?.stop_reason ?? null,
    usage: {
      inputTokens: data?.usage?.input_tokens ?? null,
      outputTokens: data?.usage?.output_tokens ?? null,
    },
  };
}

/**
 * Send a chat request and return the reply.
 *
 * @param {object} options
 * @param {string} options.format - One of AIFormat.
 * @param {string} options.baseUrl - e.g. "https://api.deepseek.com".
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {Array<{role: string, content: string}>} options.messages -
 *   Conversation so far, oldest first. Roles are "user" and "assistant".
 * @param {string} [options.system] - System prompt, placed correctly for
 *   whichever format is in use.
 * @param {number} [options.maxTokens]
 * @param {number} [options.temperature]
 * @param {AbortSignal} [options.signal] - To cancel an in-flight request.
 * @returns {Promise<{text: string, reasoning: ?string, usage: object}>}
 * @throws {AIProviderError}
 */
export async function chat({
  format,
  baseUrl,
  apiKey,
  model,
  messages,
  system,
  maxTokens = DEFAULT_MAX_TOKENS,
  temperature,
  signal,
} = {}) {
  if (!baseUrl) {
    throw new AIProviderError("No API base URL is configured.");
  }
  if (!apiKey) {
    throw new AIProviderError("No API key is configured.");
  }
  if (!model) {
    throw new AIProviderError("No model is configured.");
  }
  if (!Array.isArray(messages) || !messages.length) {
    throw new AIProviderError("A request needs at least one message.");
  }

  let build, parse;
  switch (format) {
    case AIFormat.OPENAI:
      build = buildOpenAIRequest;
      parse = parseOpenAIResponse;
      break;
    case AIFormat.ANTHROPIC:
      build = buildAnthropicRequest;
      parse = parseAnthropicResponse;
      break;
    default:
      throw new AIProviderError(`Unknown API format: ${format}`);
  }

  const request = build({
    baseUrl,
    apiKey,
    model,
    system,
    messages,
    maxTokens,
    temperature,
  });

  let response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (ex) {
    if (ex?.name === "AbortError") {
      throw ex;
    }
    // No response at all: offline, DNS, TLS, wrong host.
    throw new AIProviderError(
      `Could not reach ${request.url}. Check the base URL and your connection.`,
      { cause: ex }
    );
  }

  if (!response.ok) {
    throw errorFromResponse(response.status, await response.text());
  }

  let data;
  try {
    data = await response.json();
  } catch (ex) {
    throw new AIProviderError("The provider returned a malformed response.", {
      status: response.status,
      cause: ex,
    });
  }

  return parse(data);
}

/**
 * Read an SSE body line by line, yielding each `data:` payload.
 *
 * Chunks arrive at arbitrary boundaries, so a partial line at the end of one
 * chunk has to be held back and joined to the start of the next -- otherwise
 * JSON.parse fails on a truncated object partway through a stream.
 *
 * @param {Response} response
 * @yields {string} One `data:` payload, without the prefix.
 */
async function* sseData(response) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      // Blank lines separate events; "event:" names them, and we key off
      // the payload's own type field instead, so only data matters here.
      if (line.startsWith("data:")) {
        yield line.slice(5).trim();
      }
    }
  }
}

/**
 * Pull a delta out of one OpenAI-shaped stream payload.
 *
 * @param {object} payload
 * @returns {?{kind: string, text: string}}
 */
function openAIDelta(payload) {
  const delta = payload?.choices?.[0]?.delta;
  if (!delta) {
    return null;
  }
  // Reasoning models emit reasoning_content first, with content null, then
  // switch over to content for the answer itself.
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    return { kind: "reasoning", text: delta.reasoning_content };
  }
  if (typeof delta.content === "string" && delta.content) {
    return { kind: "text", text: delta.content };
  }
  return null;
}

/**
 * Pull a delta out of one Anthropic-shaped stream payload.
 *
 * @param {object} payload
 * @returns {?{kind: string, text: string}}
 */
function anthropicDelta(payload) {
  if (payload?.type !== "content_block_delta") {
    return null;
  }
  const delta = payload.delta;
  if (delta?.type === "thinking_delta" && delta.thinking) {
    return { kind: "reasoning", text: delta.thinking };
  }
  if (delta?.type === "text_delta" && delta.text) {
    return { kind: "text", text: delta.text };
  }
  return null;
}

/**
 * Send a chat request and receive the reply incrementally.
 *
 * Reasoning and answer text are reported separately, because they are shown
 * differently: reasoning is transient progress, the answer is the result.
 * Callers get told when reasoning ends (the first text delta) so they can
 * collapse it.
 *
 * @param {object} options - Everything `chat()` takes, plus:
 * @param {Function} [options.onReasoning] - Called with each reasoning
 *   fragment as it arrives.
 * @param {Function} [options.onText] - Called with each answer fragment.
 * @param {Function} [options.onReasoningEnd] - Called once, when the answer
 *   starts, if there was any reasoning.
 * @returns {Promise<{text: string, reasoning: ?string, usage: object}>} The
 *   assembled result, for storing in the transcript.
 * @throws {AIProviderError}
 */
export async function chatStream({
  format,
  baseUrl,
  apiKey,
  model,
  messages,
  system,
  maxTokens = DEFAULT_MAX_TOKENS,
  temperature,
  signal,
  onReasoning,
  onText,
  onReasoningEnd,
} = {}) {
  if (!baseUrl || !apiKey || !model) {
    throw new AIProviderError("The AI provider is not fully configured.");
  }

  let build, extractDelta;
  switch (format) {
    case AIFormat.OPENAI:
      build = buildOpenAIRequest;
      extractDelta = openAIDelta;
      break;
    case AIFormat.ANTHROPIC:
      build = buildAnthropicRequest;
      extractDelta = anthropicDelta;
      break;
    default:
      throw new AIProviderError(`Unknown API format: ${format}`);
  }

  const request = build({
    baseUrl,
    apiKey,
    model,
    system,
    messages,
    maxTokens,
    temperature,
  });
  request.body.stream = true;

  let response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (ex) {
    if (ex?.name === "AbortError") {
      throw ex;
    }
    throw new AIProviderError(
      `Could not reach ${request.url}. Check the base URL and your connection.`,
      { cause: ex }
    );
  }

  if (!response.ok) {
    throw errorFromResponse(response.status, await response.text());
  }

  let text = "";
  let reasoning = "";
  let reasoningEnded = false;

  for await (const payload of sseData(response)) {
    // OpenAI terminates the stream with a literal sentinel.
    if (payload === "[DONE]") {
      break;
    }

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A keep-alive or comment we don't recognise; skipping it is safer
      // than aborting a stream that is otherwise fine.
      continue;
    }

    const delta = extractDelta(parsed);
    if (!delta) {
      continue;
    }

    if (delta.kind === "reasoning") {
      reasoning += delta.text;
      onReasoning?.(delta.text);
    } else {
      // First answer text: reasoning is over, so let the UI put it away.
      if (!reasoningEnded) {
        reasoningEnded = true;
        if (reasoning) {
          onReasoningEnd?.();
        }
      }
      text += delta.text;
      onText?.(delta.text);
    }
  }

  if (!reasoningEnded && reasoning) {
    // Reasoning but no answer -- still let the caller close the display.
    onReasoningEnd?.();
  }

  return {
    text,
    reasoning: reasoning || null,
    // Streaming responses report usage inconsistently across providers, so
    // it is deliberately not promised here.
    usage: { inputTokens: null, outputTokens: null },
  };
}

export const AIProvider = {
  chat,
  chatStream,
  AIFormat,
  AIProviderError,
};
