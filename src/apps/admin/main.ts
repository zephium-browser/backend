import {
  assertAdminDatabasePrivileges,
  cleanAdminAuth,
  createAdminDatabase,
  createReportDatabase,
} from "../../modules/admin";
import { operationalEvent } from "../../platform/errors";
import { createAdminApp } from "./app";
import { readAdminConfig } from "./config";

const config = readAdminConfig();
const db = createAdminDatabase(config);
const reports = createReportDatabase(config.ADMIN_READ_DATABASE_URL);
await assertAdminDatabasePrivileges(db.sql, reports);
const assets = {
  html: await Bun.file("dist/admin/index.html").text(),
  client: await Bun.file("dist/admin/client.js").text(),
  css: await Bun.file("dist/admin/style.css").text(),
  icon: await Bun.file("dist/admin/favicon.svg").text(),
};
let server: Bun.Server<undefined>;
const app = createAdminApp(
  config,
  db,
  reports,
  assets,
  (r) => server.requestIP(r)?.address ?? "unknown",
);
server = Bun.serve({
  port: config.ADMIN_PORT,
  hostname: "0.0.0.0",
  idleTimeout: 15,
  maxRequestBodySize: 4096,
  fetch: (r) => app.fetch(r),
});
let cleaning = false;
const maintenance = setInterval(async () => {
  if (cleaning) return;
  cleaning = true;
  try {
    await cleanAdminAuth(db.sql);
  } catch {
    operationalEvent("admin_cleanup_failed");
  } finally {
    cleaning = false;
  }
}, 60000);
async function stop() {
  clearInterval(maintenance);
  await server.stop(true);
  await Promise.all([db.close(), reports.end({ timeout: 5 })]);
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
