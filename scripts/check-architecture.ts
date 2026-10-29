import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

/** Explicit acyclic business dependencies, including type dependencies. */
export const dependencies: Record<string, readonly string[]> = {
  identity: [],
  waitlist: [],
  policy: [],
  credits: ["identity", "policy"],
  billing: ["identity", "credits", "policy"],
  ai: ["identity", "credits", "policy"],
};

export function boundaryViolation(source: string, target: string): string | null {
  const from = source.replaceAll("\\", "/").replace(/\.ts$/, "").split("/");
  const to = target.replaceAll("\\", "/").replace(/\.ts$/, "").split("/");
  const sourceModule = from[1] === "modules" ? from[2] : undefined;
  const targetModule = to[1] === "modules" ? to[2] : undefined;
  if (sourceModule && !dependencies[sourceModule]) return "undeclared module";
  if (from[1] !== "apps" && to[1] === "apps")
    return "business/platform code cannot import an application";
  if (sourceModule && target.startsWith("src/platform/db/schema"))
    return "module must use its own schema";
  if (!targetModule) return null;
  if (from.join("/") === "src/platform/db/schema" && to.at(-1) === "schema") return null;
  if (from[1] === "platform") return "platform cannot depend on business modules";
  if (sourceModule === targetModule) return null;
  if (sourceModule && !dependencies[sourceModule]?.includes(targetModule))
    return "undeclared business dependency";
  // Schema-only foreign keys are an explicit persistence contract, not a service import.
  if (from.at(-1) === "schema" && to.at(-1) === "schema") return null;
  if (to.length > 3 && to.at(-1) !== "index") return "cross-module access must use index.ts";
  return null;
}

const transpiler = new Bun.Transpiler({ loader: "ts" });
export function sourceImports(source: string): string[] {
  const paths = new Set(transpiler.scanImports(source).map((entry) => entry.path));
  // Bun erases type-only imports; include those in the architectural contract too.
  const declarations =
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|[^\n;]+?)\s+from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(declarations)) if (match[1]) paths.add(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g))
    if (match[1]) paths.add(match[1]);
  return [...paths];
}

export async function checkArchitecture(root = resolve(import.meta.dir, "..")): Promise<string[]> {
  const failures: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "__tests__") continue;
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const source = relative(root, file);
      for (const path of sourceImports(await Bun.file(file).text())) {
        if (!path.startsWith(".")) continue;
        const target = relative(root, resolve(directory, path));
        const issue = boundaryViolation(source, target);
        if (issue) failures.push(`${source}: ${path}: ${issue}`);
      }
    }
  }
  await walk(resolve(root, "src"));
  return failures;
}

if (import.meta.main) {
  const failures = await checkArchitecture();
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log("Module boundaries pass");
}
