import { describe, expect, test } from "bun:test";
import { clampIndex, indexAt, labelEvery, niceStep, niceTicks } from "../components/chart-math";

describe("chart math", () => {
  test("nice steps are 1, 2 or 5 times a power of ten", () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.3)).toBe(2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(0)).toBe(1);
  });
  test("ticks start at zero and cover the maximum", () => {
    expect(niceTicks(0)).toEqual({ ticks: [0, 1], top: 1 });
    expect(niceTicks(37)).toEqual({ ticks: [0, 10, 20, 30, 40], top: 40 });
    const fractional = niceTicks(0.37);
    expect(fractional.top).toBeGreaterThanOrEqual(0.37);
    expect(fractional.ticks[1]).toBe(0.1);
  });
  test("label spacing never packs labels closer than the minimum", () => {
    expect(labelEvery(30, 600)).toBe(4);
    expect(labelEvery(90, 600)).toBe(10);
    expect(labelEvery(5, 600)).toBe(1);
  });
  test("pointer position maps to a band", () => {
    expect(indexAt(46, 46, 300, 30)).toBe(0);
    expect(indexAt(345, 46, 300, 30)).toBe(29);
    expect(indexAt(10, 46, 300, 30)).toBeNull();
    expect(indexAt(400, 46, 300, 30)).toBeNull();
    expect(clampIndex(-1, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
  });
});
