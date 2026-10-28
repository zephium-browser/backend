import { randomUUID } from "node:crypto";
import type { EmailApiOptions } from "resend";
import { retryAfterSeconds } from "./abuse";
import type { Config } from "./config";
import { AppError } from "./errors";

/** Bounded delivery only; callers own admission, templates and their concurrency limit. */
export async function deliverEmail(
  config: Pick<Config, "RESEND_API_KEY" | "EMAIL_FROM">,
  message: Omit<EmailApiOptions, "from">,
  transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  if (!config.RESEND_API_KEY) throw new AppError("email_unavailable", 503);
  const response = await transport("https://api.resend.com/emails", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({ ...message, from: config.EMAIL_FROM }),
  });
  const retry = retryAfterSeconds(response.headers.get("Retry-After"));
  await response.body?.cancel();
  if (!response.ok) throw new AppError("email_unavailable", 503, retry ?? 1);
}
