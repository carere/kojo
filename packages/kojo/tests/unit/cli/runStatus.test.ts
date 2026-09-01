import type { RunDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import { Runtime } from "effect";
import { describe, expect, it } from "vitest";
import { ClientExit } from "../../../src/cli/ClientExit.ts";
import { CommandFailed } from "../../../src/cli/CommandFailed.ts";
import {
  requestedRunExitCode,
  runStatusLine,
  runStatusRequest,
  validateRunStatusFlags,
} from "../../../src/cli/runStatus.ts";

const run = (state: RunDocument["state"]): RunDocument => ({
  runId: "run-one",
  projectId: "project-one",
  workflowName: "compile",
  revisionId: "a".repeat(64),
  packageGraphId: "b".repeat(64),
  state,
  admittedAt: "2026-09-01T00:00:00.000Z",
  phases: [],
});

describe("Daemon Run status CLI contract", () => {
  it("accepts status, wait, and unbounded follow observation modes", () => {
    expect(validateRunStatusFlags({ details: false, follow: false, wait: false })).toBeUndefined();
    expect(validateRunStatusFlags({ details: false, follow: false, wait: true })).toBe(60_000);
    expect(validateRunStatusFlags({ details: false, follow: true, wait: false })).toBeUndefined();
    expect(
      validateRunStatusFlags({ details: true, follow: true, wait: false, timeout: "250ms" }),
    ).toBe(250);
  });

  it("rejects observation conflicts and a timeout without follow or wait", () => {
    expect(() => validateRunStatusFlags({ details: false, follow: true, wait: true })).toThrow(
      "cannot be used together",
    );
    expect(() =>
      validateRunStatusFlags({
        details: false,
        follow: false,
        wait: false,
        timeout: "1s",
      }),
    ).toThrow("only with --follow or --wait");
    expect(() =>
      validateRunStatusFlags({ details: false, follow: false, wait: true, timeout: "0s" }),
    ).toThrow("positive");
  });

  it("writes one versioned object per JSON snapshot without the payload", () => {
    const line = runStatusLine(run("executing"), true);
    expect(JSON.parse(line)).toEqual({ formatVersion: 1, run: run("executing") });
    expect(line).not.toContain("payload");
    expect(`${line}\n${runStatusLine(run("succeeded"), true)}`.split("\n")).toHaveLength(2);
  });

  it("adds recorded timing and Phase identity only to detailed text", () => {
    const subject = {
      ...run("succeeded"),
      startedAt: "2026-09-01T00:00:01.000Z",
      finishedAt: "2026-09-01T00:00:02.000Z",
      phases: [
        {
          phasePath: "compile",
          attempt: 1,
          kind: "code" as const,
          outcome: "succeeded" as const,
          description: "Compile",
          startedAt: "2026-09-01T00:00:01.000Z",
          endedAt: "2026-09-01T00:00:02.000Z",
          result: null,
        },
      ],
    };
    expect(runStatusLine(subject, false)).not.toContain("Phase=compile");
    expect(runStatusLine(subject, false, true)).toContain("Phase=compile#1:code:succeeded");
  });

  it("states why exact pinned content is held and gives the operator remedy", () => {
    const subject = {
      ...run("held"),
      queueReason: "pinned-content" as const,
      executionFault: {
        code: "RETAINED_CONTENT_CORRUPT" as const,
        detail: "the pinned package file does not match its retained hash",
        remedy: "Restore the exact retained package bytes.",
      },
    };
    expect(runStatusLine(subject, false)).toContain("Fault=RETAINED_CONTENT_CORRUPT");
    expect(runStatusLine(subject, false)).toContain("Restore the exact retained package bytes.");
  });

  it("keeps inspection successful and maps a requested terminal failure to exit 1", () => {
    expect(requestedRunExitCode(run("failed"), false)).toBe(0);
    expect(requestedRunExitCode(run("failed"), true)).toBe(1);
    expect(requestedRunExitCode(run("succeeded"), true)).toBe(0);
    expect(requestedRunExitCode(run("cancelled"), true)).toBe(1);
  });

  it("shows cancellation intent, sibling recovery, and cleanup as separate facts", () => {
    const subject: RunDocument = {
      ...run("executing"),
      cancellation: {
        state: "requested",
        source: "forced-workflow-stop",
        requestedAt: "2026-09-01T00:00:01.000Z",
        targetSetId: "target-one",
      },
      recovery: {
        state: "interrupted-sibling",
        interruptedAt: "2026-09-01T00:00:02.000Z",
        detail: "same identity and pinned revision retained",
      },
      cleanup: { state: "pending" },
    };
    const line = runStatusLine(subject, false);
    expect(line).toContain("Cancellation=requested:forced-workflow-stop");
    expect(line).toContain(
      "Recovery=interrupted-sibling:same identity and pinned revision retained",
    );
    expect(line).toContain("Cleanup=pending");
  });

  it("maps API faults to 1 and interruption to 130 without a server mutation", () => {
    const apiFault = new CommandFailed({ message: "the Daemon refused the read" });
    const interrupted = new ClientExit({ code: 130, message: "Run observation was interrupted" });
    expect(apiFault[Runtime.errorExitCode]).toBe(1);
    expect(interrupted[Runtime.errorExitCode]).toBe(130);
    expect(runStatusRequest("run/one")).toEqual({
      method: "GET",
      path: "/api/v1/runs/run%2Fone",
    });
  });
});
