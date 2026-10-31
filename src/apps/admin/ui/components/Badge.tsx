import type { ComponentChildren } from "preact";

export type Tone = "neutral" | "accent" | "ok" | "warn" | "critical";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ComponentChildren;
}) {
  return <span class={`badge badge-${tone}`}>{children}</span>;
}

export function lifecycleTone(lifecycle: string): Tone {
  return lifecycle === "deleting" ? "warn" : lifecycle === "active" ? "ok" : "neutral";
}

export function subscriptionTone(status: string | null): Tone {
  if (status === "active") return "ok";
  if (status === "past_due" || status === "unpaid" || status === "incomplete") return "warn";
  return "neutral";
}

/** Plan change lifecycle: queued/executing are in flight, uncertain needs a look, failed is final. */
export function planChangeTone(state: string): Tone {
  if (state === "applied" || state === "scheduled") return "ok";
  if (state === "failed") return "critical";
  if (state === "uncertain") return "warn";
  if (state === "queued" || state === "executing") return "accent";
  return "neutral";
}
