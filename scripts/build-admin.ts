import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = resolve(root, "src/apps/admin/ui");
const destination = resolve(root, "dist/admin");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
// JSX settings (Preact automatic runtime) come from the root tsconfig.json.
const result = await Bun.build({
  entrypoints: [resolve(source, "main.tsx")],
  outdir: destination,
  naming: "client.js",
  target: "browser",
  minify: true,
  sourcemap: "none",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
await Promise.all(
  ["index.html", "style.css"].map((name) =>
    Bun.write(resolve(destination, name), Bun.file(resolve(source, name))),
  ),
);
const size = Bun.file(resolve(destination, "client.js")).size;
console.info(`Built admin UI in dist/admin (client.js ${(size / 1024).toFixed(1)} KiB)`);
