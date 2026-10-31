import type { TransactionSql } from "postgres";
import { cleanupBatchSize, type Database, deleteInBatches } from "../../platform/db";

/** Called only after the deletion coordinator confirms provider and job cleanup. */
export async function purgeAccount(
  tx: TransactionSql,
  userId: string,
  email: string,
): Promise<void> {
  await tx`DELETE FROM auth_verification WHERE identifier=${`sign-in-otp-${email}`}`;
  await tx`DELETE FROM auth_user WHERE id=${userId}`;
}

type MaintenanceSql = Database["sql"] | TransactionSql;

export function cleanupExpiredActionCodes(sql: MaintenanceSql): Promise<void> {
  return deleteInBatches(
    () => sql`DELETE FROM action_otp WHERE ctid IN (
      SELECT ctid FROM action_otp WHERE expires_at < now() LIMIT ${cleanupBatchSize})`,
  );
}

export function cleanupExpiredAuthCodes(sql: MaintenanceSql): Promise<void> {
  return deleteInBatches(
    () => sql`DELETE FROM auth_verification WHERE id IN (
      SELECT id FROM auth_verification WHERE expires_at < now() LIMIT ${cleanupBatchSize})`,
  );
}

export function cleanupExpiredSessions(sql: MaintenanceSql): Promise<void> {
  return deleteInBatches(
    () => sql`DELETE FROM auth_session WHERE id IN (
      SELECT id FROM auth_session WHERE expires_at < now() LIMIT ${cleanupBatchSize})`,
  );
}
