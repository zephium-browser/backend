import { describe, expect, test } from "bun:test";
import {
  basisPoints,
  budgetLevel,
  compact,
  count,
  credits,
  dayLabel,
  duration,
  humanize,
  integer,
  microsToDollars,
  percent,
  planName,
  rate,
  scaled,
  sumUnits,
  UUID,
  usd,
  usdExact,
  usdMinor,
  utc,
  utcDate,
} from "../format";

describe("integers and counts", () => {
  test("parse only whole decimal strings", () => {
    expect(integer("12")).toBe(12n);
    expect(integer(-5)).toBe(-5n);
    expect(integer("1.5")).toBeNull();
    expect(integer("12abc")).toBeNull();
    expect(integer(null)).toBeNull();
  });
  test("group thousands independent of locale and survive values beyond 2^53", () => {
    expect(count(1234567)).toBe("1,234,567");
    expect(count("9007199254740993123")).toBe("9,007,199,254,740,993,123");
    expect(count("oops")).toBe("—");
    expect(count(-1200)).toBe("−1,200");
  });
});

describe("credits and money", () => {
  test("credits divide by the credit unit without losing precision", () => {
    expect(credits("125000", "10000")).toBe("12.5");
    expect(credits("10000", "10000")).toBe("1");
    expect(credits("1", "10000")).toBe("0");
    expect(credits("123456789012345678901234", "10000")).toBe("12,345,678,901,234,567,890.12");
  });
  test("scaled rejects divisors that are not powers of ten", () => {
    expect(scaled("100", "3")).toBe("—");
    expect(scaled("100", "0")).toBe("—");
  });
  test("negative values keep their sign and never show a negative zero", () => {
    expect(scaled("-125000", "10000")).toBe("−12.5");
    expect(scaled("-1", "10000", 0, 2)).toBe("0");
  });
  test("usd rounds to cents from a dollar and keeps small costs visible", () => {
    expect(usd("12345678")).toBe("$12.35");
    expect(usd("4123")).toBe("$0.0041");
    expect(usd("0")).toBe("$0.00");
    expect(usd("1000000")).toBe("$1.00");
    expect(usd("999999")).toBe("$1.00");
    expect(usd("123456789012345678")).toBe("$123,456,789,012.35");
    expect(usd(null)).toBe("—");
  });
  test("usdExact is lossless", () => {
    expect(usdExact("4123")).toBe("$0.004123");
    expect(usdExact("12345678")).toBe("$12.345678");
  });
  test("usdMinor formats cents", () => {
    expect(usdMinor(2000)).toBe("$20.00");
    expect(usdMinor("123456")).toBe("$1,234.56");
    expect(usdMinor(5)).toBe("$0.05");
  });
  test("chart positions are plain numbers", () => {
    expect(microsToDollars("2500000")).toBe(2.5);
    expect(microsToDollars("nope")).toBe(0);
  });
  test("sumUnits is exact", () => {
    expect(sumUnits(["9007199254740993", "1", 2])).toBe("9007199254740996");
  });
});

describe("budget thresholds", () => {
  test("basis points use integer arithmetic", () => {
    expect(basisPoints("800000", "1000000")).toBe(8000);
    expect(basisPoints("1", "3")).toBe(3333);
    expect(basisPoints("5", "0")).toBeNull();
    expect(basisPoints("5", null)).toBeNull();
    expect(basisPoints("99999999999999999999", "1")).toBe(100000);
  });
  test("warn at 80% and critical at 100%", () => {
    expect(budgetLevel(7999)).toBe("ok");
    expect(budgetLevel(8000)).toBe("warn");
    expect(budgetLevel(9999)).toBe("warn");
    expect(budgetLevel(10000)).toBe("critical");
  });
  test("percent text", () => {
    expect(percent(8000)).toBe("80%");
    expect(percent(8250)).toBe("82.5%");
    expect(rate(3, 40)).toBe("7.5%");
    expect(rate(1, 0)).toBe("—");
  });
});

describe("dates are always UTC", () => {
  test("ISO strings with microseconds are sliced, not converted", () => {
    expect(utc("2026-10-31T14:03:22.123456Z")).toBe("2026-10-31 14:03");
    expect(utc("2026-10-31T14:03:22.123456Z", { seconds: true, label: true })).toBe(
      "2026-10-31 14:03:22 UTC",
    );
    expect(utcDate("2026-10-31T23:59:59.000Z")).toBe("2026-10-31");
  });
  test("offsets are normalised to UTC", () => {
    expect(utc("2026-10-31T23:30:00+02:00")).toBe("2026-10-31 21:30");
  });
  test("bad input is a dash", () => {
    expect(utc("not a date")).toBe("—");
    expect(utc(null)).toBe("—");
  });
  test("day labels do not depend on the viewer's time zone", () => {
    expect(dayLabel("2026-01-05")).toBe("Jan 5");
    expect(dayLabel("2026-12-31")).toBe("Dec 31");
    expect(dayLabel("garbage")).toBe("garbage");
  });
});

describe("durations and labels", () => {
  test("humanize durations to two units", () => {
    expect(duration(0)).toBe("0s");
    expect(duration(45)).toBe("45s");
    expect(duration(200)).toBe("3m 20s");
    expect(duration(3725)).toBe("1h 2m");
    expect(duration(3 * 86400 + 4 * 3600 + 59)).toBe("3d 4h");
    expect(duration(null)).toBe("—");
    expect(duration(-1)).toBe("—");
  });
  test("compact axis numbers", () => {
    expect(compact(0)).toBe("0");
    expect(compact(950)).toBe("950");
    expect(compact(1500)).toBe("1.5k");
    expect(compact(2_000_000)).toBe("2M");
    expect(compact(0.25)).toBe("0.25");
  });
  test("plan and code names", () => {
    expect(planName("pro")).toBe("Pro");
    expect(planName("enterprise")).toBe("Enterprise");
    expect(humanize("usage_export")).toBe("Usage export");
    expect(UUID.test("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(UUID.test("linux-waitlist")).toBe(false);
  });
});
