import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../.github/scripts/systemd-shipped-login-readiness.sh",
);
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const fixture = (unavailableAttempts: number, options: { readonly hang?: boolean } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "kojo-systemd-login-readiness-"));
  roots.push(root);
  const systemctl = join(root, "systemctl");
  const sleep = join(root, "sleep");
  const timeout = join(root, "timeout");
  const attempts = join(root, "attempts");
  const systemctlCalls = join(root, "systemctl-calls");
  const sleepCalls = join(root, "sleep-calls");
  const observations = join(root, "observations.jsonl");
  const final = join(root, "final.json");
  const stderr = join(root, "stderr.log");
  writeFileSync(
    systemctl,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      ...(options.hang === true ? ["exec sleep 10"] : []),
      'count=$(($(cat "$KOJO_TEST_ATTEMPTS" 2>/dev/null || echo 0) + 1))',
      'printf \'%s\\n\' "$count" >"$KOJO_TEST_ATTEMPTS"',
      "if [[ $count -le $KOJO_TEST_UNAVAILABLE_ATTEMPTS ]]; then",
      "  echo 'Failed to connect to bus: Connection refused' >&2",
      "  exit 1",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  writeFileSync(sleep, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >>"$KOJO_TEST_SLEEP_CALLS"\n');
  writeFileSync(
    timeout,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      "shift 2",
      "duration=$1",
      "shift",
      'command=("$@")',
      `printf '%s\\n' "\${command[*]:1}" >>"$KOJO_TEST_SYSTEMCTL_CALLS"`,
      `"\${command[@]}" &`,
      "subject=$!",
      "(",
      '  sleep "$duration"',
      '  kill -TERM "$subject" 2>/dev/null || exit 0',
      "  sleep 0.05",
      '  kill -KILL "$subject" 2>/dev/null || true',
      ") &",
      "watchdog=$!",
      'wait "$subject"',
      "status=$?",
      'kill "$watchdog" 2>/dev/null || true',
      'wait "$watchdog" 2>/dev/null || true',
      "if [[ $status -eq 143 || $status -eq 137 ]]; then exit 124; fi",
      'exit "$status"',
      "",
    ].join("\n"),
  );
  chmodSync(systemctl, 0o700);
  chmodSync(sleep, 0o700);
  chmodSync(timeout, 0o700);
  return {
    root,
    systemctl,
    sleep,
    timeout,
    attempts,
    systemctlCalls,
    sleepCalls,
    observations,
    final,
    stderr,
    unavailableAttempts,
  };
};

const runHelper = async (
  subject: ReturnType<typeof fixture>,
  attemptLimit: number,
  probeTimeout = "5s",
): Promise<{ readonly exitCode: number; readonly elapsedMillis: number }> => {
  const startedAt = performance.now();
  const child = Bun.spawn(
    [
      "bash",
      helper,
      subject.observations,
      subject.final,
      subject.stderr,
      String(attemptLimit),
      "0.1s",
    ],
    {
      env: {
        ...process.env,
        KOJO_EVIDENCE_SYSTEMCTL_COMMAND: subject.systemctl,
        KOJO_EVIDENCE_SLEEP_COMMAND: subject.sleep,
        KOJO_EVIDENCE_TIMEOUT_COMMAND: subject.timeout,
        KOJO_EVIDENCE_PROBE_TIMEOUT: probeTimeout,
        KOJO_TEST_ATTEMPTS: subject.attempts,
        KOJO_TEST_SYSTEMCTL_CALLS: subject.systemctlCalls,
        KOJO_TEST_SLEEP_CALLS: subject.sleepCalls,
        KOJO_TEST_UNAVAILABLE_ATTEMPTS: String(subject.unavailableAttempts),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: await child.exited,
    elapsedMillis: performance.now() - startedAt,
  };
};

describe("shipped systemd login readiness evidence", () => {
  it("observes the user manager until the reconnect session is ready", async () => {
    const subject = fixture(2);

    const result = await runHelper(subject, 5);

    expect(result.exitCode).toBe(0);
    expect(result.elapsedMillis).toBeLessThan(10_000);
    const observations = readFileSync(subject.observations, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(observations).toHaveLength(3);
    expect(observations.map((observation) => observation.expected)).toEqual([
      { classification: "manager-ready", statusCommandExit: 0 },
      { classification: "manager-ready", statusCommandExit: 0 },
      { classification: "manager-ready", statusCommandExit: 0 },
    ]);
    expect(observations.map((observation) => observation.actual)).toEqual([
      { classification: "manager-unavailable", statusCommandExit: 1 },
      { classification: "manager-unavailable", statusCommandExit: 1 },
      { classification: "manager-ready", statusCommandExit: 0 },
    ]);
    expect(JSON.parse(readFileSync(subject.final, "utf8"))).toMatchObject({
      formatVersion: 1,
      kind: "bounded-systemd-login-readiness",
      attemptLimit: 5,
      observationCount: 3,
      expected: { classification: "manager-ready-within-bound", managerReady: true },
      actual: {
        classification: "manager-ready-within-bound",
        managerReady: true,
        lastStatusCommandExit: 0,
      },
      managerReady: true,
      noServiceStartRepairOrLingerChange: true,
      accepted: true,
    });
    expect(readFileSync(subject.systemctlCalls, "utf8").trim().split("\n")).toEqual([
      "--user show-environment",
      "--user show-environment",
      "--user show-environment",
    ]);
    expect(readFileSync(subject.sleepCalls, "utf8").trim().split("\n")).toEqual(["0.1s", "0.1s"]);
  });

  it("preserves every failed observation and stops at the exact bound", async () => {
    const subject = fixture(10);

    const result = await runHelper(subject, 2);

    expect(result.exitCode).toBe(1);
    expect(result.elapsedMillis).toBeLessThan(10_000);
    const observations = readFileSync(subject.observations, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(observations).toHaveLength(2);
    expect(observations.map((observation) => observation.actual.classification)).toEqual([
      "manager-unavailable",
      "manager-unavailable",
    ]);
    expect(JSON.parse(readFileSync(subject.final, "utf8"))).toMatchObject({
      attemptLimit: 2,
      observationCount: 2,
      expected: { classification: "manager-ready-within-bound", managerReady: true },
      actual: {
        classification: "manager-not-ready-within-bound",
        managerReady: false,
        lastStatusCommandExit: 1,
      },
      managerReady: false,
      noServiceStartRepairOrLingerChange: true,
      accepted: false,
    });
    expect(readFileSync(subject.systemctlCalls, "utf8").trim().split("\n")).toEqual([
      "--user show-environment",
      "--user show-environment",
    ]);
    expect(readFileSync(subject.sleepCalls, "utf8").trim()).toBe("0.1s");
    expect(readFileSync(subject.stderr, "utf8")).toContain(
      "Failed to connect to bus: Connection refused",
    );
  });

  it("bounds each user-manager probe that does not return", async () => {
    const subject = fixture(0, { hang: true });

    const result = await runHelper(subject, 2, "0.1s");

    expect(result.exitCode).toBe(1);
    expect(result.elapsedMillis).toBeLessThan(3_000);
    const observations = readFileSync(subject.observations, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(observations.map((observation) => observation.expected.classification)).toEqual([
      "manager-ready",
      "manager-ready",
    ]);
    expect(observations.map((observation) => observation.actual.classification)).toEqual([
      "probe-timed-out",
      "probe-timed-out",
    ]);
    expect(JSON.parse(readFileSync(subject.final, "utf8"))).toMatchObject({
      attemptLimit: 2,
      observationCount: 2,
      lastStatusCommandExit: 124,
      expected: { classification: "manager-ready-within-bound", managerReady: true },
      actual: {
        classification: "manager-not-ready-within-bound",
        managerReady: false,
        lastStatusCommandExit: 124,
      },
      managerReady: false,
      accepted: false,
    });
    expect(readFileSync(subject.systemctlCalls, "utf8").trim().split("\n")).toEqual([
      "--user show-environment",
      "--user show-environment",
    ]);
    expect(readFileSync(subject.sleepCalls, "utf8").trim()).toBe("0.1s");
  });
});
