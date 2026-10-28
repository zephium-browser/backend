import type postgres from "postgres";
import {
  ADMIN_AUTH_ROUTES,
  type AdminAuthDatabase,
  createAdminAccess,
  createAdminAuth,
  createAdminReports,
  getAdminSession,
  handleAdminAuth,
  limitAdminAuth,
  limitAdminReads,
} from "../../modules/admin";
import { createClientAddressResolver } from "../../platform/client-address";
import { AppError, errorResponse, operationalEvent } from "../../platform/errors";
import { readIncomingBody } from "../../platform/incoming-body";
import type { AdminConfig } from "./config";

export type AdminAssets = { html: string; client: string; css: string };
export function createAdminApp(
  config: AdminConfig,
  db: AdminAuthDatabase,
  reportsSql: postgres.Sql,
  assets: AdminAssets,
  peerAddress: (r: Request) => string,
) {
  const verifyAccess = createAdminAccess(config);
  const auth = createAdminAuth(config, db);
  const reports = createAdminReports(reportsSql);
  const origin = new URL(config.ADMIN_ORIGIN);
  const resolveIp = createClientAddressResolver(
    config.ADMIN_TRUSTED_PROXY_CIDRS,
    config.ADMIN_TRUSTED_CLOUDFLARE_CIDRS,
  );
  let active = 0,
    authenticating = 0,
    reading = 0;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  function protect(response: Response) {
    response.headers.set("Cache-Control", "no-store");
    response.headers.set(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    );
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
    if (origin.protocol === "https:")
      response.headers.set("Strict-Transport-Security", "max-age=31536000");
    return response;
  }
  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.host !== origin.host) throw new AppError("forbidden", 403);
    if (url.href.length > 2048 || (request.headers.get("cookie")?.length ?? 0) > 8192)
      throw new AppError("invalid_request");
    if (request.headers.get("origin") && request.headers.get("origin") !== config.ADMIN_ORIGIN)
      throw new AppError("forbidden", 403);
    const site = request.headers.get("sec-fetch-site");
    if (
      (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) &&
      site &&
      site !== "same-origin" &&
      site !== "none"
    )
      throw new AppError("forbidden", 403);
    const internalHealth =
      request.method === "GET" &&
      url.pathname === "/health/ready" &&
      !url.search &&
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peerAddress(request));
    if (!internalHealth) await verifyAccess(request);
    if (request.method === "GET" && !url.search) {
      if (url.pathname === "/")
        return new Response(assets.html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      if (url.pathname === "/assets/client.js")
        return new Response(assets.client, {
          headers: { "Content-Type": "text/javascript; charset=utf-8" },
        });
      if (url.pathname === "/assets/style.css")
        return new Response(assets.css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
      if (url.pathname === "/health/ready") {
        await Promise.all([db.sql`SELECT 1`, reportsSql`SELECT 1`]);
        return json({ status: "ok" });
      }
    }
    if (url.pathname.startsWith("/auth/")) {
      if (url.search || ADMIN_AUTH_ROUTES.get(url.pathname) !== request.method)
        throw new AppError("not_found", 404);
      if (request.method === "POST" && request.headers.get("origin") !== config.ADMIN_ORIGIN)
        throw new AppError("forbidden", 403);
      if (authenticating >= 1) throw new AppError("server_busy", 503, 1);
      authenticating++;
      try {
        let forwarded = request;
        let body: unknown = {};
        if (request.method === "POST") {
          if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
            throw new AppError("invalid_request");
          const bytes = await readIncomingBody(request, 4096, 5000);
          try {
            body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          } catch {
            throw new AppError("invalid_request");
          }
          const headers = new Headers(request.headers);
          headers.delete("transfer-encoding");
          headers.set("content-length", String(bytes.byteLength));
          forwarded = new Request(request, { headers, body: new Uint8Array(bytes) });
        }
        await limitAdminAuth(
          db.sql,
          config.ADMIN_AUTH_SECRET,
          resolveIp(peerAddress(request), request.headers),
          url.pathname,
          body,
          request.headers.get("cookie") ?? "",
          origin.protocol === "https:",
        );
        return await handleAdminAuth(forwarded, auth, db);
      } finally {
        authenticating--;
      }
    }
    if (request.method !== "GET" || !url.pathname.startsWith("/api/"))
      throw new AppError("not_found", 404);
    const allowedQuery =
      url.pathname === "/api/waitlists/linux"
        ? ["cursor"]
        : url.pathname === "/api/overview"
          ? ["days"]
          : url.pathname === "/api/users"
            ? ["q", "cursor"]
            : [];
    if (
      [...url.searchParams.keys()].some(
        (k) => !allowedQuery.includes(k) || url.searchParams.getAll(k).length !== 1,
      )
    )
      throw new AppError("invalid_request");
    const session = await getAdminSession(request.headers, auth, db);
    if (!session) throw new AppError("unauthorized", 401);
    await limitAdminReads(db.sql, config.ADMIN_AUTH_SECRET, session.id);
    if (url.pathname === "/api/session") return json({ operator: session });
    if (!session.mfaVerified) throw new AppError("mfa_required", 403);
    if (reading >= 2) throw new AppError("server_busy", 503, 1);
    reading++;
    try {
      let result: unknown;
      let action: "overview" | "users" | "user";
      let target: string | null = null;
      if (url.pathname === "/api/waitlists/linux") {
        action = "users";
        target = "linux-waitlist";
        result = await reports.linuxWaitlist(url.searchParams.get("cursor") ?? undefined);
      } else if (url.pathname === "/api/overview") {
        const days = url.searchParams.get("days") ?? "1";
        if (!["1", "7", "30"].includes(days)) throw new AppError("invalid_request");
        action = "overview";
        result = await reports.overview(Number(days) as 1 | 7 | 30);
      } else if (url.pathname === "/api/users") {
        action = "users";
        result = await reports.users(
          url.searchParams.get("q") ?? "",
          url.searchParams.get("cursor") ?? undefined,
        );
      } else if (/^\/api\/users\/[^/]+$/.test(url.pathname)) {
        try {
          target = decodeURIComponent(url.pathname.slice("/api/users/".length));
        } catch {
          throw new AppError("invalid_request");
        }
        action = "user";
        result = await reports.user(target);
      } else throw new AppError("not_found", 404);
      // Recheck revocation after potentially waiting on the report connection.
      const stillAllowed = await getAdminSession(request.headers, auth, db);
      if (!stillAllowed?.mfaVerified || stillAllowed.id !== session.id)
        throw new AppError("unauthorized", 401);
      await db.sql`INSERT INTO admin_audit_event(id,operator_id,action,target_id) VALUES (${crypto.randomUUID()},${session.id},${action},${target})`;
      return json(result);
    } finally {
      reading--;
    }
  }
  return {
    auth,
    async fetch(request: Request): Promise<Response> {
      if (active >= 8) return protect(errorResponse(new AppError("server_busy", 503, 1)));
      active++;
      try {
        return protect(await route(request));
      } catch (error) {
        if (!(error instanceof AppError)) operationalEvent("admin_request_failed");
        return protect(
          errorResponse(error instanceof AppError ? error : new AppError("unavailable", 503)),
        );
      } finally {
        active--;
      }
    },
  };
}
