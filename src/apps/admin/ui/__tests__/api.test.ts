import { describe, expect, test } from "bun:test";
import { ApiError, classify, errorMessage, parseRetryAfter } from "../api";

describe("retry-after", () => {
  test("delta seconds", () => {
    expect(parseRetryAfter("12")).toBe(12);
    expect(parseRetryAfter("0")).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
  test("http dates", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(parseRetryAfter("Sat, 31 Oct 2026 12:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Sat, 31 Oct 2026 11:00:00 GMT", now)).toBeNull();
    expect(parseRetryAfter("tomorrow", now)).toBeNull();
  });
});

describe("error classification", () => {
  test("statuses map to operator-facing kinds", () => {
    expect(classify(401, null)).toBe("unauthorized");
    expect(classify(403, "mfa_required")).toBe("mfa_required");
    expect(classify(403, "forbidden")).toBe("forbidden");
    expect(classify(404, null)).toBe("not_found");
    expect(classify(429, null)).toBe("rate_limited");
    expect(classify(503, "server_busy")).toBe("busy");
    expect(classify(400, "invalid_request")).toBe("invalid");
    expect(classify(500, null)).toBe("server");
  });
  test("messages never echo server details", () => {
    expect(errorMessage(new ApiError("rate_limited", 429, 30))).toContain("30 seconds");
    expect(errorMessage(new ApiError("access_expired", 0))).toContain("Cloudflare Access");
    expect(errorMessage(new Error("secret detail"))).not.toContain("secret");
  });
});
