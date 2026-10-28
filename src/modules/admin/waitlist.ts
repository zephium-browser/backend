import type postgres from "postgres";
import { z } from "zod";
import { AppError } from "../../platform/errors";

const cursorSchema = z.object({ id: z.uuid(), until: z.iso.datetime() }).strict();
/** Confirmed addresses only. Never exposes proof tokens or email delivery data. */
export async function reportLinuxWaitlist(sql: postgres.Sql, cursor?: string) {
  let position: z.infer<typeof cursorSchema> | undefined;
  if (cursor !== undefined) {
    try {
      if (cursor.length > 300 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      position = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    } catch {
      throw new AppError("invalid_request");
    }
  }
  return sql.begin("read only isolation level repeatable read", async (tx) => {
    await tx`SET LOCAL statement_timeout='2s'`;
    await tx`SET LOCAL lock_timeout='500ms'`;
    const [view] =
      await tx`SELECT CASE WHEN to_regclass('public.admin_report_linux_waitlist') IS NULL THEN false
      ELSE has_table_privilege(current_user,'public.admin_report_linux_waitlist','SELECT') END AS available`;
    if (!view?.available)
      return { available: false, confirmed: 0, pending: 0, items: [], next_cursor: null };
    const [clock] = await tx`SELECT now() AS time`;
    const until = position?.until ?? new Date(clock?.time).toISOString();
    if (Date.parse(until) > Date.now() + 60000) throw new AppError("invalid_request");
    const [counts] =
      await tx`SELECT count(*) FILTER(WHERE confirmed_at IS NOT NULL)::integer AS confirmed,
      count(*) FILTER(WHERE confirmed_at IS NULL)::integer AS pending FROM admin_report_linux_waitlist`;
    const rows = await tx`SELECT id,email,confirmed_at FROM admin_report_linux_waitlist
      WHERE confirmed_at IS NOT NULL AND confirmed_at<=${until}::timestamptz
      AND (${position?.id ?? null}::uuid IS NULL OR id>${position?.id ?? null}::uuid)
      ORDER BY id LIMIT 201`;
    const items = rows.slice(0, 200);
    const last = items.at(-1);
    return {
      available: true,
      confirmed: Number(counts?.confirmed ?? 0),
      pending: Number(counts?.pending ?? 0),
      items,
      next_cursor:
        rows.length > 200 && last
          ? Buffer.from(JSON.stringify({ id: last.id, until })).toString("base64url")
          : null,
    };
  });
}
