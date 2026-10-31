import { createHash } from "node:crypto";
import type { Database } from "../../platform/db";
import { AppError, errorResponse, operationalEvent } from "../../platform/errors";
import {
  accountContext,
  creditUnits,
  emptyUsage,
  holdCost,
  markDispatched,
  openRequest,
  releaseRequest,
  requestReceipt,
  reserveRequest,
  settleRequest,
  unknownRequest,
} from "../credits";
import { type CloudPolicy, findModel, type ProviderName, requestDuration } from "../policy";
import { audioDeadlineMs, audioResponseBytes, createAudioTranscriber } from "./audio";
import { customerInputTokens } from "./image-reservation";
import { object, prepareRequest } from "./protocol";
import { reserveInput } from "./reservation";
import { SseFrames } from "./sse";
import { boundedJSON, type CloudTransport } from "./transport";
import { extractUsage, UsageObserver } from "./usage";

const encoder = new TextEncoder();
function retryAfter(value: string | null): number {
  if (value === null) return 1;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(86400, seconds) : 1;
}
export function createCloudService(
  db: Database,
  policy: CloudPolicy,
  transport: CloudTransport,
  secret: string,
) {
  let active = 0;
  let stopping = false;
  const shutdownHooks = new Set<() => Promise<void>>();
  const transcribe = createAudioTranscriber(db, policy, transport, (stop) => {
    shutdownHooks.add(stop);
    return () => {
      shutdownHooks.delete(stop);
    };
  });
  return {
    policy,
    async transcribe(
      request: Request,
      identity: { userId: string; sessionId: string },
    ): Promise<Response> {
      if (stopping) throw new AppError("server_shutdown", 503);
      if (!policy.enabled) throw new AppError("cloud_disabled", 503);
      if (active >= policy.limits.globalConcurrent)
        throw new AppError("concurrency_limited", 429, 1);
      active++;
      try {
        return await transcribe(request, identity);
      } finally {
        active--;
      }
    },
    async shutdown() {
      stopping = true;
      await Promise.allSettled([...shutdownHooks].map((stop) => stop()));
    },
    async catalog(userId: string) {
      const emptyDefaults = {
        lead: null,
        page: null,
        light: null,
        decision: null,
        transcribe: null,
      };
      if (!policy.enabled)
        return {
          schema_version: 1,
          policy_revision: policy.revision,
          cloud_enabled: false,
          defaults: emptyDefaults,
          models: [],
        };
      const plan = await db.sql.begin(
        async (tx) => (await accountContext(tx, userId, policy)).plan.id,
      );
      const models = policy.models
        .filter((m) => m.enabled && transport.available(m.provider))
        .map((m) => ({
          id: m.id,
          provider: m.provider,
          upstream_model: m.upstreamModel,
          display_name: m.displayName,
          description: m.description,
          tier: m.tier,
          available: m.plans.includes(plan),
          roles: m.roles,
          recommended: m.recommendedRoles.length > 0,
          recommended_roles: m.recommendedRoles,
          context_window: m.contextWindow,
          max_output: m.maxOutput,
          limits: {
            max_request_bytes: m.maxRequestBytes,
            max_search_calls: m.maxSearchCalls,
            idle_timeout_ms: m.idleTimeoutMs,
            max_duration_ms: m.roles.includes("transcribe")
              ? Math.min(audioDeadlineMs, requestDuration(policy, m))
              : requestDuration(policy, m),
            ...(m.roles.includes("transcribe")
              ? { max_audio_duration_ms: 240000, max_response_bytes: audioResponseBytes }
              : {}),
          },
          supports: {
            tools: m.supports.tools,
            vision: m.supports.vision,
            prompt_cache: m.supports.promptCache,
            reasoning: m.supports.reasoning,
            native_search: m.supports.nativeSearch,
          },
          price: {
            unit_scale: 1000000,
            credit_units: creditUnits,
            per_million_tokens: {
              input: m.rates.input,
              cached_input: m.rates.cachedInput,
              cache_write_5m: m.rates.cacheWrite5m,
              cache_write_1h: m.rates.cacheWrite1h,
              output: m.rates.output,
              ...(m.rates.audioInput !== undefined ? { audio_input: m.rates.audioInput } : {}),
            },
            ...(m.rates.longContext
              ? {
                  long_context: {
                    input_tokens_above: m.rates.longContext.inputTokensAbove,
                    per_million_tokens: {
                      input: m.rates.longContext.rates.input,
                      cached_input: m.rates.longContext.rates.cachedInput,
                      cache_write_5m: m.rates.longContext.rates.cacheWrite5m,
                      cache_write_1h: m.rates.longContext.rates.cacheWrite1h,
                      output: m.rates.longContext.rates.output,
                    },
                    per_search_call: m.rates.longContext.rates.searchCall,
                  },
                }
              : {}),
            per_search_call: m.rates.searchCall,
            ...(m.rates.audioMinute !== undefined ? { per_audio_minute: m.rates.audioMinute } : {}),
          },
          plan_min: policy.plans
            .filter((p) => m.plans.includes(p.id))
            .sort((a, b) => a.rank - b.rank)[0]?.id,
          allowed_plans: m.plans,
        }));
      const configured = policy.defaults[plan];
      const defaults = Object.fromEntries(
        Object.keys(emptyDefaults).map((role) => {
          const id = configured?.[role as keyof typeof configured];
          return [role, id && models.some((m) => m.id === id && m.available) ? id : null];
        }),
      );
      return {
        schema_version: 1,
        policy_revision: policy.revision,
        cloud_enabled: true,
        defaults,
        models,
      };
    },
    async generate(
      provider: ProviderName,
      request: Request,
      identity: { userId: string; sessionId: string },
      pathModel?: string,
    ): Promise<Response> {
      if (stopping) throw new AppError("server_shutdown", 503);
      if (!policy.enabled) throw new AppError("cloud_disabled", 503);
      if (active >= policy.limits.globalConcurrent)
        throw new AppError("concurrency_limited", 429, 1);
      active++;
      const abort = new AbortController();
      let requestId: string | null = null,
        dispatched = false,
        handedOff = false,
        closed = false,
        ending = false;
      let overall: ReturnType<typeof setTimeout> | undefined,
        idle: ReturnType<typeof setTimeout> | undefined;
      let idleMs = 90000;
      let estimatedInput = 0;
      let reason: string | null = null;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let observer: UsageObserver | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let finishStream: ((error?: string) => Promise<void>) | undefined;
      let completion: Promise<void> | undefined;
      const shutdown = async () => {
        interrupt("server_shutdown");
        await completion;
      };
      shutdownHooks.add(shutdown);
      const clearTimers = () => {
        clearTimeout(overall);
        clearTimeout(idle);
      };
      const close = () => {
        if (!closed) {
          closed = true;
          active--;
          shutdownHooks.delete(shutdown);
          clearTimers();
          request.signal.removeEventListener("abort", cancel);
        }
      };
      const failAccounting = async (code: string) => {
        if (!requestId) return;
        try {
          // A customer who stops after dispatch pays for the input the provider processed.
          if (dispatched && code === "client_disconnected")
            await settleRequest(
              db,
              requestId,
              identity.userId,
              { ...emptyUsage(), input: estimatedInput },
              499,
              null,
              { errorClass: code },
            );
          else if (dispatched) await unknownRequest(db, requestId, identity.userId, code);
          else await releaseRequest(db, requestId, identity.userId, code);
        } catch {
          operationalEvent("cloud_accounting_recovery_required");
        }
      };
      const interrupt = (code: string) => {
        if (ending || closed) return;
        reason = code;
        abort.abort();
        void reader?.cancel().catch(() => {});
        if (handedOff) void finishStream?.(code);
      };
      const cancel = () => interrupt("client_disconnected");
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => interrupt("provider_idle_timeout"), idleMs);
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      try {
        if (request.signal.aborted) throw new AppError("request_cancelled", 408);
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > (provider === "typesafe" ? 81920 : 8 * 1024 * 1024))
          throw new AppError("body_too_large", 413);
        let input: Record<string, unknown>;
        try {
          input = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        } catch {
          throw new AppError("invalid_request");
        }
        const requested = pathModel ?? input.model;
        if (typeof requested !== "string") throw new AppError("model_required");
        const model = findModel(policy, provider, requested);
        if (model.roles.includes("transcribe")) throw new AppError("model_not_allowed", 403);
        if (bytes.byteLength > model.maxRequestBytes) throw new AppError("body_too_large", 413);
        if (!transport.available(provider)) throw new AppError("provider_not_configured", 503);
        const prepared = prepareRequest(model, input, identity.userId, secret);
        const duration = requestDuration(policy, model);
        idleMs = Math.min(model.idleTimeoutMs, duration);
        overall = setTimeout(() => interrupt("provider_timeout"), duration);
        const rawKey = request.headers.get("Idempotency-Key") ?? crypto.randomUUID();
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawKey)
        )
          throw new AppError("invalid_idempotency_key");
        const key = createHash("sha256")
          .update(`${identity.userId}:${rawKey.toLowerCase()}`)
          .digest("hex");
        // Local estimates reserve credit; only provider-reported usage determines the debit.
        // Pure validation runs before admission so rejected bodies never take locks or rows.
        const bound = reserveInput(model, prepared);
        const opened = await openRequest(
          db,
          policy,
          model,
          identity.userId,
          identity.sessionId,
          key,
          provider === "typesafe" ? "/v1/systemone" : provider,
        );
        requestId = opened.id;
        const customerInput = await customerInputTokens(
          model,
          prepared,
          bound,
          transport,
          abort.signal,
        );
        estimatedInput = customerInput;
        const outputBound =
          provider === "google"
            ? Math.min(model.contextWindow, prepared.outputLimit * 2)
            : prepared.outputLimit;
        const reserved = holdCost(
          customerInput + bound.searchInputTokens,
          outputBound,
          prepared.searchCalls,
          model.rates,
        );
        await reserveRequest(
          db,
          policy,
          model,
          requestId,
          identity.userId,
          identity.sessionId,
          reserved,
          // The provider rate bucket uses the refined count; exposure keeps the conservative bound.
          customerInput,
          model.costRates
            ? holdCost(
                bound.inputTokens + bound.searchInputTokens,
                outputBound,
                prepared.searchCalls,
                model.costRates,
              )
            : undefined,
        );
        if (abort.signal.aborted) throw new AppError(reason ?? "request_cancelled", 408);
        await markDispatched(db, requestId, identity.userId, identity.sessionId);
        dispatched = true;
        touch();
        const upstream = await transport.generate(model, prepared, abort.signal);
        touch();
        const headers = new Headers({
          "Cache-Control": "no-store",
          "X-Zephium-Request-Id": requestId,
          "X-Zephium-Policy-Revision": String(policy.revision),
        });
        if (!upstream.ok) {
          clearTimers();
          await upstream.body?.cancel();
          if ([400, 401, 403, 404, 413, 422, 429].includes(upstream.status))
            await releaseRequest(db, requestId, identity.userId, "provider_rejected");
          else await unknownRequest(db, requestId, identity.userId, "provider_failed");
          const status =
            upstream.status === 429
              ? 429
              : [400, 413, 422].includes(upstream.status)
                ? upstream.status
                : 502;
          return errorResponse(
            new AppError(
              status === 429
                ? "provider_rate_limited"
                : status < 500
                  ? "provider_rejected_request"
                  : "provider_request_failed",
              status,
              status === 429 ? retryAfter(upstream.headers.get("retry-after")) : undefined,
            ),
            requestId,
            headers,
          );
        }
        const upstreamId =
          upstream.headers.get("x-request-id") ?? upstream.headers.get("request-id");
        if (!prepared.stream) {
          const response = await boundedJSON(
            upstream,
            provider === "typesafe" ? 1024 * 1024 : 8 * 1024 * 1024,
            touch,
          );
          clearTimers();
          if (provider === "typesafe" && object(response.value).model !== model.upstreamModel)
            throw new AppError("provider_model_mismatch", 502);
          const usage = extractUsage(
            provider,
            response.value,
            prepared.searchCalls > 0,
            prepared.cacheWriteHint,
          );
          if (usage)
            await settleRequest(db, requestId, identity.userId, usage, upstream.status, upstreamId);
          else await unknownRequest(db, requestId, identity.userId, "usage_missing");
          headers.set("Content-Type", "application/json");
          headers.set("Content-Length", String(response.bytes.length));
          headers.set("X-Zephium-Usage", usage ? "settled" : "pending");
          return new Response(new Uint8Array(response.bytes), { status: upstream.status, headers });
        }
        if (
          !upstream.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ||
          !upstream.body
        )
          throw new AppError("invalid_provider_stream", 502);
        reader = upstream.body.getReader();
        observer = new UsageObserver(provider, prepared.searchCalls > 0, prepared.cacheWriteHint);
        const frames = new SseFrames();
        let totalBytes = 0;
        const id = requestId;
        finishStream = (error?: string) =>
          (completion ??= (async () => {
            ending = true;
            clearTimers();
            try {
              const usage = observer?.finish();
              // Stop is ordinary: charge what was delivered instead of refunding it in full
              // and counting it against the customer's unconfirmed-usage allowance.
              const stopped =
                !usage && error === "client_disconnected"
                  ? observer?.interrupted(estimatedInput)
                  : null;
              if (usage)
                await settleRequest(db, id, identity.userId, usage, upstream.status, upstreamId);
              else if (stopped)
                await settleRequest(db, id, identity.userId, stopped, upstream.status, upstreamId, {
                  errorClass: "client_disconnected",
                });
              else await unknownRequest(db, id, identity.userId, error ?? "usage_missing");
              const receipt = await requestReceipt(db, identity.userId, id);
              const trailer = error
                ? { request_id: id, error }
                : {
                    request_id: id,
                    usage: receipt?.state === "settled" ? "settled" : "pending",
                    ...(receipt?.state === "settled"
                      ? { charged: receipt.charged, credit_units: creditUnits }
                      : {}),
                  };
              if (error !== "client_disconnected")
                controller?.enqueue(encoder.encode(`\n\n: zephium ${JSON.stringify(trailer)}\n\n`));
            } catch {
              await failAccounting(error ?? "accounting_pending");
              try {
                if (error !== "client_disconnected")
                  controller?.enqueue(
                    encoder.encode(
                      `\n\n: zephium ${JSON.stringify({ request_id: id, ...(error ? { error } : { usage: "pending" }) })}\n\n`,
                    ),
                  );
              } catch {}
            } finally {
              try {
                controller?.close();
              } catch {}
              close();
            }
          })());
        headers.set("Content-Type", "text/event-stream");
        headers.set("X-Accel-Buffering", "no");
        const stream = new ReadableStream<Uint8Array>(
          {
            start(c) {
              controller = c;
            },
            async pull(c) {
              if (ending || closed) return;
              try {
                for (;;) {
                  const next = await reader?.read();
                  if (ending || closed) return;
                  if (!next || next.done) {
                    const end = frames.finish();
                    if (end.tail) {
                      observer?.push(end.tail);
                      c.enqueue(end.tail);
                    }
                    await finishStream?.(
                      reason ??
                        (end.truncated || !observer?.isComplete()
                          ? "stream_incomplete"
                          : undefined),
                    );
                    return;
                  }
                  touch();
                  totalBytes += next.value.byteLength;
                  if (totalBytes > 32 * 1024 * 1024)
                    throw new AppError("provider_response_limit", 502);
                  const complete = frames.push(next.value);
                  if (complete) {
                    observer?.push(complete);
                    c.enqueue(complete);
                    return;
                  }
                }
              } catch (error) {
                abort.abort();
                void reader?.cancel().catch(() => {});
                await finishStream?.(
                  reason ?? (error instanceof AppError ? error.code : "stream_interrupted"),
                );
              }
            },
            async cancel() {
              abort.abort();
              void reader?.cancel().catch(() => {});
              await finishStream?.("client_disconnected");
            },
          },
          { highWaterMark: 1 },
        );
        handedOff = true;
        if (abort.signal.aborted) void finishStream(reason ?? "request_cancelled");
        return new Response(stream, { status: upstream.status, headers });
      } catch (error) {
        clearTimers();
        abort.abort();
        const safe = reason
          ? new AppError(reason, reason === "client_disconnected" ? 408 : 504)
          : error instanceof AppError
            ? error
            : new AppError("provider_unavailable", 502);
        await failAccounting(safe.code);
        return errorResponse(safe, requestId);
      } finally {
        if (!handedOff) close();
      }
    },
  };
}
export type CloudService = ReturnType<typeof createCloudService>;
