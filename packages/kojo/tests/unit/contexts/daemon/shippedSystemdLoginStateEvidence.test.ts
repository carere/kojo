import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../.github/scripts/systemd-shipped-login-state-evidence.sh",
);
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const fixture = (
  mode: "no-present" | "yes-absent" | "unexpected" | "missing-state" | "error" | "timeout",
) => {
  const root = mkdtempSync(join(tmpdir(), "kojo-systemd-login-state-"));
  roots.push(root);
  const loginctl = join(root, "loginctl");
  const timeout = join(root, "timeout");
  const sleep = join(root, "sleep");
  const loginctlCalls = join(root, "loginctl-calls");
  const timeoutCalls = join(root, "timeout-calls");
  const sleepCalls = join(root, "sleep-calls");
  const receipt = join(root, "receipt.json");
  const stderr = join(root, "stderr.log");
  const properties =
    mode === "no-present"
      ? ["Sessions=42", "Linger=no", "State=active"]
      : mode === "yes-absent"
        ? ["Sessions=", "Linger=yes", "State=lingering"]
        : mode === "missing-state"
          ? ["Sessions=42", "Linger=no", "State="]
          : ["Sessions=42", "Linger=yes", "State=active"];
  writeFileSync(
    loginctl,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `printf '%s\\n' "$*" >>"$KOJO_TEST_LOGINCTL_CALLS"`,
      "if (( $# != 5 )); then",
      "  echo 'Unexpected loginctl arguments.' >&2",
      "  exit 64",
      "fi",
      "if [[ $1 != show-user || $2 != 1234 || $3 != --property=Sessions || $4 != --property=Linger || $5 != --property=State ]]; then",
      "  echo 'Unexpected loginctl arguments.' >&2",
      "  exit 64",
      "fi",
      ...(mode === "error"
        ? ["echo 'Failed to connect to bus: Connection refused' >&2", "exit 1"]
        : properties.map((property) => `echo '${property}'`)),
      "",
    ].join("\n"),
  );
  writeFileSync(
    timeout,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `printf '%s\\n' "$*" >>"$KOJO_TEST_TIMEOUT_CALLS"`,
      ...(mode === "timeout" ? ["exit 124"] : ["shift 2", "shift", `exec "$@"`]),
      "",
    ].join("\n"),
  );
  writeFileSync(sleep, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"$KOJO_TEST_SLEEP_CALLS"\n`);
  chmodSync(loginctl, 0o700);
  chmodSync(timeout, 0o700);
  chmodSync(sleep, 0o700);
  return {
    root,
    loginctl,
    timeout,
    sleep,
    loginctlCalls,
    timeoutCalls,
    sleepCalls,
    receipt,
    stderr,
  };
};

const runHelper = async (
  subject: ReturnType<typeof fixture>,
  expectedLinger: "no" | "yes",
  expectedSessions: "present" | "absent",
) => {
  const child = Bun.spawn(
    [
      "bash",
      helper,
      subject.receipt,
      subject.stderr,
      "kojo-shipped-evidence",
      "1234",
      expectedLinger,
      expectedSessions,
      "1",
      "0.1s",
    ],
    {
      env: {
        ...process.env,
        KOJO_EVIDENCE_LOGINCTL_COMMAND: subject.loginctl,
        KOJO_EVIDENCE_TIMEOUT_COMMAND: subject.timeout,
        KOJO_EVIDENCE_SLEEP_COMMAND: subject.sleep,
        KOJO_TEST_LOGINCTL_CALLS: subject.loginctlCalls,
        KOJO_TEST_TIMEOUT_CALLS: subject.timeoutCalls,
        KOJO_TEST_SLEEP_CALLS: subject.sleepCalls,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return child.exited;
};

describe("shipped systemd login-state evidence", () => {
  it("makes the fake loginctl refuse the unsupported comma form before property output", async () => {
    const subject = fixture("no-present");
    const child = Bun.spawn(
      [subject.loginctl, "show-user", "1234", "--property=Sessions,Linger,State"],
      {
        env: {
          ...process.env,
          KOJO_TEST_LOGINCTL_CALLS: subject.loginctlCalls,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(child.stdout).text();

    expect(await child.exited).toBe(64);
    expect(stdout).toBe("");
    expect(readFileSync(subject.loginctlCalls, "utf8").trim()).toBe(
      "show-user 1234 --property=Sessions,Linger,State",
    );
  });

  it("accepts expected no linger with a live SSH session", async () => {
    const subject = fixture("no-present");

    expect(await runHelper(subject, "no", "present")).toBe(0);

    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
      kind: "bounded-systemd-login-state",
      user: "kojo-shipped-evidence",
      uid: 1234,
      attemptLimit: 1,
      observationCount: 1,
      expected: {
        classification: "login-state-matched-within-bound",
        statusCommandExit: 0,
        linger: "no",
        sessions: "present",
        state: "present",
      },
      actual: {
        classification: "login-state-matched-within-bound",
        statusCommandExit: 0,
        linger: "no",
        sessions: "42",
        state: "active",
      },
      readOnly: true,
      accepted: true,
    });
    expect(readFileSync(subject.loginctlCalls, "utf8").trim()).toBe(
      "show-user 1234 --property=Sessions --property=Linger --property=State",
    );
    expect(readFileSync(subject.timeoutCalls, "utf8").trim()).toBe(
      `--signal=TERM --kill-after=1s 1s ${subject.loginctl} show-user 1234 --property=Sessions --property=Linger --property=State`,
    );
  });

  it("accepts expected yes linger after the SSH session exits", async () => {
    const subject = fixture("yes-absent");

    expect(await runHelper(subject, "yes", "absent")).toBe(0);

    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
      expected: { linger: "yes", sessions: "absent" },
      actual: { linger: "yes", sessions: "", state: "lingering" },
      accepted: true,
    });
  });

  it("rejects an unexpected linger value", async () => {
    const subject = fixture("unexpected");

    expect(await runHelper(subject, "no", "present")).toBe(1);

    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
      actual: {
        classification: "login-state-not-matched-within-bound",
        statusCommandExit: 0,
        linger: "yes",
      },
      accepted: false,
    });
  });

  it("fails closed when loginctl omits the requested State value", async () => {
    const subject = fixture("missing-state");

    expect(await runHelper(subject, "no", "present")).toBe(1);

    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
      expected: { state: "present" },
      actual: {
        classification: "login-state-not-matched-within-bound",
        statusCommandExit: 0,
        linger: "no",
        sessions: "42",
        state: "",
      },
      observations: [{ actual: { classification: "login-state-mismatch", state: "" } }],
      accepted: false,
    });
  });

  it("fails closed on a loginctl error", async () => {
    const subject = fixture("error");

    expect(await runHelper(subject, "no", "present")).toBe(1);

    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
      actual: {
        classification: "login-state-not-matched-within-bound",
        statusCommandExit: 1,
      },
      observations: [{ actual: { classification: "probe-failed", statusCommandExit: 1 } }],
      accepted: false,
    });
    expect(readFileSync(subject.stderr, "utf8")).toContain(
      "LoginProbeStderr=Failed to connect to bus: Connection refused",
    );
  });

  it("fails closed when the bounded loginctl probe times out", async () => {
    const subject = fixture("timeout");

    expect(await runHelper(subject, "yes", "absent")).toBe(1);

    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
      actual: {
        classification: "login-state-not-matched-within-bound",
        statusCommandExit: 124,
      },
      observations: [{ actual: { classification: "probe-timed-out", statusCommandExit: 124 } }],
      accepted: false,
    });
  });
});
