import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { dayLabel } from "../format";
import { clampIndex, indexAt, labelEvery, niceTicks } from "./chart-math";

export type SeriesTone = "accent" | "muted" | "critical";
export type ChartSeries = {
  id: string;
  label: string;
  tone: SeriesTone;
  /** Plot positions. Display strings are separate so exact values never pass through Number. */
  values: number[];
  display: string[];
};
export type ChartExtra = { label: string; display: string[] };

type ChartProps = {
  title: string;
  /** "YYYY-MM-DD" per point, oldest first. All days are UTC. */
  days: string[];
  series: ChartSeries[];
  kind: "bars" | "line";
  stacked?: boolean;
  tick: (value: number) => string;
  extras?: ChartExtra[];
};

const HEIGHT = 220;
const MARGIN = { top: 12, right: 12, bottom: 28, left: 46 };

function useWidth(): [(node: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(640);
  const observer = useRef<ResizeObserver | null>(null);
  const attach = (node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!node) return;
    setWidth(Math.max(240, Math.floor(node.clientWidth)));
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(() =>
      setWidth(Math.max(240, Math.floor(node.clientWidth))),
    );
    observer.current.observe(node);
  };
  useEffect(() => () => observer.current?.disconnect(), []);
  return [attach, width];
}

export function Legend({ series }: { series: Pick<ChartSeries, "id" | "label" | "tone">[] }) {
  return (
    <ul class="legend" aria-label="Legend">
      {series.map((item) => (
        <li key={item.id}>
          <span class={`swatch tone-${item.tone}`} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export function Chart({ title, days, series, kind, stacked, tick, extras = [] }: ChartProps) {
  const [measure, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const [spoken, setSpoken] = useState("");
  const count = days.length;
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = plotW / Math.max(count, 1);

  const totals = days.map((_, index) =>
    stacked
      ? series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0)
      : Math.max(0, ...series.map((item) => item.values[index] ?? 0)),
  );
  const { ticks, top } = niceTicks(Math.max(0, ...totals));
  const y = (value: number) => MARGIN.top + plotH - (value / top) * plotH;
  const xCenter = (index: number) => MARGIN.left + (index + 0.5) * band;
  const every = labelEvery(count, plotW);
  const barWidth = Math.max(1, Math.min(band * 0.72, 28));
  const hasData = totals.some((value) => value > 0);

  const describe = (index: number): string => {
    const parts = series.map((item) => `${item.label} ${item.display[index] ?? "—"}`);
    for (const extra of extras) parts.push(`${extra.label} ${extra.display[index] ?? "—"}`);
    return `${days[index] ?? ""} UTC: ${parts.join(", ")}`;
  };
  const move = (index: number) => {
    const next = clampIndex(index, count);
    setActive(next);
    setSpoken(describe(next));
  };
  const tooltipId = useId();
  const current = active === null ? null : clampIndex(active, count);

  return (
    <div class="chart">
      {/* biome-ignore lint/a11y/useSemanticElements: custom keyboard-driven plot, data is in the table below */}
      <div
        class="chart-frame"
        ref={measure}
        role="group"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the plot is keyboard-operable (arrow keys)
        tabIndex={0}
        aria-label={`${title}. Use the left and right arrow keys to read each day, or open the data table below.`}
        aria-describedby={current === null ? undefined : tooltipId}
        onPointerMove={(event) => {
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          setActive(indexAt(event.clientX - rect.left, MARGIN.left, plotW, count));
        }}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          const from = current ?? count;
          if (event.key === "ArrowLeft") move(from - 1);
          else if (event.key === "ArrowRight") move(current === null ? 0 : from + 1);
          else if (event.key === "Home") move(0);
          else if (event.key === "End") move(count - 1);
          else if (event.key === "Escape") setActive(null);
          else return;
          event.preventDefault();
        }}
      >
        <svg
          class="chart-svg"
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          aria-hidden="true"
          focusable="false"
        >
          <g class="chart-grid">
            {ticks.map((value) => (
              <g key={value}>
                <line
                  class={value === 0 ? "chart-baseline" : undefined}
                  x1={MARGIN.left}
                  x2={MARGIN.left + plotW}
                  y1={y(value)}
                  y2={y(value)}
                />
                <text
                  class="chart-tick"
                  x={MARGIN.left - 8}
                  y={y(value)}
                  dy="0.32em"
                  text-anchor="end"
                >
                  {tick(value)}
                </text>
              </g>
            ))}
          </g>
          <g class="chart-axis">
            {days.map((day, index) =>
              (index % every === 0 && count - 1 - index >= every) || index === count - 1 ? (
                <text
                  key={day}
                  class="chart-tick"
                  x={xCenter(index)}
                  y={HEIGHT - 8}
                  text-anchor={index === 0 ? "start" : index === count - 1 ? "end" : "middle"}
                >
                  {dayLabel(day)}
                </text>
              ) : null,
            )}
          </g>
          {current === null ? null : (
            <rect
              class="chart-hover"
              x={MARGIN.left + current * band}
              y={MARGIN.top}
              width={band}
              height={plotH}
            />
          )}
          {kind === "bars"
            ? days.map((day, index) => {
                let base = 0;
                return (
                  <g key={day}>
                    {series.map((item) => {
                      const value = item.values[index] ?? 0;
                      if (value <= 0) return null;
                      const start = stacked ? base : 0;
                      if (stacked) base += value;
                      const height = Math.max(1, (value / top) * plotH);
                      return (
                        <rect
                          key={item.id}
                          class={`bar tone-${item.tone}`}
                          x={xCenter(index) - barWidth / 2}
                          y={y(start + value)}
                          width={barWidth}
                          height={height}
                        />
                      );
                    })}
                  </g>
                );
              })
            : series.map((item) => (
                <g key={item.id}>
                  <polyline
                    class={`line tone-${item.tone}`}
                    fill="none"
                    points={item.values
                      .map((value, index) => `${xCenter(index)},${y(value)}`)
                      .join(" ")}
                  />
                  {current === null ? null : (
                    <circle
                      class={`dot tone-${item.tone}`}
                      cx={xCenter(current)}
                      cy={y(item.values[current] ?? 0)}
                      r="4"
                    />
                  )}
                </g>
              ))}
        </svg>
        {!hasData ? <p class="chart-empty muted">No activity in this period.</p> : null}
        {current === null ? null : (
          <div
            id={tooltipId}
            class={`tooltip${xCenter(current) > width / 2 ? " tooltip-left" : ""}`}
            // Positioned from the data point; a CSS custom property keeps styling in the stylesheet.
            style={{ "--x": `${xCenter(current)}px` }}
          >
            <p class="tooltip-day">{days[current]} UTC</p>
            <ul>
              {series.map((item) => (
                <li key={item.id}>
                  <span class={`swatch tone-${item.tone}`} aria-hidden="true" />
                  <span>{item.label}</span>
                  <strong>{item.display[current] ?? "—"}</strong>
                </li>
              ))}
              {extras.map((extra) => (
                <li key={extra.label}>
                  <span class="swatch swatch-none" aria-hidden="true" />
                  <span>{extra.label}</span>
                  <strong>{extra.display[current] ?? "—"}</strong>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <p class="sr-only" aria-live="polite">
        {spoken}
      </p>
    </div>
  );
}

/** Disclosure for the accessible data table beneath a chart. */
export function DataToggle({ label, children }: { label: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div class="data-toggle">
      <button
        type="button"
        class="btn btn-quiet"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide" : "Show"} {label}
      </button>
      <div id={id} hidden={!open}>
        {open ? children : null}
      </div>
    </div>
  );
}
