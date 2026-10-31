import { expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { createApiServer } from "../../src/apps/api/server";

const encoder = new TextEncoder();
const loopback = "127.0.0.1";
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, loopback, resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

test("real chunked POST keeps the socket peer and enforces the exact SystemOne body cap", async () => {
  const server = createApiServer(
    (peerAddress) => ({
      async fetch(request) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        return Response.json({
          peer: peerAddress(request),
          length: bytes.length,
          contentLength: request.headers.get("content-length"),
          transferEncoding: request.headers.get("transfer-encoding"),
        });
      },
    }),
    await freePort(),
    loopback,
  );
  const url = `http://${loopback}:${server.port}/v1/systemone`;
  const post = (size: number): Promise<{ status: number | undefined; body: unknown }> => {
    const payload = encoder.encode("x".repeat(size));
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "transfer-encoding": "chunked",
            "x-forwarded-for": "203.0.113.42",
          },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk: Buffer) => {
            text += chunk.toString();
          });
          response.once("end", () =>
            resolve({ status: response.statusCode, body: JSON.parse(text) }),
          );
          response.once("error", reject);
        },
      );
      request.once("error", reject);
      request.write(payload.subarray(0, 17));
      request.end(payload.subarray(17));
    });
  };
  try {
    const accepted = await post(81_920);
    expect(accepted.status).toBe(200);
    const value = accepted.body as Record<string, unknown>;
    expect(value.length).toBe(81_920);
    expect(value.contentLength).toBe("81920");
    expect(value.transferEncoding).toBeNull();
    expect(String(value.peer)).toContain(loopback);
    expect(value.peer).not.toBe("203.0.113.42");

    const rejected = await post(81_921);
    expect(rejected.status).toBe(413);
    expect(rejected.body).toEqual({ error: { code: "body_too_large" }, request_id: null });
  } finally {
    await server.stop(true);
  }
});

test("real HTTP SSE releases its first chunk before the producer finishes", async () => {
  let releaseFinal!: () => void;
  const finalGate = new Promise<void>((resolve) => {
    releaseFinal = resolve;
  });
  let finalReleased = false;
  const server = createApiServer(
    () => ({
      fetch() {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("data: first\n\n"));
              void finalGate.then(() => {
                controller.enqueue(encoder.encode("data: final\n\n"));
                controller.close();
              });
            },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } },
        );
      },
    }),
    await freePort(),
    loopback,
  );
  try {
    const response = await fetch(`http://${loopback}:${server.port}/openai/v1/responses`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing HTTP response stream");
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("data: first\n\n");
    expect(finalReleased).toBe(false);
    finalReleased = true;
    releaseFinal();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("data: final\n\n");
    expect((await reader.read()).done).toBe(true);
  } finally {
    releaseFinal();
    await server.stop(true);
  }
});

test("checkout survives the combined bounded state-read and create deadlines", async () => {
  const server = createApiServer(
    () => ({
      async fetch() {
        await Bun.sleep(16_000);
        return Response.json({ url: "https://sandbox.polar.sh/synthetic-checkout" });
      },
    }),
    await freePort(),
    loopback,
  );
  try {
    const response = await fetch(`http://${loopback}:${server.port}/v1/billing/checkout`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(25_000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://sandbox.polar.sh/synthetic-checkout" });
  } finally {
    await server.stop(true);
  }
}, 30_000);

test("avatar PUT permits its bounded multipart size without raising other account body limits", async () => {
  const server = createApiServer(
    () => ({
      async fetch(request) {
        return Response.json({ bytes: (await request.arrayBuffer()).byteLength });
      },
    }),
    await freePort(),
    loopback,
  );
  const send = (
    path: string,
    method: string,
    size: number,
  ): Promise<{ status: number | undefined; body: { bytes?: number; error?: { code: string } } }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        `http://${loopback}:${server.port}${path}`,
        {
          method,
          headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk.toString();
          });
          response.once("end", () =>
            resolve({ status: response.statusCode, body: JSON.parse(text) }),
          );
          response.once("error", reject);
        },
      );
      req.once("error", reject);
      req.write(Buffer.alloc(1024));
      req.end(Buffer.alloc(size - 1024));
    });
  try {
    const maximum = 2 * 1024 * 1024 + 16 * 1024;
    const accepted = await send("/v1/account/avatar", "PUT", maximum);
    expect(accepted.status).toBe(200);
    expect(accepted.body.bytes).toBe(maximum);
    const rejected = await send("/v1/account/avatar", "PUT", maximum + 1);
    expect(rejected.status).toBe(413);
    expect(rejected.body.error?.code).toBe("body_too_large");
    expect((await send("/v1/account", "PATCH", 1024 * 1024 + 1)).status).toBe(413);
    expect((await send("/v1/account/avatar", "POST", 1024 * 1024 + 1)).status).toBe(413);
  } finally {
    await server.stop(true);
  }
});

test("admission caps per client and keeps health probes answerable under saturation", async () => {
  const release: (() => void)[] = [];
  const server = createApiServer(
    () => ({
      async fetch(request) {
        if (new URL(request.url).pathname === "/slow")
          await new Promise<void>((resolve) => release.push(resolve));
        return Response.json({ ok: true });
      },
    }),
    await freePort(),
    loopback,
    undefined,
    {
      maxInFlight: 4,
      maxPerClient: 2,
      maxBufferedBytes: 1024,
      clientAddress: (request) => request.headers.get("x-test-client") ?? "unknown",
    },
  );
  const base = `http://${loopback}:${server.port}`;
  const slow = (client: string) => fetch(`${base}/slow`, { headers: { "x-test-client": client } });
  try {
    const held = [slow("a"), slow("a"), slow("b"), slow("b")];
    for (let i = 0; i < 100 && release.length < 4; i++) await Bun.sleep(5);
    expect(release).toHaveLength(4);
    const perClient = await fetch(`${base}/other`, { headers: { "x-test-client": "a" } });
    expect(perClient.status).toBe(503);
    expect(perClient.headers.get("Retry-After")).toBe("1");
    const global = await fetch(`${base}/other`, { headers: { "x-test-client": "c" } });
    expect(global.status).toBe(503);
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    expect((await fetch(`${base}/v1/client-config`)).status).toBe(200);
    const oversized = await fetch(`${base}/upload`, {
      method: "POST",
      headers: { "x-test-client": "d", "content-type": "application/json" },
      body: "x".repeat(2048),
    });
    expect(oversized.status).toBe(503);
    for (const done of release) done();
    expect((await Promise.all(held)).map((r) => r.status)).toEqual([200, 200, 200, 200]);
  } finally {
    for (const done of release) done();
    await server.stop(true);
  }
});
