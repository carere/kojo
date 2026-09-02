import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../.github/scripts/systemd-shipped-singleton-evidence.sh",
);
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const fixture = (launcherBody: string) => {
  const root = mkdtempSync(join(tmpdir(), "kojo-systemd-singleton-"));
  roots.push(root);
  const launcher = join(root, "kojo-launcher");
  const endpoint = join(root, "endpoint.json");
  const log = join(root, "singleton.log");
  const receipt = join(root, "singleton.json");
  const timeoutCommand = join(root, "timeout");
  writeFileSync(launcher, `#!/usr/bin/env bash\nset -Eeuo pipefail\n${launcherBody}\n`);
  chmodSync(launcher, 0o700);
  writeFileSync(
    timeoutCommand,
    `#!/usr/bin/env bash
set -uo pipefail
shift 2
duration=$1
shift
"$@" &
subject=$!
(
  sleep "$duration"
  kill -TERM "$subject" 2>/dev/null || exit 0
  sleep 0.05
  kill -KILL "$subject" 2>/dev/null || true
) &
watchdog=$!
wait "$subject"
status=$?
kill "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true
if [[ $status -eq 143 || $status -eq 137 ]]; then exit 124; fi
exit "$status"
`,
  );
  chmodSync(timeoutCommand, 0o700);
  writeFileSync(endpoint, JSON.stringify({ instanceId: "active-instance" }));
  return { launcher, endpoint, log, receipt, timeoutCommand };
};

const runHelper = async (
  subject: ReturnType<typeof fixture>,
  timeout = "0.5s",
): Promise<{ readonly exitCode: number; readonly elapsedMillis: number }> => {
  const startedAt = performance.now();
  const child = Bun.spawn(
    ["bash", helper, subject.launcher, subject.endpoint, subject.log, subject.receipt, timeout],
    {
      env: { ...process.env, KOJO_EVIDENCE_TIMEOUT_COMMAND: subject.timeoutCommand },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    },
  );
  const exitCode = await Promise.race([
    child.exited,
    Bun.sleep(1_000).then(async () => {
      process.kill(-child.pid, "SIGKILL");
      await child.exited;
      return 255;
    }),
  ]);
  return { exitCode, elapsedMillis: performance.now() - startedAt };
};

describe("shipped systemd singleton evidence", () => {
  it("runs the Daemon child mode, proves exact refusal, and keeps the active instance", async () => {
    const subject = fixture(`
if [[ \${KOJO_DAEMON_CHILD:-} != 1 ]]; then
  exec sleep 10
fi
printf '%s\\n' 'error: another Daemon start or purge transition owns the stable lifecycle gate' >&2
printf '%s\\n' 'code: "PURGE_GATE_HELD"' >&2
exit 1`);

    const result = await runHelper(subject);

    expect(result.exitCode).toBe(0);
    expect(result.elapsedMillis).toBeLessThan(1_000);
    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
      formatVersion: 1,
      mode: "KOJO_DAEMON_CHILD=1",
      expectedRefusal: "PURGE_GATE_HELD",
      exitCode: 1,
      activeInstanceId: "active-instance",
      observedInstanceId: "active-instance",
      activeInstanceBefore: "active-instance",
      activeInstanceAfter: "active-instance",
      activeInstanceUnchanged: true,
      accepted: true,
    });
  });

  it("bounds a Daemon child that does not refuse ownership", async () => {
    const subject = fixture("exec sleep 10");

    const result = await runHelper(subject, "0.1s");

    expect(result.exitCode).toBe(1);
    expect(result.elapsedMillis).toBeLessThan(1_000);
    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
      exitCode: 124,
      activeInstanceUnchanged: true,
      accepted: false,
    });
  });
});
