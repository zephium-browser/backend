import { AppError } from "../../platform/errors";
import type { CloudPolicy } from "../policy";
import type { Tx } from "./grants";

/** USD micro-dollar exposure is independent of customer credit pricing. */
const keys = (scope: string, day: string) => [
  `${scope}:total`,
  `${scope}:day:${day}`,
  `${scope}:free:${day}`,
];
export async function reserveBudget(
  tx: Tx,
  p: CloudPolicy,
  id: string,
  cost: bigint,
  freeCost: bigint,
) {
  const budget = p.limits.budgets;
  if (!budget) return true;
  // Taken only after account, wallet, grants and provider quota locks. No network I/O.
  await tx`SELECT pg_advisory_xact_lock(91843724)`;
  const [clock] =
    await tx`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day, ceil(extract(epoch FROM ((date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC')-clock_timestamp()))::integer AS retry`;
  const day = String(clock?.day);
  const retry = Math.max(1, Number(clock?.retry));
  const names = keys(budget.scope, day);
  const amounts: bigint[] = [];
  for (const key of names) {
    await tx`INSERT INTO cloud_spend_bucket(key) VALUES (${key}) ON CONFLICT DO NOTHING`;
    const [row] = await tx`SELECT amount FROM cloud_spend_bucket WHERE key=${key}`;
    amounts.push(BigInt(row?.amount ?? 0));
  }
  if (budget.totalUsdMicros !== null && (amounts[0] ?? 0n) + cost > BigInt(budget.totalUsdMicros))
    throw new AppError("cloud_budget_exhausted", 503);
  if (budget.dailyUsdMicros !== null && (amounts[1] ?? 0n) + cost > BigInt(budget.dailyUsdMicros))
    throw new AppError("cloud_budget_exhausted", 503, retry);
  if (
    freeCost > 0n &&
    budget.freeDailyUsdMicros !== null &&
    (amounts[2] ?? 0n) + freeCost > BigInt(budget.freeDailyUsdMicros)
  )
    return false;
  for (const [i, key] of names.entries()) {
    const amount = i === 2 ? freeCost : cost;
    await tx`UPDATE cloud_spend_bucket SET amount=amount+${amount.toString()} WHERE key=${key}`;
  }
  await tx`INSERT INTO cloud_cost_record(request_id,scope,day,reserved,exposure,free_reserved,free_exposure) VALUES (${id},${budget.scope},${day},${cost.toString()},${cost.toString()},${freeCost.toString()},${freeCost.toString()})`;
  return true;
}

/** Missing usage retains exposure even after customer holds are refunded. */
export async function settleBudget(tx: Tx, id: string, actual: bigint, capAtReserved = false) {
  await tx`SELECT pg_advisory_xact_lock(91843724)`;
  const [record] =
    await tx`SELECT *,day::text AS day_text FROM cloud_cost_record WHERE request_id=${id} FOR UPDATE`;
  if (!record || record.terminal) return;
  const reserved = BigInt(record.reserved);
  if (capAtReserved && actual > reserved) actual = reserved;
  const free =
    reserved === 0n ? 0n : (actual * BigInt(record.free_reserved) + reserved - 1n) / reserved;
  for (const [i, key] of keys(record.scope, record.day_text).entries()) {
    const delta = i === 2 ? free - BigInt(record.free_exposure) : actual - BigInt(record.exposure);
    await tx`UPDATE cloud_spend_bucket SET amount=amount+${delta.toString()} WHERE key=${key}`;
  }
  await tx`UPDATE cloud_cost_record SET exposure=${actual.toString()},free_exposure=${free.toString()},terminal=true WHERE request_id=${id}`;
}

/** Aggregate operational signal; no customer identifiers leave the service. */
export async function budgetNearLimit(
  db: import("../../platform/db").Database,
  p: CloudPolicy,
): Promise<boolean> {
  const budget = p.limits.budgets;
  if (!p.enabled || !budget) return false;
  const [clock] =
    await db.sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day`;
  const caps = [budget.totalUsdMicros, budget.dailyUsdMicros, budget.freeDailyUsdMicros];
  for (const [i, key] of keys(budget.scope, String(clock?.day)).entries()) {
    const cap = caps[i];
    if (cap === null || cap === undefined) continue;
    const [row] = await db.sql`SELECT amount FROM cloud_spend_bucket WHERE key=${key}`;
    if (BigInt(row?.amount ?? "0") * 100n >= BigInt(cap) * 80n) return true;
  }
  return false;
}
