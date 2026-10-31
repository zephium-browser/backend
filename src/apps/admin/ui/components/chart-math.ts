/** Geometry helpers for the SVG charts. Pure, so they can be tested without a DOM. */

/** Round a step up to 1, 2 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/** Y-axis ticks from zero to a rounded-up top that is at least `max`. */
export function niceTicks(max: number, target = 4): { ticks: number[]; top: number } {
  const step = niceStep(max > 0 ? max / target : 1);
  const steps = Math.max(1, Math.ceil(max / step - 1e-9));
  const ticks = Array.from({ length: steps + 1 }, (_, index) =>
    Number((index * step).toPrecision(12)),
  );
  return { ticks, top: ticks[ticks.length - 1] ?? step };
}

/** Show every n-th x label so neighbouring labels keep at least `minSpacing` pixels. */
export function labelEvery(count: number, plotWidth: number, minSpacing = 64): number {
  if (count <= 1) return 1;
  const band = plotWidth / count;
  return Math.max(1, Math.ceil(minSpacing / Math.max(band, 1)));
}

/** Index of the band under an x coordinate, or null when outside the plot area. */
export function indexAt(x: number, left: number, plotWidth: number, count: number): number | null {
  if (count <= 0 || x < left || x > left + plotWidth) return null;
  return Math.min(count - 1, Math.floor(((x - left) / plotWidth) * count));
}

export function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, index));
}
