import { avatarPath, avatarRequestBytes } from "../../modules/identity";
import { AppError, errorFields, errorResponse, operationalEvent } from "../../platform/errors";
import { markIncomingStart, readIncomingBody } from "../../platform/incoming-body";
import { decorateWaitlistResponse, isWaitlistPath } from "./waitlist-cors";

type App = { fetch(request: Request): Response | Promise<Response> };

export type ServerLimits = {
  /** Requests admitted at once, from receipt until response headers. */
  maxInFlight: number;
  /** Per client network, so one caller cannot occupy the shared capacity. */
  maxPerClient: number;
  /** Request bytes buffered at once across all uploads. */
  maxBufferedBytes: number;
  /** Trusted client address for per-client admission; defaults to the socket peer. */
  clientAddress?: (request: Request, peer: string) => string;
};
const defaultLimits: ServerLimits = {
  maxInFlight: 128,
  maxPerClient: 24,
  maxBufferedBytes: 96 * 1024 * 1024,
};
const generationPrefixes = ["/openai/", "/anthropic/", "/google/", "/openrouter/", "/deepseek/"];
// Cheap, body-less probes stay answerable while customer traffic is saturated.
const controlPaths = new Set(["/health/live", "/health/ready", "/v1/client-config"]);

function bodyLimit(method: string, path: string, generation: boolean): number {
  if (isWaitlistPath(path)) return 2048;
  if (path === "/v1/systemone") return 81920;
  if (generation) return 8 * 1024 * 1024;
  if (method === "PUT" && path === avatarPath) return avatarRequestBytes;
  return 1024 * 1024;
}

/** Real HTTP boundary shared by production and native smoke tests. */
export function createApiServer(
  build: (peerAddress: (request: Request) => string) => App,
  port: number,
  hostname = "0.0.0.0",
  waitlistOrigin?: string,
  limits: ServerLimits = defaultLimits,
) {
  const peers = new WeakMap<Request, string>();
  const perClient = new Map<string, number>();
  let incoming = 0;
  let buffered = 0;
  let server: Bun.Server<undefined>;
  const app = build(
    (request) => peers.get(request) ?? server.requestIP(request)?.address ?? "unknown",
  );
  const busy = (request: Request) =>
    decorateWaitlistResponse(
      request,
      errorResponse(new AppError("server_busy", 503, 1)),
      waitlistOrigin,
    );
  server = Bun.serve<undefined>({
    port,
    hostname,
    maxRequestBodySize: 8 * 1024 * 1024,
    idleTimeout: 15,
    async fetch(request, owner) {
      const path = new URL(request.url).pathname;
      const peer = owner.requestIP(request)?.address ?? "unknown";
      if (controlPaths.has(path) && (request.method === "GET" || request.method === "HEAD")) {
        peers.set(request, peer);
        try {
          return await app.fetch(request);
        } finally {
          peers.delete(request);
        }
      }
      const client = limits.clientAddress?.(request, peer) ?? peer;
      const held = perClient.get(client) ?? 0;
      if (incoming >= limits.maxInFlight || held >= limits.maxPerClient) return busy(request);
      incoming++;
      perClient.set(client, held + 1);
      const startedAt = performance.now();
      let forwarded = request;
      let reservedBytes = 0;
      try {
        const generation =
          request.method === "POST" &&
          (generationPrefixes.some((p) => path.startsWith(p)) || path === "/v1/systemone");
        if (request.body) {
          const maximum = bodyLimit(request.method, path, generation);
          const length = request.headers.get("content-length");
          const declared = length !== null && /^\d{1,10}$/.test(length) ? Number(length) : null;
          // Reserve the declared size (or the route maximum for chunked uploads) up front,
          // so concurrent uploads cannot exceed the process memory budget.
          reservedBytes = declared ?? maximum;
          if (reservedBytes > maximum) throw new AppError("body_too_large", 413);
          if (buffered + reservedBytes > limits.maxBufferedBytes) {
            reservedBytes = 0;
            return busy(request);
          }
          buffered += reservedBytes;
          const bytes = await readIncomingBody(
            request,
            Math.min(maximum, reservedBytes),
            isWaitlistPath(path) ? 5000 : 15000,
          );
          const headers = new Headers(request.headers);
          headers.delete("transfer-encoding");
          headers.set("content-length", String(bytes.length));
          forwarded = new Request(request, { body: new Uint8Array(bytes), headers });
        }
        // The peer belongs to the socket, not a caller-controlled header; preserve it across body normalization.
        peers.set(forwarded, peer);
        markIncomingStart(forwarded, startedAt);
        if (generation) owner.timeout(request, 0);
        // Subscription checkout performs two separately bounded provider operations
        // (current-state read, then creation). Keep a finite transport deadline.
        else if (request.method === "POST" && path === "/v1/billing/checkout")
          owner.timeout(request, 30);
        return decorateWaitlistResponse(request, await app.fetch(forwarded), waitlistOrigin);
      } catch (error) {
        if (!(error instanceof AppError))
          operationalEvent("http_request_failed", {
            method: request.method,
            ...errorFields(error),
          });
        return decorateWaitlistResponse(
          request,
          errorResponse(error instanceof AppError ? error : new AppError("unavailable", 503)),
          waitlistOrigin,
        );
      } finally {
        peers.delete(forwarded);
        buffered -= reservedBytes;
        incoming--;
        const remaining = (perClient.get(client) ?? 1) - 1;
        if (remaining > 0) perClient.set(client, remaining);
        else perClient.delete(client);
      }
    },
  });
  return server;
}
