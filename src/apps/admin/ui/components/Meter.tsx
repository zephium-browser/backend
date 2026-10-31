import { basisPoints, budgetLevel, type Level, percent, usd } from "../format";

const WORDS: Record<Level, string> = {
  ok: "Within budget",
  warn: "Approaching cap",
  critical: "Cap reached",
};

/** Spend against a cap. Thresholds: 80% warns, 100% is critical; text repeats what colour shows. */
export function Meter({ label, spent, cap }: { label: string; spent: string; cap: string | null }) {
  const bp = basisPoints(spent, cap);
  const level = bp === null ? null : budgetLevel(bp);
  const width = bp === null ? 0 : Math.min(bp, 10000) / 100;
  return (
    <div class="meter">
      <div class="meter-head">
        <span class="meter-label">{label}</span>
        <span class="meter-figures">
          {usd(spent)}
          <span class="muted"> / {cap === null ? "no cap" : usd(cap)}</span>
        </span>
      </div>
      {bp === null || level === null ? (
        <p class="meter-state muted">Uncapped</p>
      ) : (
        <>
          {/* biome-ignore lint/a11y/useSemanticElements: <meter> cannot be styled consistently */}
          <div
            class="meter-track"
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(Math.round(bp / 100), 100)}
            aria-valuetext={`${usd(spent)} of ${usd(cap)}, ${percent(bp)}. ${WORDS[level]}`}
          >
            <div class={`meter-fill meter-${level}`} style={{ "--w": `${width}%` }} />
            <span class="meter-mark meter-mark-80" aria-hidden="true" />
          </div>
          <p class={`meter-state meter-text-${level}`}>
            {percent(bp)} · {WORDS[level]}
          </p>
        </>
      )}
    </div>
  );
}
