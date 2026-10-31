import { expect, test } from "bun:test";
import type { ProviderName } from "../../policy/policy";
import { type CacheWriteHint, extractUsage, UsageObserver } from "../usage";

const encoder = new TextEncoder();
const event = (type: string, value: unknown) =>
  `event: ${type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
const observe = (
  provider: ProviderName,
  text: string,
  nativeSearch = false,
  width = 7,
  cacheWriteHint: CacheWriteHint = "unknown",
) => {
  const parser = new UsageObserver(provider, nativeSearch, cacheWriteHint);
  const bytes = encoder.encode(text);
  for (let i = 0; i < bytes.length; i += width) parser.push(bytes.subarray(i, i + width));
  return parser.finish();
};

test("OpenAI completed usage partitions cache and deduplicates final search calls", () => {
  const response = {
    status: "completed",
    output: [
      {
        type: "web_search_call",
        id: "ws1",
        status: "completed",
        action: { type: "search", queries: ["a", "b"] },
      },
      { type: "web_search_call", id: "ws1", status: "completed", action: { type: "search" } },
    ],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 7 },
    },
  };
  const text = `: ping\r\n\r\n${event("response.output_item.done", { type: "response.output_item.done", item: response.output[0] })}${event("response.completed", { type: "response.completed", response })}`;
  expect(observe("openai", text, true, 1)).toEqual({
    input: 60,
    cachedInput: 30,
    cacheWrite5m: 10,
    cacheWrite1h: 0,
    output: 20,
    reasoning: 7,
    searchCalls: 1,
  });
  expect(extractUsage("openai", response, true)?.searchCalls).toBe(1);
  // Page-open/find actions are charged at the search-call rate rather than refunded.
  for (const action of ["open_page", "find_in_page"]) {
    const ambiguous = {
      ...response,
      output: [
        ...response.output,
        {
          type: "web_search_call",
          id: "ws2",
          status: "completed",
          action: { type: action },
        },
      ],
    };
    expect(extractUsage("openai", ambiguous, true)?.searchCalls).toBe(2);
    expect(
      observe(
        "openai",
        event("response.completed", { type: "response.completed", response: ambiguous }),
        true,
      )?.searchCalls,
    ).toBe(2);
  }
  const unknownAction = {
    ...response,
    output: [
      { type: "web_search_call", id: "ws3", status: "completed", action: { type: "unknown" } },
    ],
  };
  expect(extractUsage("openai", unknownAction, true)).toBeNull();
  for (const status of ["incomplete", "failed"] as const) {
    const terminal = { ...response, status };
    expect(
      observe(
        "openai",
        event(`response.${status}`, { type: `response.${status}`, response: terminal }),
        true,
      )?.output,
    ).toBe(20);
    expect(extractUsage("openai", terminal, true)?.input).toBe(60);
    expect(
      observe(
        "openai",
        event(`response.${status}`, {
          type: `response.${status}`,
          response: { ...terminal, usage: null },
        }),
        true,
      ),
    ).toBeNull();
  }
  expect(
    observe(
      "openai",
      event("response.completed", { type: "response.completed", response }).slice(0, -14),
      true,
    ),
  ).toBeNull();
});

test("OpenAI search usage requires completed final item status", () => {
  const completed = {
    type: "web_search_call",
    id: "ws1",
    status: "completed",
    action: { type: "search" },
  };
  for (const status of [undefined, "unknown", "in_progress", "searching", "failed", "incomplete"]) {
    const ambiguous = {
      type: "web_search_call",
      id: "ws1",
      action: { type: "search" },
      ...(status === undefined ? {} : { status }),
    };
    const response = {
      status: "completed",
      // A duplicate ID must not hide an unconfirmed final item.
      output: [completed, ambiguous],
      usage: { input_tokens: 100, output_tokens: 20 },
    };
    expect(extractUsage("openai", response, true)).toBeNull();
    // An earlier completed event cannot override the final response's item status.
    expect(
      observe(
        "openai",
        event("response.output_item.done", {
          type: "response.output_item.done",
          item: completed,
        }) + event("response.completed", { type: "response.completed", response }),
        true,
      ),
    ).toBeNull();
  }
});

test("Anthropic replaces cumulative deltas and keeps cache classes disjoint", () => {
  const start = event("message_start", {
    type: "message_start",
    message: {
      usage: {
        input_tokens: 8,
        cache_read_input_tokens: 12,
        cache_creation_input_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 },
        output_tokens: 1,
      },
    },
  });
  const search = event("content_block_start", {
    type: "content_block_start",
    content_block: { type: "server_tool_use", name: "web_search" },
  });
  const first = event("message_delta", {
    type: "message_delta",
    usage: { output_tokens: 4, server_tool_use: { web_search_requests: 1 } },
  });
  const last = event("message_delta", {
    type: "message_delta",
    usage: { output_tokens: 9, server_tool_use: { web_search_requests: 2 } },
  });
  const stop = event("message_stop", { type: "message_stop" });
  expect(observe("anthropic", start + search + first + last + stop, true)).toEqual({
    input: 8,
    cachedInput: 12,
    cacheWrite5m: 6,
    cacheWrite1h: 4,
    output: 9,
    reasoning: 0,
    searchCalls: 2,
  });
  expect(
    observe(
      "anthropic",
      start +
        search +
        event("message_delta", { type: "message_delta", usage: { output_tokens: 9 } }) +
        stop,
      true,
    ),
  ).toBeNull();
  expect(observe("anthropic", start + first)).toBeNull();
});

test("Anthropic aggregate cache writes require an explicit 5m request hint", () => {
  const reported = { input_tokens: 3, cache_creation_input_tokens: 11, output_tokens: 1 };
  const start = event("message_start", { type: "message_start", message: { usage: reported } });
  const delta = event("message_delta", { type: "message_delta", usage: { output_tokens: 5 } });
  const stop = event("message_stop", { type: "message_stop" });
  const expected = {
    input: 3,
    cachedInput: 0,
    cacheWrite5m: 11,
    cacheWrite1h: 0,
    output: 5,
    reasoning: 0,
    searchCalls: 0,
  };
  expect(observe("anthropic", start + delta + stop)).toBeNull();
  expect(observe("anthropic", start + delta + stop, false, 7, "5m")).toEqual(expected);
  const json = { type: "message", usage: { ...reported, output_tokens: 5 } };
  expect(extractUsage("anthropic", json, false)).toBeNull();
  expect(extractUsage("anthropic", json, false, "5m")).toEqual(expected);
});

test("Google requires finish reason and complete usage; no native grounding estimate", () => {
  const first = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "é" }] } }] })}\n\n`;
  const final = `data: ${JSON.stringify({
    candidates: [{ finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 25,
      cachedContentTokenCount: 5,
      candidatesTokenCount: 9,
      thoughtsTokenCount: 6,
    },
  })}\n\n`;
  expect(observe("google", first + final, false, 1)).toEqual({
    input: 20,
    cachedInput: 5,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 15,
    reasoning: 6,
    searchCalls: 0,
  });
  expect(observe("google", first)).toBeNull();
  expect(observe("google", first + final, true)).toBeNull();
});

test("DeepSeek and OpenRouter need whole-request usage and DONE", () => {
  const final = {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 20,
      prompt_tokens_details: { cached_tokens: 5 },
      prompt_cache_hit_tokens: 5,
      prompt_cache_miss_tokens: 15,
      completion_tokens: 11,
      completion_tokens_details: { reasoning_tokens: 3 },
    },
  };
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }], usage: null })}\n\n` +
    `data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`;
  const expected = {
    input: 15,
    cachedInput: 5,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 11,
    reasoning: 3,
    searchCalls: 0,
  };
  expect(observe("deepseek", body)).toEqual(expected);
  expect(observe("openrouter", body)).toEqual(expected);
  expect(observe("openrouter", `${body}\r\n: harmless comment\r\n \t\r\n`, false, 1)).toEqual(
    expected,
  );
  expect(observe("openrouter", `${body}data: {"unexpected":true}\n\n`)).toBeNull();
  const withoutDuplicateCache = structuredClone(final);
  delete (withoutDuplicateCache.usage.prompt_tokens_details as { cached_tokens?: number })
    .cached_tokens;
  expect(
    observe("deepseek", `data: ${JSON.stringify(withoutDuplicateCache)}\n\ndata: [DONE]\n\n`),
  ).toEqual(expected);
  expect(observe("deepseek", body.replace("data: [DONE]\n\n", ""))).toBeNull();
  expect(
    observe(
      "openrouter",
      body.replace("data: [DONE]\n\n", 'event: error\ndata: {"type":"error"}\n\n'),
    ),
  ).toBeNull();
});

test("multiline SSE data and stream errors remain bounded and terminal-aware", () => {
  const response = {
    status: "completed",
    output: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const multiline = `event: response.completed\ndata: {\ndata: "type":"response.completed",\ndata: "response":${JSON.stringify(response)}\ndata: }\n\n`;
  const expected = {
    input: 0,
    cachedInput: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    reasoning: 0,
    searchCalls: 0,
  };
  expect(observe("openai", multiline)).toEqual(expected);
  expect(observe("openai", multiline + event("error", { type: "error" }))).toBeNull();
});

test("Jev JSON and zero usage are retained; malformed or oversized counts are unknown", () => {
  expect(
    extractUsage(
      "typesafe",
      { model: "jev-1.13.0", usage: { input_tokens: 0, output_tokens: 0 } },
      false,
    ),
  ).toEqual({
    input: 0,
    cachedInput: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    reasoning: 0,
    searchCalls: 0,
  });
  expect(
    extractUsage(
      "typesafe",
      { model: "jev-1.13.0", usage: { input_tokens: -1, output_tokens: 0 } },
      false,
    ),
  ).toBeNull();
  expect(
    extractUsage(
      "openai",
      {
        status: "completed",
        usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 2 }, output_tokens: 0 },
      },
      false,
    ),
  ).toBeNull();
  expect(
    extractUsage(
      "openai",
      { status: "completed", usage: { input_tokens: 1_000_000_001, output_tokens: 0 } },
      false,
    ),
  ).toBeNull();
  expect(
    extractUsage(
      "anthropic",
      {
        type: "message",
        content: [{ type: "server_tool_use", name: "web_search" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      true,
    ),
  ).toBeNull();
});

test("SSE event and total stream limits invalidate without retaining payloads", () => {
  const parser = new UsageObserver("openai", false);
  parser.push(encoder.encode(`data: ${"a".repeat(8 * 1024 * 1024)}\n\n`));
  expect(parser.finish()).toBeNull();
  const oversized = new UsageObserver("openai", false);
  oversized.push(new Uint8Array(32 * 1024 * 1024 + 1));
  expect(oversized.finish()).toBeNull();
});

const stopped = (provider: ProviderName, text: string, estimatedInput = 100) => {
  const parser = new UsageObserver(provider, false);
  const bytes = encoder.encode(text);
  for (let i = 0; i < bytes.length; i += 5) parser.push(bytes.subarray(i, i + 5));
  return parser.interrupted(estimatedInput);
};

test("stopped streams estimate output from delivered text, at most three bytes per token", () => {
  expect(
    stopped(
      "openai",
      event("response.output_text.delta", { type: "response.output_text.delta", delta: "abcdef" }) +
        event("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          delta: '{"q":1}',
        }),
    ),
  ).toMatchObject({ input: 100, output: 5, reasoning: 0, searchCalls: 0 });
  // CJK text is three UTF-8 bytes per character and about one token each.
  expect(
    stopped(
      "deepseek",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "你好世界" } }] })}\n\n`,
    ),
  ).toMatchObject({ input: 100, output: 4 });
});

test("stopped Anthropic and Google streams prefer provider-reported partial counts", () => {
  expect(
    stopped(
      "anthropic",
      event("message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 42, output_tokens: 1, cache_read_input_tokens: 8 } },
      }) +
        event("content_block_delta", {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "x".repeat(30) },
        }),
    ),
  ).toMatchObject({ input: 42, cachedInput: 8, output: 10 });
  expect(
    stopped(
      "google",
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: "hi" }] } }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
      })}\n\n`,
    ),
  ).toMatchObject({ input: 50, output: 20 });
});
