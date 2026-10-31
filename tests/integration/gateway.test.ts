import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:net";
import { createApp } from "../../src/apps/api/app";
import { createApiServer } from "../../src/apps/api/server";
import { createCloudService } from "../../src/modules/ai/service";
import type { CloudTransport } from "../../src/modules/ai/transport";
import type { BillingProvider } from "../../src/modules/billing/provider";
import { recoverRequests } from "../../src/modules/credits/ledger";
import { createAuth } from "../../src/modules/identity/auth";
import { registerPolicy } from "../../src/modules/policy/policy";
import { createCloudAccount, testPolicy } from "../support/cloud-fixture";
import { testDatabase } from "../support/database";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
let live: ReturnType<typeof createApiServer>;
let auth: ReturnType<typeof createAuth>;
let token = "";
let userId = "";
const mail = new Map<string, string>();
const base = testPolicy();
const openai = {
  ...required(base.models[0]),
  contextWindow: 4096,
  maxOutput: 16,
  maxSearchCalls: 0,
  supports: { ...required(base.models[0]).supports, tools: true, nativeSearch: false },
};
const typesafe = {
  ...required(base.models[0]),
  id: "systemone",
  provider: "typesafe" as const,
  upstreamModel: "jev-1.13.0",
  displayName: "Synthetic SystemOne",
  contextWindow: 64000,
  maxOutput: 16,
  maxSearchCalls: 0,
  supports: {
    tools: false,
    vision: false,
    promptCache: false,
    reasoning: false,
    nativeSearch: false,
  },
  rates: { ...required(base.models[0]).rates, output: "0" },
};
const paidModel = {
  ...openai,
  id: "paid-model",
  upstreamModel: "synthetic-paid-model",
  displayName: "Synthetic paid model",
  description: "Available on the paid plan",
  tier: "frontier" as const,
  plans: ["pro"],
};
const policy = testPolicy({
  limits: { ...base.limits, unconfirmedRequestsPerUserDay: 100 },
  plans: [
    { ...required(base.plans[0]), allowanceUnits: "1000000" },
    { ...required(base.plans[0]), id: "pro", rank: 1, allowanceUnits: "1000000" },
  ],
  defaults: {
    free: { lead: "test-model", page: null, light: null, decision: null },
    pro: { lead: "paid-model", page: null, light: null, decision: null },
  },
  welcomeUnits: "100000",
  models: [openai, typesafe, paidModel],
});
let generateCalls = 0;
let lastPrepared: Parameters<CloudTransport["generate"]>[1] | null = null;
let generateFn: CloudTransport["generate"] = async () => openAIResponse();
const transport: CloudTransport = {
  available: (provider) => provider === "openai" || provider === "typesafe",
  count: async () => {
    throw new Error("Default gateway path must not call upstream token count");
  },
  generate: async (model, prepared, signal) => {
    generateCalls++;
    lastPrepared = prepared;
    return generateFn(model, prepared, signal);
  },
};
const provider: BillingProvider = {
  state: async () => null,
  checkout: async () => ({
    url: "https://sandbox.polar.sh/checkout/test",
    expiresAt: new Date(Date.now() + 60000),
  }),
  portal: async () => "https://sandbox.polar.sh/portal/test",
  deleteCustomer: async () => {},
  openCheckoutUntil: async () => null,
};
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing test value");
  return value;
}
async function sentCode(email: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = mail.get(email);
    if (code) return code;
    await Bun.sleep(10);
  }
  throw new Error("Verification code was not sent");
}
function openAIResponse(usage: unknown = { input_tokens: 4, output_tokens: 2 }) {
  return new Response(JSON.stringify({ status: "completed", usage, output: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json", "x-request-id": "synthetic-upstream" },
  });
}
function sse(parts: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "x-request-id": "synthetic-stream" },
    },
  );
}
function trailerAfter(wire: string, prefix: string): Record<string, unknown> {
  expect(wire.slice(0, prefix.length)).toBe(prefix);
  const trailer = /^\n*: zephium (\{[^\n]+\})\n\n$/.exec(wire.slice(prefix.length));
  expect(trailer).not.toBeNull();
  return JSON.parse(required(required(trailer)[1])) as Record<string, unknown>;
}
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  credential = token,
  headers: Record<string, string> = {},
) {
  return app.request(`http://localhost:3000${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}
async function realRequest(path: string, body: unknown, signal?: AbortSignal) {
  return fetch(`http://127.0.0.1:${live.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal,
  });
}
async function row(id: string) {
  return required(
    (
      await fixture.db
        .sql`SELECT state,charged::text,reserved::text,error_class,usage FROM cloud_request WHERE id=${id}`
    )[0],
  );
}
async function expireHold(id: string) {
  await fixture.db
    .sql`UPDATE cloud_request SET hold_until=now()-interval '1 second' WHERE id=${id}`;
  await recoverRequests(fixture.db);
}
const prompt = { model: "test-model", input: "synthetic prompt", max_output_tokens: 8 };

beforeAll(async () => {
  fixture = await testDatabase();
  await registerPolicy(fixture.db, policy);
  auth = createAuth(fixture.config, fixture.db, {
    sendOTP: async (email, otp) => {
      mail.set(email, otp);
    },
  });
  app = createApp(
    fixture.config,
    fixture.db,
    auth,
    provider,
    undefined,
    createCloudService(fixture.db, policy, transport, fixture.config.ABUSE_SECRET),
  );
  const email = `${crypto.randomUUID()}@example.test`;
  expect(
    (
      await request(
        "/api/auth/email-otp/send-verification-otp",
        "POST",
        { email, type: "sign-in" },
        "",
      )
    ).status,
  ).toBe(202);
  const login = await request(
    "/api/auth/sign-in/email-otp",
    "POST",
    { email, otp: await sentCode(email), device: "Gateway test device" },
    "",
  );
  expect(login.status).toBe(200);
  token = required(login.headers.get("set-auth-token"));
  userId = ((await login.json()) as { user: { id: string } }).user.id;
  live = createApiServer(() => app, await freePort(), "127.0.0.1");
}, 30000);
afterAll(async () => {
  await live?.stop(true);
  await fixture?.close();
});

test("cloud HTTP prefixes require a verified signed session and catalog eligible models", async () => {
  for (const path of [
    "/v1/models",
    "/v1/systemone",
    "/openai/v1/responses",
    "/anthropic/v1/messages",
    "/google/v1beta/models/test-model:generateContent",
    "/openrouter/v1/chat/completions",
    "/deepseek/v1/chat/completions",
  ]) {
    expect((await request(path, "GET", undefined, "")).status).toBe(401);
  }
  const catalog = await request("/v1/models");
  expect(catalog.status).toBe(200);
  expect(
    ((await catalog.json()) as { models: { id: string }[] }).models.map((model) => model.id),
  ).toEqual(["test-model", "systemone", "paid-model"]);
  const listed = (await (await request("/v1/models")).json()) as {
    defaults: Record<string, string | null>;
    models: {
      id: string;
      available: boolean;
      plan_min: string;
      tier: string;
      description: string;
      price: {
        unit_scale: number;
        credit_units: string;
        per_million_tokens: { input: string; output: string };
      };
      limits: { max_request_bytes: number; idle_timeout_ms: number; max_duration_ms: number };
    }[];
  };
  expect(listed.defaults).toMatchObject({ lead: "test-model", page: null, light: null });
  expect(listed.models.find((model) => model.id === "test-model")?.price).toMatchObject({
    unit_scale: 1000000,
    credit_units: "10000",
    per_million_tokens: { input: openai.rates.input, output: openai.rates.output },
  });
  expect(listed.models.find((model) => model.id === "paid-model")).toMatchObject({
    available: false,
    plan_min: "pro",
    tier: "frontier",
    description: "Available on the paid plan",
  });
  expect(listed.models.find((model) => model.id === "test-model")?.limits).toMatchObject({
    max_request_bytes: openai.maxRequestBytes,
    idle_timeout_ms: openai.idleTimeoutMs,
    max_duration_ms: policy.limits.requestTimeoutMs,
  });
  expect(
    (await request("/openai/v1/responses", "POST", { ...prompt, model: "paid-model" })).status,
  ).toBe(403);
  await fixture.db.sql`UPDATE auth_user SET email_verified=false WHERE id=${userId}`;
  expect((await request("/v1/models")).status).toBe(403);
  await fixture.db.sql`UPDATE auth_user SET email_verified=true WHERE id=${userId}`;
});

test("fragmented native SSE reaches the caller before final usage settles exactly once", async () => {
  const first =
    'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"hé 😀"}\r\n\r\n';
  const final =
    'event: response.completed\r\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\r\n\r\n';
  const encoder = new TextEncoder();
  let releaseFinal!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFinal = resolve;
  });
  let finalReleased = false;
  let producerCancelled = false;
  generateFn = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const firstBytes = encoder.encode(first);
          for (let i = 0; i < firstBytes.length; i++)
            controller.enqueue(firstBytes.subarray(i, i + 1));
          void gate.then(() => {
            if (producerCancelled) return;
            finalReleased = true;
            const finalBytes = encoder.encode(final);
            for (let i = 0; i < finalBytes.length; i += 7)
              controller.enqueue(finalBytes.subarray(i, i + 7));
            controller.close();
          });
        },
        cancel() {
          producerCancelled = true;
        },
      }),
      { headers: { "Content-Type": "text/event-stream", "x-request-id": "synthetic-stream" } },
    );
  try {
    const response = await realRequest("/openai/v1/responses", { ...prompt, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = required(response.body).getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    expect(new TextDecoder().decode(firstChunk.value)).toBe(first);
    expect(finalReleased).toBe(false);
    releaseFinal();
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    const id = required(response.headers.get("x-zephium-request-id"));
    expect(trailerAfter(rest, final)).toMatchObject({
      request_id: id,
      usage: "settled",
      charged: "10",
      credit_units: "10000",
    });
    expect(await row(id)).toMatchObject({ state: "settled", charged: "10" });
  } finally {
    releaseFinal();
  }
});

test("replayed Idempotency-Key never generates twice", async () => {
  generateFn = async () => openAIResponse();
  const key = crypto.randomUUID();
  const before = generateCalls;
  const first = await request("/openai/v1/responses", "POST", prompt, token, {
    "Idempotency-Key": key,
  });
  expect(first.status).toBe(200);
  expect(((await first.json()) as { status: string }).status).toBe("completed");
  const second = await request("/openai/v1/responses", "POST", prompt, token, {
    "Idempotency-Key": key,
  });
  expect(second.status).toBe(409);
  expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
    "request_already_recorded",
  );
  expect(generateCalls - before).toBe(1);
});

test("gateway strips caller identity and storage hints, rejects unpriced tools and output overrun", async () => {
  generateFn = async () => openAIResponse();
  const okay = await request("/openai/v1/responses", "POST", {
    ...prompt,
    user: "do-not-forward",
    metadata: { private: "do-not-forward" },
    store: true,
  });
  expect(okay.status).toBe(200);
  const body = required(lastPrepared).body;
  expect(body.user).toBeUndefined();
  expect(body.metadata).toBeUndefined();
  expect(body.store).toBe(false);
  expect(body.background).toBe(false);
  expect(body.safety_identifier).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (await request("/openai/v1/responses", "POST", { ...prompt, background: true })).status,
  ).toBe(400);
  expect(
    (await request("/openai/v1/responses", "POST", { ...prompt, previous_response_id: "stored" }))
      .status,
  ).toBe(400);
  const tool = await request("/openai/v1/responses", "POST", {
    ...prompt,
    tools: [{ type: "web_search" }],
  });
  expect(tool.status).toBe(400);
  expect(((await tool.json()) as { error: { code: string } }).error.code).toBe(
    "native_search_not_supported",
  );
  const tooLong = await request("/openai/v1/responses", "POST", {
    ...prompt,
    max_output_tokens: 17,
  });
  expect(tooLong.status).toBe(400);
  expect(((await tooLong.json()) as { error: { code: string } }).error.code).toBe(
    "output_limit_exceeded",
  );
});

test("terminal missing usage stays pending; truncated and failed streams append error trailers", async () => {
  const delta =
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n';
  const noUsage =
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":null}}\n\n';
  generateFn = async () => sse([delta, noUsage]);
  const missing = await realRequest("/openai/v1/responses", { ...prompt, stream: true });
  expect(missing.status).toBe(200);
  const missingWire = await missing.text();
  const missingId = required(missing.headers.get("x-zephium-request-id"));
  const pendingTrailer = trailerAfter(missingWire, delta + noUsage);
  expect(pendingTrailer).toEqual({ request_id: missingId, usage: "pending" });
  expect(pendingTrailer).not.toHaveProperty("credit_units");
  expect(pendingTrailer).not.toHaveProperty("charged");
  expect(await row(missingId)).toMatchObject({ state: "usage_unknown", charged: "0" });
  await expireHold(missingId);
  expect(await row(missingId)).toMatchObject({ state: "released", charged: "0" });

  const partial =
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lost"';
  generateFn = async () => sse([delta, partial]);
  const truncated = await realRequest("/openai/v1/responses", { ...prompt, stream: true });
  const truncatedWire = await truncated.text();
  const truncatedId = required(truncated.headers.get("x-zephium-request-id"));
  expect(trailerAfter(truncatedWire, delta)).toMatchObject({
    request_id: truncatedId,
    error: "stream_incomplete",
  });
  expect(truncatedWire).not.toContain("lost");
  expect(trailerAfter(truncatedWire, delta)).not.toHaveProperty("credit_units");
  expect(await row(truncatedId)).toMatchObject({ state: "usage_unknown", charged: "0" });
  await expireHold(truncatedId);

  generateFn = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('event: response.output_text.delta\ndata: {"delta":"hi"}\n\n'),
          );
          controller.error(new Error("provider stream failed"));
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  const broken = await realRequest("/openai/v1/responses", { ...prompt, stream: true });
  expect(broken.status).toBe(200);
  const brokenWire = await broken.text();
  expect(brokenWire).toMatch(
    /: zephium \{"request_id":"[^"]+","error":"stream_interrupted"\}\n\n$/,
  );
  const brokenId = required(broken.headers.get("x-zephium-request-id"));
  expect(await row(brokenId)).toMatchObject({ state: "usage_unknown", charged: "0" });
  await expireHold(brokenId);
  expect(await row(brokenId)).toMatchObject({ state: "released", charged: "0" });
});

test("caller cancellation aborts transport and charges only delivered usage", async () => {
  let cancelled = false;
  let transportSignal: AbortSignal | null = null;
  generateFn = async (_model, _prepared, signal) => {
    transportSignal = signal;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.output_text.delta\ndata: {"delta":"partial"}\n\n',
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const response = await request("/openai/v1/responses", "POST", { ...prompt, stream: true });
  expect(response.status).toBe(200);
  const reader = required(response.body).getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel("caller stopped reading");
  expect(cancelled).toBe(true);
  expect(required(transportSignal as AbortSignal | null).aborted).toBe(true);
  const id = required(response.headers.get("x-zephium-request-id"));
  // The seven delivered bytes ("partial") are billed as three output tokens plus input.
  let stopped = await row(id);
  for (let i = 0; i < 50 && stopped.state !== "settled"; i++) {
    await Bun.sleep(10);
    stopped = await row(id);
  }
  expect(stopped).toMatchObject({ state: "settled", error_class: "client_disconnected" });
  expect(stopped.usage).toMatchObject({ output: 3, reasoning: 0, searchCalls: 0 });
  expect(BigInt(stopped.charged)).toBeGreaterThan(0n);
  expect(BigInt(stopped.charged)).toBeLessThanOrEqual(BigInt(stopped.reserved));
});

test("repeated Stop does not exhaust the unconfirmed-usage allowance", async () => {
  generateFn = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.output_text.delta\ndata: {"delta":"partial"}\n\n',
            ),
          );
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  for (let i = 0; i < 5; i++) {
    const response = await request("/openai/v1/responses", "POST", { ...prompt, stream: true });
    expect(response.status).toBe(200);
    const reader = required(response.body).getReader();
    await reader.read();
    await reader.cancel("caller stopped reading");
    const id = required(response.headers.get("x-zephium-request-id"));
    for (let wait = 0; wait < 50 && (await row(id)).state !== "settled"; wait++)
      await Bun.sleep(10);
    expect((await row(id)).state).toBe("settled");
  }
});

test("provider 429 returns safe Retry-After and releases all held credit", async () => {
  generateFn = async () =>
    new Response("secret upstream body", { status: 429, headers: { "Retry-After": "120" } });
  const response = await request("/openai/v1/responses", "POST", prompt);
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("120");
  expect(await response.text()).not.toContain("secret upstream body");
  const id = required(response.headers.get("x-zephium-request-id"));
  expect(await row(id)).toMatchObject({ state: "released", charged: "0" });
});

test("SystemOne keeps typed JSON and bills only input tokens", async () => {
  const payload = {
    model: "jev-1.13.0",
    answers: [{ question_id: "q1", value: true }],
    usage: { input_tokens: 4, output_tokens: 0 },
  };
  generateFn = async () =>
    new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  const response = await request("/v1/systemone", "POST", {
    model: "systemone",
    state: { synthetic: true },
    questions: { q1: "test" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(payload);
  expect(response.headers.get("X-Zephium-Usage")).toBe("settled");
  const id = required(response.headers.get("x-zephium-request-id"));
  expect(await row(id)).toMatchObject({ state: "settled", charged: "4" });
});

test("upstream bytes reset idle timeout but the model duration remains a cap", async () => {
  const idleModel = {
    ...openai,
    id: "idle-model",
    upstreamModel: "synthetic-idle",
    // Leave room for database admission so this case isolates the idle deadline.
    idleTimeoutMs: 500,
    maxDurationMs: 10000,
  };
  const cappedModel = {
    ...openai,
    id: "capped-model",
    upstreamModel: "synthetic-capped",
    idleTimeoutMs: 2000,
    maxDurationMs: 3000,
  };
  const timedPolicy = testPolicy({
    limits: policy.limits,
    plans: policy.plans,
    welcomeUnits: "100000",
    models: [idleModel, cappedModel],
    defaults: { free: { lead: "idle-model", page: null, light: null, decision: null } },
  });
  await registerPolicy(fixture.db, timedPolicy);
  const timedApp = createApp(
    fixture.config,
    fixture.db,
    auth,
    provider,
    undefined,
    createCloudService(fixture.db, timedPolicy, transport, fixture.config.ABUSE_SECRET),
  );
  const timedServer = createApiServer(() => timedApp, await freePort(), "127.0.0.1");
  const send = (modelId: string) =>
    fetch(`http://127.0.0.1:${timedServer.port}/openai/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: modelId,
        input: "timed stream",
        max_output_tokens: 8,
        stream: true,
      }),
      signal: AbortSignal.timeout(15000),
    });
  const delta =
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"tick"}\n\n';
  const ping = ": provider ping\n\n";
  const terminal =
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n\n';
  const periodic = (finishAfterMs?: number) => {
    let ticker: ReturnType<typeof setInterval> | undefined;
    let final: ReturnType<typeof setTimeout> | undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encode = new TextEncoder();
          controller.enqueue(encode.encode(delta));
          ticker = setInterval(() => controller.enqueue(encode.encode(ping)), 50);
          final =
            finishAfterMs === undefined
              ? undefined
              : setTimeout(() => {
                  clearInterval(ticker);
                  controller.enqueue(encode.encode(terminal));
                  controller.close();
                }, finishAfterMs);
        },
        cancel() {
          clearInterval(ticker);
          clearTimeout(final);
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  try {
    // Several idle windows elapse while upstream heartbeats keep the stream alive.
    generateFn = async () => periodic(1100);
    const idle = await send("idle-model");
    expect(idle.status).toBe(200);
    const idleWire = await idle.text();
    const idleId = required(idle.headers.get("x-zephium-request-id"));
    expect((idleWire.match(/: provider ping\n\n/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(idleWire).toContain(terminal);
    expect(idleWire).toMatch(
      /: zephium \{"request_id":"[^"]+","usage":"settled","charged":"10","credit_units":"10000"\}\n\n$/,
    );
    expect(await row(idleId)).toMatchObject({ state: "settled", charged: "10" });

    generateFn = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(delta));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    const stalled = await send("idle-model");
    expect(stalled.status).toBe(200);
    const stalledWire = await stalled.text();
    const stalledId = required(stalled.headers.get("x-zephium-request-id"));
    expect(stalledWire).toMatch(
      /: zephium \{"request_id":"[^"]+","error":"provider_idle_timeout"\}\n\n$/,
    );
    expect(await row(stalledId)).toMatchObject({ state: "usage_unknown", charged: "0" });
    await expireHold(stalledId);

    generateFn = async () => periodic();
    const capped = await send("capped-model");
    expect(capped.status).toBe(200);
    const cappedWire = await capped.text();
    const cappedId = required(capped.headers.get("x-zephium-request-id"));
    expect((cappedWire.match(/: provider ping\n\n/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(cappedWire).toMatch(
      /: zephium \{"request_id":"[^"]+","error":"provider_timeout"\}\n\n$/,
    );
    expect(await row(cappedId)).toMatchObject({ state: "usage_unknown", charged: "0" });
    await expireHold(cappedId);
  } finally {
    await timedServer.stop(true);
  }
});

test("revoked bearer session cannot access the gateway", async () => {
  const before = generateCalls;
  const session = required(
    (await fixture.db.sql`SELECT id FROM auth_session WHERE user_id=${userId}`)[0],
  );
  await fixture.db.sql`DELETE FROM auth_session WHERE id=${session.id}`;
  expect((await request("/v1/models")).status).toBe(401);
  expect((await request("/openai/v1/responses", "POST", prompt)).status).toBe(401);
  expect(generateCalls).toBe(before);
});

test("shutdown aborts active streams with recoverable accounting and stops new admission", async () => {
  const isolated = await testDatabase();
  try {
    const template = testPolicy();
    const first = required(template.plans[0]);
    const p = testPolicy({ plans: [{ ...first, allowanceUnits: "1000000" }] });
    await registerPolicy(isolated.db, p);
    const owner = await createCloudAccount(isolated.db);
    let cancelled = false;
    const service = createCloudService(
      isolated.db,
      p,
      {
        available: () => true,
        count: async () => {
          throw new Error("Unexpected token count call");
        },
        generate: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(
                  new TextEncoder().encode(
                    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"first"}\n\n',
                  ),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      },
      isolated.config.ABUSE_SECRET,
    );
    const call = () =>
      new Request("http://localhost/openai/v1/responses", {
        method: "POST",
        body: JSON.stringify({
          model: "test-model",
          input: "hello",
          max_output_tokens: 8,
          stream: true,
        }),
      });
    const response = await service.generate("openai", call(), owner);
    expect(response.status).toBe(200);
    const reader = required(response.body).getReader();
    expect((await reader.read()).done).toBe(false);
    await service.shutdown();
    let tail = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      tail += new TextDecoder().decode(part.value);
    }
    expect(tail).toContain('"error":"server_shutdown"');
    expect(cancelled).toBe(true);
    const [receipt] = await isolated.db
      .sql`SELECT state,charged::text FROM cloud_request WHERE id=${required(response.headers.get("X-Zephium-Request-Id"))}`;
    expect(receipt).toMatchObject({ state: "usage_unknown", charged: "0" });
    await expect(service.generate("openai", call(), owner)).rejects.toMatchObject({
      code: "server_shutdown",
      status: 503,
    });
  } finally {
    await isolated.close();
  }
});
