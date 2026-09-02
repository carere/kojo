import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../.github/scripts/systemd-shipped-logout-readiness.sh",
);
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const fixture = (
  completeAfter: number,
  options: {
    readonly keepCgroupPopulated?: boolean;
    readonly loginProbeFailure?: boolean;
  } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "kojo-systemd-logout-readiness-"));
  roots.push(root);
  const systemctl = join(root, "systemctl");
  const loginctl = join(root, "loginctl");
  const sleep = join(root, "sleep");
  const timeout = join(root, "timeout");
  const attempts = join(root, "attempts");
  const systemctlCalls = join(root, "systemctl-calls");
  const loginctlCalls = join(root, "loginctl-calls");
  const sleepCalls = join(root, "sleep-calls");
  const timeoutCalls = join(root, "timeout-calls");
  const observations = join(root, "observations.jsonl");
  const final = join(root, "final.json");
  const stderr = join(root, "stderr.log");
  const endpoint = join(root, "endpoint.json");
  const bus = join(root, "bus");
  const cgroupRoot = join(root, "cgroup");
  const cgroupEvents = join(
    cgroupRoot,
    "user.slice/user-1234.slice/user@1234.service/cgroup.events",
  );
  mkdirSync(dirname(cgroupEvents), { recursive: true });
  writeFileSync(bus, "stale bus socket path");
  writeFileSync(cgroupEvents, "populated 1\n");
  writeFileSync(
    systemctl,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `printf '%s\\n' "$*" >>"$KOJO_TEST_SYSTEMCTL_CALLS"`,
      'count=$(($(cat "$KOJO_TEST_ATTEMPTS" 2>/dev/null || echo 0) + 1))',
      `printf '%s\\n' "$count" >"$KOJO_TEST_ATTEMPTS"`,
      "if [[ $count -eq 1 ]]; then",
      "  echo 'ActiveState=deactivating'",
      "  echo 'SubState=stop-sigterm'",
      "  echo 'Job=/org/freedesktop/systemd1/job/42'",
      "else",
      "  echo 'ActiveState=inactive'",
      "  echo 'SubState=dead'",
      "  echo 'Job='",
      "fi",
      "echo 'ControlGroup=/user.slice/user-1234.slice/user@1234.service'",
      "",
    ].join("\n"),
  );
  writeFileSync(
    loginctl,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `printf '%s\\n' "$*" >>"$KOJO_TEST_LOGINCTL_CALLS"`,
      'count=$(cat "$KOJO_TEST_ATTEMPTS")',
      "if [[ $count -lt $KOJO_TEST_COMPLETE_AFTER ]]; then",
      "  echo 'Sessions='",
      "  echo 'Linger=no'",
      "  echo 'State=closing'",
      "  exit 0",
      "fi",
      "if [[ $KOJO_TEST_LOGIN_PROBE_FAILURE == yes ]]; then",
      "  echo 'Failed to connect to bus: Connection refused' >&2",
      "  exit 1",
      "fi",
      "echo 'Failed to get user: User ID 1234 is not logged in or lingering' >&2",
      "exit 1",
      "",
    ].join("\n"),
  );
  writeFileSync(
    sleep,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `printf '%s\\n' "$*" >>"$KOJO_TEST_SLEEP_CALLS"`,
      'count=$(cat "$KOJO_TEST_ATTEMPTS")',
      "if [[ $count -eq $(($KOJO_TEST_COMPLETE_AFTER - 1)) ]]; then",
      '  rm -f "$KOJO_TEST_BUS"',
      "  if [[ $KOJO_TEST_CLEAR_CGROUP == yes ]]; then",
      `    printf 'populated 0\\n' >"$KOJO_TEST_CGROUP_EVENTS"`,
      "  fi",
      "fi",
      "",
    ].join("\n"),
  );
  writeFileSync(
    timeout,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `printf '%s\\n' "$*" >>"$KOJO_TEST_TIMEOUT_CALLS"`,
      "command=$4",
      'if [[ $command == "$KOJO_EVIDENCE_SYSTEMCTL_COMMAND" && $KOJO_TEST_MANAGER_TIMEOUT == yes ]]; then exit 124; fi',
      'if [[ $command == "$KOJO_EVIDENCE_LOGINCTL_COMMAND" && $KOJO_TEST_LOGIN_TIMEOUT == yes ]]; then exit 124; fi',
      "shift 2",
      "shift",
      `exec "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(systemctl, 0o700);
  chmodSync(loginctl, 0o700);
  chmodSync(sleep, 0o700);
  chmodSync(timeout, 0o700);
  return {
    root,
    systemctl,
    loginctl,
    sleep,
    timeout,
    attempts,
    systemctlCalls,
    loginctlCalls,
    sleepCalls,
    timeoutCalls,
    observations,
    final,
    stderr,
    endpoint,
    bus,
    cgroupRoot,
    cgroupEvents,
    completeAfter,
    keepCgroupPopulated: options.keepCgroupPopulated === true,
    loginProbeFailure: options.loginProbeFailure === true,
    managerProbeTimeout: false,
    loginProbeTimeout: false,
  };
};

type PredicateOptions = {
  readonly activeState?: string;
  readonly subState?: string;
  readonly job?: string;
  readonly cgroup?: "absent" | "empty" | "populated";
  readonly endpointPresent?: boolean;
  readonly busPresent?: boolean;
  readonly login?: "absent" | "present" | "error" | "timeout";
  readonly manager?: "ready" | "error" | "timeout";
};

const predicateFixture = (options: PredicateOptions = {}) => {
  const subject = fixture(1);
  const activeState = options.activeState ?? "inactive";
  const subState = options.subState ?? "dead";
  const job = options.job ?? "";
  const cgroup = options.cgroup ?? "empty";
  const login = options.login ?? "absent";
  const manager = options.manager ?? "ready";
  writeFileSync(
    subject.systemctl,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `printf '%s\\n' "$*" >>"$KOJO_TEST_SYSTEMCTL_CALLS"`,
      ...(manager === "error"
        ? ["echo 'Failed to connect to bus: Connection refused' >&2", "exit 1"]
        : [
            `echo 'ActiveState=${activeState}'`,
            `echo 'SubState=${subState}'`,
            `echo 'Job=${job}'`,
            "echo 'ControlGroup=/user.slice/user-1234.slice/user@1234.service'",
          ]),
      "",
    ].join("\n"),
  );
  writeFileSync(
    subject.loginctl,
    [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `printf '%s\\n' "$*" >>"$KOJO_TEST_LOGINCTL_CALLS"`,
      ...(login === "present"
        ? ["echo 'Sessions=99'", "echo 'Linger=no'", "echo 'State=active'"]
        : login === "error"
          ? ["echo 'Failed to connect to bus: Connection refused' >&2", "exit 1"]
          : [
              "echo 'Failed to get user: User ID 1234 is not logged in or lingering' >&2",
              "exit 1",
            ]),
      "",
    ].join("\n"),
  );
  if (cgroup === "absent") {
    rmSync(subject.cgroupRoot, { recursive: true });
  } else {
    writeFileSync(subject.cgroupEvents, `populated ${cgroup === "populated" ? "1" : "0"}\n`);
  }
  if (options.endpointPresent === true) writeFileSync(subject.endpoint, "present");
  if (options.busPresent !== true) rmSync(subject.bus);
  return {
    ...subject,
    managerProbeTimeout: manager === "timeout",
    loginProbeTimeout: login === "timeout",
  };
};

const runHelper = async (subject: ReturnType<typeof fixture>, attemptLimit: number) => {
  const child = Bun.spawn(
    [
      "bash",
      helper,
      subject.observations,
      subject.final,
      subject.stderr,
      "kojo-shipped-evidence",
      "1234",
      subject.endpoint,
      subject.bus,
      String(attemptLimit),
      "0.1s",
    ],
    {
      env: {
        ...process.env,
        KOJO_EVIDENCE_SYSTEMCTL_COMMAND: subject.systemctl,
        KOJO_EVIDENCE_LOGINCTL_COMMAND: subject.loginctl,
        KOJO_EVIDENCE_SLEEP_COMMAND: subject.sleep,
        KOJO_EVIDENCE_TIMEOUT_COMMAND: subject.timeout,
        KOJO_EVIDENCE_CGROUP_ROOT: subject.cgroupRoot,
        KOJO_TEST_ATTEMPTS: subject.attempts,
        KOJO_TEST_SYSTEMCTL_CALLS: subject.systemctlCalls,
        KOJO_TEST_LOGINCTL_CALLS: subject.loginctlCalls,
        KOJO_TEST_SLEEP_CALLS: subject.sleepCalls,
        KOJO_TEST_TIMEOUT_CALLS: subject.timeoutCalls,
        KOJO_TEST_COMPLETE_AFTER: String(subject.completeAfter),
        KOJO_TEST_BUS: subject.bus,
        KOJO_TEST_CGROUP_EVENTS: subject.cgroupEvents,
        KOJO_TEST_CLEAR_CGROUP: subject.keepCgroupPopulated ? "no" : "yes",
        KOJO_TEST_LOGIN_PROBE_FAILURE: subject.loginProbeFailure ? "yes" : "no",
        KOJO_TEST_MANAGER_TIMEOUT: subject.managerProbeTimeout ? "yes" : "no",
        KOJO_TEST_LOGIN_TIMEOUT: subject.loginProbeTimeout ? "yes" : "no",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return child.exited;
};

describe("shipped systemd final-logout readiness evidence", () => {
  it("waits for the complete user-manager and login teardown", async () => {
    const subject = fixture(3);

    expect(await runHelper(subject, 5)).toBe(0);

    const observations = readFileSync(subject.observations, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(observations.map((observation) => observation.expected)).toEqual(
      Array.from({ length: 3 }, () => ({
        classification: "logout-complete",
        managerStatus: 0,
        managerClassification: "properties-returned",
        managerActiveState: "inactive",
        managerSubState: "dead",
        managerJobPresent: false,
        managerCgroupPopulated: false,
        loginClassification: "user-absent",
        loginUserPresent: false,
        endpointPresent: false,
        busPresent: false,
      })),
    );
    expect(observations.map((observation) => observation.actual.classification)).toEqual([
      "logout-incomplete",
      "logout-incomplete",
      "logout-complete",
    ]);
    expect(observations[0]?.actual).toMatchObject({
      managerActiveState: "deactivating",
      managerSubState: "stop-sigterm",
      managerJob: "/org/freedesktop/systemd1/job/42",
      managerJobPresent: true,
      managerCgroupPopulated: true,
      loginUserPresent: true,
      loginState: "closing",
      endpointPresent: false,
      busPresent: true,
    });
    expect(observations[2]?.actual).toMatchObject({
      managerActiveState: "inactive",
      managerSubState: "dead",
      managerJob: "",
      managerJobPresent: false,
      managerCgroupPopulated: false,
      loginClassification: "user-absent",
      loginUserPresent: false,
      endpointPresent: false,
      busPresent: false,
    });
    expect(JSON.parse(readFileSync(subject.final, "utf8"))).toMatchObject({
      kind: "bounded-systemd-final-logout-readiness",
      observationCount: 3,
      expected: { classification: "logout-complete-within-bound" },
      actual: { classification: "logout-complete-within-bound" },
      accepted: true,
      noServiceStartRepairOrLingerChange: true,
    });
    expect(readFileSync(subject.systemctlCalls, "utf8").trim().split("\n")).toEqual([
      "show user@1234.service --property=ActiveState,SubState,Job,ControlGroup",
      "show user@1234.service --property=ActiveState,SubState,Job,ControlGroup",
      "show user@1234.service --property=ActiveState,SubState,Job,ControlGroup",
    ]);
    expect(readFileSync(subject.loginctlCalls, "utf8").trim().split("\n")).toEqual([
      "show-user kojo-shipped-evidence --property=Sessions,Linger,State",
      "show-user kojo-shipped-evidence --property=Sessions,Linger,State",
      "show-user kojo-shipped-evidence --property=Sessions,Linger,State",
    ]);
    expect(readFileSync(subject.sleepCalls, "utf8").trim().split("\n")).toEqual(["0.1s", "0.1s"]);
    const timeoutCalls = readFileSync(subject.timeoutCalls, "utf8").trim().split("\n");
    expect(timeoutCalls).toHaveLength(6);
    expect(timeoutCalls.filter((call) => call.includes(`${subject.systemctl} show`))).toHaveLength(
      3,
    );
    expect(
      timeoutCalls.filter((call) => call.includes(`${subject.loginctl} show-user`)),
    ).toHaveLength(3);
    expect(timeoutCalls.every((call) => call.startsWith("--signal=TERM --kill-after=1s 1s "))).toBe(
      true,
    );
  });

  it("preserves incomplete logout evidence and stops at the exact bound", async () => {
    const subject = fixture(10);

    expect(await runHelper(subject, 2)).toBe(1);

    const final = JSON.parse(readFileSync(subject.final, "utf8"));
    expect(final).toMatchObject({
      attemptLimit: 2,
      observationCount: 2,
      expected: { classification: "logout-complete-within-bound" },
      actual: {
        classification: "logout-not-complete-within-bound",
        managerActiveState: "inactive",
        managerSubState: "dead",
        managerCgroupPopulated: true,
        loginUserPresent: true,
        endpointPresent: false,
        busPresent: true,
      },
      accepted: false,
    });
    expect(readFileSync(subject.sleepCalls, "utf8").trim()).toBe("0.1s");
  });

  it.each([
    {
      name: "deactivating manager",
      options: { activeState: "deactivating" },
      changed: { managerActiveState: "deactivating" },
    },
    {
      name: "non-dead manager substate",
      options: { subState: "stop-sigterm" },
      changed: { managerSubState: "stop-sigterm" },
    },
    {
      name: "pending manager Job",
      options: { job: "/org/freedesktop/systemd1/job/42" },
      changed: { managerJob: "/org/freedesktop/systemd1/job/42", managerJobPresent: true },
    },
    {
      name: "populated user-manager cgroup",
      options: { cgroup: "populated" as const },
      changed: { managerCgroupPopulated: true, managerCgroupState: "populated" },
    },
    {
      name: "present Daemon endpoint",
      options: { endpointPresent: true },
      changed: { endpointPresent: true },
    },
    {
      name: "present user bus",
      options: { busPresent: true },
      changed: { busPresent: true },
    },
    {
      name: "present login user",
      options: { login: "present" as const },
      changed: {
        loginStatus: 0,
        loginClassification: "user-present",
        loginUserPresent: true,
        loginSessions: "99",
        loginLinger: "no",
        loginState: "active",
      },
    },
  ])("rejects a $name as the only incomplete logout signal", async ({ options, changed }) => {
    const subject = predicateFixture(options);

    expect(await runHelper(subject, 1)).toBe(1);

    const final = JSON.parse(readFileSync(subject.final, "utf8"));
    expect(final).toMatchObject({
      attemptLimit: 1,
      observationCount: 1,
      interval: "0.1s",
      probeTimeout: "1s",
      actual: {
        classification: "logout-not-complete-within-bound",
        managerStatus: 0,
        managerClassification: "properties-returned",
        managerActiveState: "inactive",
        managerSubState: "dead",
        managerJob: "",
        managerJobPresent: false,
        managerControlGroup: "/user.slice/user-1234.slice/user@1234.service",
        managerCgroupPopulated: false,
        managerCgroupState: "empty",
        loginStatus: 1,
        loginClassification: "user-absent",
        loginUserPresent: false,
        loginSessions: "",
        loginLinger: "",
        loginState: "",
        endpointPresent: false,
        busPresent: false,
        ...changed,
      },
      accepted: false,
    });
    expect(readFileSync(subject.systemctlCalls, "utf8").trim()).toBe(
      "show user@1234.service --property=ActiveState,SubState,Job,ControlGroup",
    );
    expect(readFileSync(subject.loginctlCalls, "utf8").trim()).toBe(
      "show-user kojo-shipped-evidence --property=Sessions,Linger,State",
    );
    expect(existsSync(subject.sleepCalls)).toBe(false);
  });

  it.each([
    {
      name: "manager probe error",
      options: { manager: "error" as const },
      changed: { managerStatus: 1, managerClassification: "probe-failed" },
    },
    {
      name: "manager probe timeout",
      options: { manager: "timeout" as const },
      changed: { managerStatus: 124, managerClassification: "probe-timed-out" },
    },
    {
      name: "login probe error",
      options: { login: "error" as const },
      changed: {
        loginStatus: 1,
        loginClassification: "probe-failed",
        loginUserPresent: null,
      },
    },
    {
      name: "login probe timeout",
      options: { login: "timeout" as const },
      changed: {
        loginStatus: 124,
        loginClassification: "probe-timed-out",
        loginUserPresent: null,
      },
    },
  ])("fails closed on a $name", async ({ options, changed }) => {
    const subject = predicateFixture(options);

    expect(await runHelper(subject, 1)).toBe(1);

    expect(JSON.parse(readFileSync(subject.final, "utf8"))).toMatchObject({
      attemptLimit: 1,
      observationCount: 1,
      actual: {
        classification: "logout-not-complete-within-bound",
        ...changed,
      },
      accepted: false,
    });
    expect(existsSync(subject.sleepCalls)).toBe(false);
    const timeoutCalls = readFileSync(subject.timeoutCalls, "utf8").trim().split("\n");
    expect(timeoutCalls).toHaveLength(2);
    expect(timeoutCalls.every((call) => call.startsWith("--signal=TERM --kill-after=1s 1s "))).toBe(
      true,
    );
  });

  it("accepts a fully removed user-manager cgroup", async () => {
    const subject = predicateFixture({ cgroup: "absent" });

    expect(await runHelper(subject, 1)).toBe(0);

    expect(JSON.parse(readFileSync(subject.final, "utf8"))).toMatchObject({
      attemptLimit: 1,
      observationCount: 1,
      actual: {
        classification: "logout-complete-within-bound",
        managerActiveState: "inactive",
        managerSubState: "dead",
        managerJobPresent: false,
        managerCgroupPopulated: false,
        managerCgroupState: "absent",
        loginClassification: "user-absent",
        loginUserPresent: false,
        endpointPresent: false,
        busPresent: false,
      },
      accepted: true,
    });
  });
});
