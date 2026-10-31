import { ApiError, type WaitlistPage } from "../api";
import { csvRow } from "../csv";

export type ExportProgress = {
  fetched: number;
  total: number;
  /** Seconds left before the next attempt, while the server asks us to slow down. */
  waiting: number | null;
};

export const EXPORT_LIMIT = 100_000;
const MAX_WAITS_IN_A_ROW = 20;

/**
 * Walk the export pages and build the CSV in memory. Rate limits (429) and busy replies (503)
 * pause for the server's Retry-After and then retry the same page instead of failing the export.
 */
export async function buildWaitlistCsv(
  fetchPage: (cursor: string | null) => Promise<WaitlistPage>,
  options: {
    signal: AbortSignal;
    wait: (seconds: number) => Promise<void>;
    onProgress: (progress: ExportProgress) => void;
    limit?: number;
  },
): Promise<{ csv: string; rows: number } | null> {
  const limit = options.limit ?? EXPORT_LIMIT;
  const lines = [csvRow(["email", "subscribed_at"])];
  let cursor: string | null = null;
  let total = 0;
  let waits = 0;
  for (;;) {
    let page: WaitlistPage;
    try {
      page = await fetchPage(cursor);
    } catch (error) {
      if (options.signal.aborted) return null;
      if (
        error instanceof ApiError &&
        (error.kind === "rate_limited" || error.kind === "busy") &&
        waits < MAX_WAITS_IN_A_ROW
      ) {
        waits++;
        options.onProgress({ fetched: lines.length - 1, total, waiting: error.retryAfter ?? 5 });
        await options.wait(error.retryAfter ?? 5);
        continue;
      }
      throw error;
    }
    if (options.signal.aborted) return null;
    waits = 0;
    if (!page.available) throw new Error("export_unavailable");
    total = page.subscribed;
    for (const item of page.items) lines.push(csvRow([item.email, item.subscribed_at]));
    if (lines.length - 1 > limit) throw new Error("export_too_large");
    options.onProgress({ fetched: lines.length - 1, total, waiting: null });
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
  }
  return { csv: lines.join("\r\n"), rows: lines.length - 1 };
}
