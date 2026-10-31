import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import type postgres from "postgres";

/** Optional admin schema: no dependency on unreleased customer API migrations. */
export async function migrateAdmin(sql: postgres.Sql) {
  const directory = new URL("../src/modules/admin/migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((n) => /^\d{4}_.+\.sql$/.test(n)).sort();
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(91843729)`;
    await tx`CREATE TABLE IF NOT EXISTS admin_schema_migration(name text PRIMARY KEY,digest text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    await tx`REVOKE ALL ON admin_schema_migration FROM PUBLIC`;
    await tx`DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zephium_app') THEN REVOKE ALL ON admin_schema_migration FROM zephium_app; END IF; END $$`;
    for (const name of names) {
      const body = await Bun.file(new URL(name, directory)).text();
      const digest = createHash("sha256").update(body).digest("hex");
      const [row] = await tx`SELECT digest FROM admin_schema_migration WHERE name=${name}`;
      if (row && row.digest !== digest) throw new Error("Applied admin migration changed");
      if (!row) {
        await tx.unsafe(body);
        await tx`INSERT INTO admin_schema_migration(name,digest) VALUES (${name},${digest})`;
      }
    }
  });
}
if (import.meta.main) {
  const url = process.env.ADMIN_MIGRATOR_DATABASE_URL;
  if (!url) throw new Error("ADMIN_MIGRATOR_DATABASE_URL is required");
  const sql = (await import("postgres")).default(url, {
    max: 1,
    connect_timeout: 5,
    connection: { statement_timeout: 30000, lock_timeout: 1000 },
    onnotice: () => {},
  });
  try {
    await migrateAdmin(sql);
    console.log("Admin schema verified");
  } catch {
    console.error("Admin migration failed; inspect schema state without logging credentials");
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
