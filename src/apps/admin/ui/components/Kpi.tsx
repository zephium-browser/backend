import type { ComponentChildren } from "preact";
import type { Tone } from "./Badge";

export function Kpi({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ComponentChildren;
  note?: ComponentChildren;
  tone?: Tone;
}) {
  return (
    <div class={`kpi${tone && tone !== "neutral" ? ` kpi-${tone}` : ""}`}>
      <dt class="kpi-label">{label}</dt>
      <dd class="kpi-value">{value}</dd>
      {note ? <dd class="kpi-note">{note}</dd> : null}
    </div>
  );
}

export function KpiRow({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <dl class="kpi-row" aria-label={label}>
      {children}
    </dl>
  );
}
