export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly retryAfter?: number,
  ) {
    super(code);
  }
}
/** Only stable codes and real admitted request IDs belong in public errors. */
export function errorBody(error: AppError, requestId: string | null = null) {
  return {
    error: {
      code: error.code,
      ...(error.retryAfter === undefined
        ? {}
        : { retry_after: Math.max(1, Math.ceil(error.retryAfter)) }),
    },
    request_id: requestId,
  };
}
export function errorResponse(
  error: AppError,
  requestId: string | null = null,
  headers = new Headers(),
) {
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  if (error.retryAfter !== undefined)
    headers.set("Retry-After", String(Math.max(1, Math.ceil(error.retryAfter))));
  if (requestId) headers.set("X-Zephium-Request-Id", requestId);
  return new Response(JSON.stringify(errorBody(error, requestId)), {
    status: error.status,
    headers,
  });
}
type EventFields = Record<string, string | number | boolean | string[] | undefined>;

/**
 * Diagnostic shape of an unexpected error without its message: messages from
 * providers, drivers and parsers can echo credentials, emails or request input.
 * Class, SQLSTATE-style code and stack locations are enough to find the fault.
 */
export function errorFields(error: unknown): EventFields {
  if (!(error instanceof Error)) return { error_type: typeof error };
  const code = (error as { code?: unknown }).code;
  return {
    error_type: error.constructor?.name || error.name,
    error_code: typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : undefined,
    frames: (error.stack ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("at "))
      .slice(0, 6),
  };
}

/** Never serialize provider errors: they may contain credentials or customer data. */
export function operationalEvent(event: string, fields: EventFields = {}): void {
  console.error(JSON.stringify({ event, time: new Date().toISOString(), ...fields }));
}
