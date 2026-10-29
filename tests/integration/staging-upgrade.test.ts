import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("staging deployment pulls first and stops on failed migration or backfill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zephium-staging-deploy-"));
  try {
    const log = join(dir, "calls");
    await writeFile(
      join(dir, "docker"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DEPLOY_TEST_LOG"\ncase "$*" in *"$DEPLOY_TEST_FAILURE"*) exit 1;; esac\n',
      { mode: 0o700 },
    );
    const script = new URL("../../deploy/staging-upgrade.sh", import.meta.url).pathname;
    for (const [failure, count] of [
      ["never-match", 6],
      ["pull api", 1],
      ["--wait-timeout 90 postgres", 3],
      ["--no-deps migrate", 4],
      ["backfill-grant-eligibility", 5],
    ] as const) {
      await writeFile(log, "");
      const child = Bun.spawn(
        ["sh", script, "stage-fixture", "/data/coolify/applications/stage-fixture"],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            DEPLOY_TEST_LOG: log,
            DEPLOY_TEST_FAILURE: failure,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(failure === "never-match" ? 0 : 1);
      const calls = (await readFile(log, "utf8")).trim().split("\n");
      expect(calls).toHaveLength(count);
      for (const call of calls) {
        expect(call).toStartWith(
          "compose --project-name stage-fixture --project-directory /data/coolify/applications/stage-fixture -f deploy/compose.staging.yaml --env-file .env ",
        );
      }
      expect(calls[0]).toEndWith("pull api worker migrate");
      if (count > 1) expect(calls[1]).toEndWith("stop --timeout 45 api worker");
      if (count > 2) expect(calls[2]).toEndWith("up -d --wait --wait-timeout 90 postgres");
      if (count === 6) expect(calls[5]).toEndWith("up -d api worker");
    }
    await writeFile(log, "");
    const invalid = Bun.spawn(
      ["sh", script, "stage-fixture", "/data/coolify/applications/wrong-project"],
      {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEPLOY_TEST_LOG: log },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await invalid.exited).toBe(2);
    expect(await readFile(log, "utf8")).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
