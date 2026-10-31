import { expect, test } from "bun:test";
import type { Model, ProviderName } from "../../policy/policy";
import { prepareRequest } from "../protocol";
import { reserveInput } from "../reservation";

function model(provider: ProviderName, overrides: Partial<Model> = {}): Model {
  return {
    id: provider,
    provider,
    upstreamModel: provider === "typesafe" ? "jev-1.13.0" : "synthetic-model",
    displayName: "Synthetic",
    enabled: true,
    pricingReviewed: true,
    roles: ["lead"],
    recommendedRoles: ["lead"],
    plans: ["free"],
    contextWindow: 64_000,
    maxOutput: 1000,
    maxRequestBytes: 8 * 1024 * 1024,
    maxSearchCalls: 2,
    supports: {
      tools: true,
      vision: true,
      promptCache: true,
      reasoning: true,
      nativeSearch: true,
    },
    rates: {
      input: "1",
      cachedInput: "1",
      cacheWrite5m: "1",
      cacheWrite1h: "1",
      output: "1",
      searchCall: "1",
    },
    pricingSource: "synthetic",
    ...overrides,
  } as Model;
}
const prepare = (m: Model, value: unknown) => prepareRequest(m, value, "user", "test-secret");

test("complete chat text and tool schemas reserve locally below full context", () => {
  for (const provider of ["openrouter", "deepseek"] as const) {
    const m = model(provider, {
      maxSearchCalls: 0,
      supports: {
        tools: true,
        vision: true,
        promptCache: true,
        reasoning: true,
        nativeSearch: false,
      },
    });
    const simple = reserveInput(
      m,
      prepare(m, { messages: [{ role: "user", content: "hello" }], stream: true }),
    );
    const withHistory = reserveInput(
      m,
      prepare(m, {
        messages: [
          { role: "system", content: "You are a careful assistant" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "Good morning" },
          { role: "user", content: "Summarize the prior exchange" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up a known local identifier",
              parameters: { type: "object", properties: { id: { type: "string" } } },
            },
          },
        ],
        stream: true,
      }),
    );
    expect(simple.inputTokens).toBeGreaterThan(0);
    expect(simple.inputTokens).toBeLessThan(m.contextWindow);
    expect(withHistory.inputTokens).toBeGreaterThan(simple.inputTokens);
    expect(withHistory.inputTokens).toBeLessThan(m.contextWindow);
    expect(withHistory.searchInputTokens).toBe(0);
  }
});

test("OpenAI, Anthropic and Google text reserve below context while embedded images use its ceiling", () => {
  const image = "aGVsbG8=";
  const cases: { provider: "openai" | "anthropic" | "google"; text: unknown; media: unknown }[] = [
    {
      provider: "openai",
      text: { instructions: "Be concise", input: [{ role: "user", content: "Hello" }] },
      media: {
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Describe this screenshot" },
              { type: "input_image", image_url: `data:image/png;base64,${image}` },
            ],
          },
        ],
      },
    },
    {
      provider: "anthropic",
      text: { system: "Be concise", messages: [{ role: "user", content: "Hello" }] },
      media: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this screenshot" },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
            ],
          },
        ],
      },
    },
    {
      provider: "google",
      text: {
        systemInstruction: { parts: [{ text: "Be concise" }] },
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      },
      media: {
        contents: [
          {
            role: "user",
            parts: [
              { text: "Describe this screenshot" },
              { inlineData: { mimeType: "image/png", data: image } },
            ],
          },
        ],
      },
    },
  ];
  for (const { provider, text, media } of cases) {
    const m = model(provider);
    const short = reserveInput(m, prepare(m, text));
    expect(short.inputTokens).toBeGreaterThan(0);
    expect(short.inputTokens).toBeLessThan(m.contextWindow);
    expect(reserveInput(m, prepare(m, media)).inputTokens).toBe(m.contextWindow);
  }
});

test("Jev structured state is locally reserved near actual bytes, not full context", () => {
  const m = model("typesafe", {
    maxSearchCalls: 0,
    supports: {
      tools: false,
      vision: false,
      promptCache: false,
      reasoning: false,
      nativeSearch: false,
    },
  });
  const short = reserveInput(
    m,
    prepare(m, {
      state: { ticket: "Please cancel my account" },
      questions: { cancellation: { type: "noul", instructions: "Does this ask to cancel?" } },
    }),
  );
  const long = reserveInput(
    m,
    prepare(m, {
      state: "x".repeat(59_000),
      questions: { cancellation: { type: "noul", instructions: "Does this ask to cancel?" } },
    }),
  );
  expect(short.inputTokens).toBeLessThan(5_000);
  expect(long.inputTokens).toBeGreaterThan(59_000);
  expect(long.inputTokens).toBeLessThanOrEqual(m.contextWindow);
});

test("embedded PNG/JPEG consume conservative media ceiling; URL and audio sources are rejected", () => {
  const m = model("openrouter", {
    maxSearchCalls: 0,
    supports: {
      tools: true,
      vision: true,
      promptCache: true,
      reasoning: true,
      nativeSearch: false,
    },
  });
  for (const mime of ["png", "jpeg"]) {
    const prepared = prepare(m, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is on this screenshot?" },
            { type: "image_url", image_url: { url: `data:image/${mime};base64,aGVsbG8=` } },
          ],
        },
      ],
    });
    expect(reserveInput(m, prepared).inputTokens).toBe(m.contextWindow);
  }
  const remote = prepare(m, {
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/huge.png" } }],
      },
    ],
  });
  expect(() => reserveInput(m, remote)).toThrow();
  const audio = prepare(m, {
    messages: [
      {
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }],
      },
    ],
  });
  expect(() => reserveInput(m, audio)).toThrow();
});

test("native search reserves one full context per allowed tool call", () => {
  const openai = model("openai");
  const o = reserveInput(
    openai,
    prepare(openai, {
      input: "Find two sources",
      tools: [{ type: "web_search" }],
      max_tool_calls: 2,
    }),
  );
  expect(o.inputTokens).toBeLessThan(openai.contextWindow);
  expect(o.searchInputTokens).toBe(openai.contextWindow * 2);

  const anthropic = model("anthropic");
  const a = reserveInput(
    anthropic,
    prepare(anthropic, {
      messages: [{ role: "user", content: "Find two sources" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    }),
  );
  expect(a.inputTokens).toBeLessThan(anthropic.contextWindow);
  expect(a.searchInputTokens).toBe(anthropic.contextWindow * 2);
});

test("DeepSeek validates native reasoning and parallel fields; OpenRouter forces usage", () => {
  const d = model("deepseek", {
    maxSearchCalls: 0,
    supports: {
      tools: true,
      vision: false,
      promptCache: true,
      reasoning: true,
      nativeSearch: false,
    },
  });
  const valid = prepare(d, {
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    reasoning_effort: "low",
    parallel_tool_calls: false,
  });
  expect(valid.body.reasoning_effort).toBe("low");
  expect(valid.body.parallel_tool_calls).toBe(false);
  expect(() => prepare(d, { messages: [], reasoning_effort: "medium" })).toThrow();
  expect(() => prepare(d, { messages: [], reasoning_effort: ["low"] })).toThrow();
  expect(() => prepare(d, { messages: [], parallel_tool_calls: "false" })).toThrow();

  const o = model("openrouter", {
    maxSearchCalls: 0,
    supports: {
      tools: true,
      vision: false,
      promptCache: true,
      reasoning: true,
      nativeSearch: false,
    },
  });
  const usage = prepare(o, {
    messages: [{ role: "user", content: "hello" }],
    usage: { include: false },
    stream: true,
  });
  expect(usage.body.usage).toEqual({ include: true });
  expect(usage.body.stream_options).toEqual({ include_usage: true });
});

test("native search capability is independent of client function-tool capability", () => {
  for (const provider of ["openai", "anthropic"] as const) {
    const m = model(provider, {
      maxSearchCalls: 2,
      supports: {
        tools: false,
        vision: false,
        promptCache: false,
        reasoning: false,
        nativeSearch: true,
      },
    });
    const tool =
      provider === "openai"
        ? { type: "web_search" }
        : { type: "web_search_20250305", name: "web_search", max_uses: 1 };
    expect(prepare(m, { tools: [tool] }).searchCalls).toBeGreaterThan(0);
    const fn =
      provider === "openai"
        ? { type: "function", name: "read", parameters: { type: "object" } }
        : { name: "read", input_schema: { type: "object" } };
    expect(() => prepare(m, { tools: [tool, fn] })).toThrow("tools_not_supported");
  }
});

test("tool arguments and JSON results are opaque data, not media declarations", () => {
  const anthropic = model("anthropic");
  const prepared = prepareRequest(
    anthropic,
    {
      model: anthropic.upstreamModel,
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "browser_upload",
              input: { type: "file", video: "clip.mp4", file_id: "local-1", cache_control: 1 },
            },
          ],
        },
      ],
    },
    "user",
    "secret".repeat(8),
  );
  expect(reserveInput(anthropic, prepared).inputTokens).toBeGreaterThan(0);
  const google = model("google");
  const geminiBody = {
    contents: [
      {
        role: "model",
        parts: [{ functionCall: { name: "read_page", args: { type: "document", audio: true } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "read_page", response: { type: "video" } } }],
      },
    ],
  };
  expect(() => prepareRequest(google, geminiBody, "user", "secret".repeat(8))).not.toThrow();
  // Real media blocks are still inspected.
  expect(() =>
    reserveInput(
      anthropic,
      prepareRequest(
        anthropic,
        {
          model: anthropic.upstreamModel,
          max_tokens: 100,
          messages: [{ role: "user", content: [{ type: "document", source: { type: "url" } }] }],
        },
        "user",
        "secret".repeat(8),
      ),
    ),
  ).toThrow("unsupported_media");
});
