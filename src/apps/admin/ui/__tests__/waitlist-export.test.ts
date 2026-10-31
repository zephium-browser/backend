import { describe, expect, test } from "bun:test";
import { ApiError, type WaitlistPage } from "../api";
import { buildWaitlistCsv, type ExportProgress } from "../views/waitlist-export";

const page = (emails: string[], next: string | null): WaitlistPage => ({
  available: true,
  subscribed: 3,
  confirmed: 3,
  pending: 0,
  items: emails.map((email, index) => ({
    id: String(index),
    email,
    confirmed_at: null,
    subscribed_at: "2026-10-01T00:00:00.000Z",
  })),
  next_cursor: next,
});

describe("buildWaitlistCsv", () => {
  test("walks every page and protects formulas", async () => {
    const pages = [page(["a@x.co", "=evil@x.co"], "p2"), page(["c@x.co"], null)];
    const seen: (string | null)[] = [];
    const progress: ExportProgress[] = [];
    const result = await buildWaitlistCsv(
      async (cursor) => {
        seen.push(cursor);
        return pages[seen.length - 1] as WaitlistPage;
      },
      {
        signal: new AbortController().signal,
        wait: async () => {},
        onProgress: (value) => progress.push(value),
      },
    );
    expect(seen).toEqual([null, "p2"]);
    expect(result?.rows).toBe(3);
    expect(result?.csv.split("\r\n")).toEqual([
      '"email","subscribed_at"',
      '"a@x.co","2026-10-01T00:00:00.000Z"',
      `"'=evil@x.co","2026-10-01T00:00:00.000Z"`,
      '"c@x.co","2026-10-01T00:00:00.000Z"',
    ]);
    expect(progress.at(-1)).toEqual({ fetched: 3, total: 3, waiting: null });
  });

  test("honours Retry-After on 429 and retries the same page", async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await buildWaitlistCsv(
      async () => {
        calls++;
        if (calls === 1) throw new ApiError("rate_limited", 429, 7);
        return page(["a@x.co"], null);
      },
      {
        signal: new AbortController().signal,
        wait: async (seconds) => {
          waits.push(seconds);
        },
        onProgress: () => {},
      },
    );
    expect(waits).toEqual([7]);
    expect(calls).toBe(2);
    expect(result?.rows).toBe(1);
  });

  test("other failures surface and the size limit is enforced", async () => {
    const options = {
      signal: new AbortController().signal,
      wait: async () => {},
      onProgress: () => {},
    };
    await expect(
      buildWaitlistCsv(async () => {
        throw new ApiError("server", 500);
      }, options),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      buildWaitlistCsv(async () => page(["a@x.co", "b@x.co"], null), { ...options, limit: 1 }),
    ).rejects.toThrow("export_too_large");
  });

  test("an aborted export returns nothing", async () => {
    const controller = new AbortController();
    const result = await buildWaitlistCsv(
      async () => {
        controller.abort();
        return page(["a@x.co"], "more");
      },
      { signal: controller.signal, wait: async () => {}, onProgress: () => {} },
    );
    expect(result).toBeNull();
  });
});
