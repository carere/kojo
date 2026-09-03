import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../.github/scripts/systemd-shipped-linger-authorization.sh",
);
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

type FixtureMode =
  | "authorized"
  | "authorized-state-mismatch"
  | "invalid-success-output"
  | "refused"
  | "refused-wrong-exit"
  | "refused-state-mismatch"
  | "timeout"
  | "unexpected-failure";

const fixture = (mode: FixtureMode = "authorized") => {
  const root = mkdtempSync(join(tmpdir(), "kojo-systemd-linger-authorization-"));
  roots.push(root);
  const managedKojo = join(root, "kojo");
  const loginState = join(root, "login-state");
  const timeout = join(root, "timeout");
  const commandCalls = join(root, "command-calls");
  const loginStateCalls = join(root, "login-state-calls");
  const timeoutCalls = join(root, "timeout-calls");
  const receipt = join(root, "authorization.json");
  const commandLog = join(root, "authorization.log");
  const loginStateReceipt = join(root, "login-state.json");
  const loginStateStderr = join(root, "login-state.stderr.log");
  writeFileSync(
    managedKojo,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `printf '%s\\n' "$*" >>"$KOJO_TEST_COMMAND_CALLS"`,
      "if [[ $* != 'daemon keep-running-after-logout' ]]; then exit 64; fi",
      ...(mode === "refused" || mode === "refused-state-mismatch" || mode === "refused-wrong-exit"
        ? [
            "echo 'kojo: LINGER_PERMISSION_DENIED: Host policy refused logout persistence' >&2",
            `exit ${mode === "refused-wrong-exit" ? 2 : 1}`,
          ]
        : mode === "unexpected-failure"
          ? ["echo 'kojo: LINGER_ENABLE_FAILED: logind is unavailable' >&2", "exit 1"]
          : mode === "invalid-success-output"
            ? ["echo 'unrelated success output'"]
            : [
                "echo 'This changes linger for the complete OS user. All user services can then run after logout.'",
                "echo 'Keep running after logout: enabled.'",
              ]),
      "",
    ].join("\n"),
  );
  writeFileSync(
    loginState,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `printf '%s\\n' "$*" >>"$KOJO_TEST_LOGIN_STATE_CALLS"`,
      "receipt=$1",
      "stderr_log=$2",
      ': >"$stderr_log"',
      ...(mode === "authorized-state-mismatch" || mode === "refused-state-mismatch"
        ? [
            "if [[ $5 == yes ]]; then actual_linger=no; else actual_linger=yes; fi",
            "accepted=false",
          ]
        : ["actual_linger=$5", "accepted=true"]),
      'jq -n --arg expectedLinger "$5" --arg actualLinger "$actual_linger" --argjson accepted "$accepted" \'{',
      '  expected: { classification: "login-state-matched-within-bound", statusCommandExit: 0, linger: $expectedLinger, sessions: "present", state: "present" },',
      '  actual: { classification: (if $accepted then "login-state-matched-within-bound" else "login-state-not-matched-within-bound" end), statusCommandExit: 0, linger: $actualLinger, sessions: "42", state: "active" },',
      "  readOnly: true, accepted: $accepted",
      '}\' >"$receipt"',
      "if [[ $accepted != true ]]; then exit 1; fi",
      "",
    ].join("\n"),
  );
  writeFileSync(
    timeout,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `printf '%s\\n' "$*" >>"$KOJO_TEST_TIMEOUT_CALLS"`,
      ...(mode === "timeout" ? ["exit 124"] : ["shift 3", 'exec "$@"']),
      "",
    ].join("\n"),
  );
  for (const executable of [managedKojo, loginState, timeout]) chmodSync(executable, 0o700);
  return {
    root,
    managedKojo,
    loginState,
    timeout,
    commandCalls,
    loginStateCalls,
    timeoutCalls,
    receipt,
    commandLog,
    loginStateReceipt,
    loginStateStderr,
  };
};

const runHelper = async (
  subject: ReturnType<typeof fixture>,
  expectation = "success-or-refusal",
) => {
  const child = Bun.spawn(
    [
      "bash",
      helper,
      subject.receipt,
      subject.commandLog,
      subject.loginStateReceipt,
      subject.loginStateStderr,
      subject.managedKojo,
      subject.loginState,
      "kojo-shipped-evidence",
      "1234",
      expectation,
    ],
    {
      env: {
        ...process.env,
        KOJO_EVIDENCE_TIMEOUT_COMMAND: subject.timeout,
        KOJO_TEST_COMMAND_CALLS: subject.commandCalls,
        KOJO_TEST_LOGIN_STATE_CALLS: subject.loginStateCalls,
        KOJO_TEST_TIMEOUT_CALLS: subject.timeoutCalls,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return child.exited;
};

describe("shipped systemd linger authorization evidence", () => {
  it("accepts Host-authorized linger without a policy retry", async () => {
    const subject = fixture();

    expect(await runHelper(subject)).toBe(0);

    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toEqual({
      formatVersion: 1,
      kind: "shipped-systemd-linger-authorization-attempt",
      expectation: "success-or-refusal",
      expected: {
        classification: "explicit-linger-success-or-policy-refusal",
        command: "daemon keep-running-after-logout",
        commandExit: "zero-or-linger-permission-denied",
        liveLoginState: "matched",
      },
      actual: {
        classification: "host-authorized-success",
        commandExit: 0,
        linger: "yes",
        loginStateAccepted: true,
      },
      retryRequired: false,
      accepted: true,
    });
    expect(readFileSync(subject.commandCalls, "utf8").trim()).toBe(
      "daemon keep-running-after-logout",
    );
    expect(readFileSync(subject.loginStateCalls, "utf8").trim()).toBe(
      `${subject.loginStateReceipt} ${subject.loginStateStderr} kojo-shipped-evidence 1234 yes present 1 0s`,
    );
    expect(readFileSync(subject.timeoutCalls, "utf8").trim()).toBe(
      `--signal=TERM --kill-after=1s 60s ${subject.managedKojo} daemon keep-running-after-logout`,
    );
  });

  it("records an exact Host policy refusal for one policy retry", async () => {
    const subject = fixture("refused");

    expect(await runHelper(subject)).toBe(0);

    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
      expected: { classification: "explicit-linger-success-or-policy-refusal" },
      actual: {
        classification: "host-policy-refusal",
        commandExit: 1,
        linger: "no",
      },
      retryRequired: true,
      accepted: true,
    });
    expect(readFileSync(subject.loginStateCalls, "utf8").trim()).toContain(
      "kojo-shipped-evidence 1234 no present 1 0s",
    );
  });

  it("requires success after a policy retry", async () => {
    const subject = fixture();

    expect(await runHelper(subject, "success-required")).toBe(0);

    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
      expected: {
        classification: "explicit-linger-success",
        commandExit: 0,
      },
      actual: { classification: "host-authorized-success", linger: "yes" },
      retryRequired: false,
      accepted: true,
    });
  });

  it.each([
    ["an unrelated command failure", "unexpected-failure", "unexpected-command-failure", 1],
    ["a command timeout", "timeout", "command-timed-out", 124],
    [
      "success without the exact status output",
      "invalid-success-output",
      "invalid-success-output",
      0,
    ],
  ] as const)("fails closed on %s", async (_name, mode, classification, commandExit) => {
    const subject = fixture(mode);

    expect(await runHelper(subject)).toBe(1);

    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
      actual: { classification, commandExit, loginStateAccepted: false },
      retryRequired: false,
      accepted: false,
    });
  });

  it.each([
    ["Host-authorized success", "authorized-state-mismatch"],
    ["Host policy refusal", "refused-state-mismatch"],
  ] as const)(
    "fails closed when %s does not have its required live linger state",
    async (_name, mode) => {
      const subject = fixture(mode);

      expect(await runHelper(subject)).toBe(1);

      expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
        actual: { classification: "linger-state-not-confirmed", loginStateAccepted: false },
        retryRequired: false,
        accepted: false,
      });
    },
  );

  it("does not accept a second policy refusal when success is required", async () => {
    const subject = fixture("refused");

    expect(await runHelper(subject, "success-required")).toBe(1);

    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
      expected: { classification: "explicit-linger-success" },
      actual: { classification: "unexpected-command-failure", commandExit: 1 },
      retryRequired: false,
      accepted: false,
    });
  });

  it("fails closed when refusal text has an unexpected exit status", async () => {
    const subject = fixture("refused-wrong-exit");

    expect(await runHelper(subject)).toBe(1);

    expect(JSON.parse(readFileSync(subject.receipt, "utf8"))).toMatchObject({
      actual: { classification: "unexpected-command-failure", commandExit: 2 },
      retryRequired: false,
      accepted: false,
    });
  });
});
