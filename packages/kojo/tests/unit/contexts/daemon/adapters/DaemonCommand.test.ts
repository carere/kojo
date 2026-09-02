import { describe, it as effectIt, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { daemonStatusConfiguration } from "../../../../../src/contexts/daemon/adapters/DaemonCommand.ts";
import {
  daemonStatusLines,
  upgradeStatusLines,
} from "../../../../../src/contexts/daemon/adapters/DaemonCommandPresentation.ts";
import { InMemoryLifecycleJournalRepository } from "../../../../../src/contexts/daemon/adapters/InMemoryLifecycleJournalRepository.ts";
import { decodeUpgradeCheckResult } from "../../../../../src/contexts/daemon/models/ManagedUpgrade.ts";
import { plannedLifecycleResume } from "../../../../../src/contexts/daemon/use-cases/resumeLifecycleOperation.ts";

describe("daemon status text", () => {
  effectIt.effect("keeps detailed status offline when the stopped Daemon has no endpoint", () =>
    Effect.gen(function* () {
      let requests = 0;
      const configuration = yield* daemonStatusConfiguration(true, false, () => {
        requests += 1;
        return Effect.fail("the Daemon is not ready; run `kojo daemon status`");
      });

      expect(Option.isNone(configuration)).toBe(true);
      expect(requests).toBe(0);
    }),
  );

  effectIt.effect("reads configuration details when the Daemon is ready", () =>
    Effect.gen(function* () {
      const configuration = yield* daemonStatusConfiguration(true, true, () =>
        Effect.succeed({ scope: "daemon" }),
      );

      expect(Option.getOrUndefined(configuration)).toEqual({ scope: "daemon" });
    }),
  );

  it("keeps installation, automatic start, process, responsiveness, and readiness separate", () => {
    const lines = daemonStatusLines({
      installed: true,
      managedCli: "/managed/bin/kojo",
      automaticStart: "disabled",
      manager: "loaded",
      process: "running",
      responsiveness: "unresponsive",
      ready: false,
      loginLifetime: "macOS GUI login session",
      logoutPersistence: "unsupported",
    });

    expect(lines).toEqual([
      "Installed: yes.",
      "Managed CLI: /managed/bin/kojo.",
      "Automatic start: disabled.",
      "Manager: loaded.",
      "Process: running.",
      "Responsive: unresponsive.",
      "Ready: no.",
      "Supported lifetime: macOS GUI login session.",
      "Keep running after logout: unsupported.",
    ]);
  });

  it("distinguishes a staged candidate, compatibility refusal, existing fault, and exact approval", () => {
    const base = {
      formatVersion: 1 as const,
      candidateReleaseId: "candidate",
      sourceReleaseId: "source",
      dataIdentity: "data",
      retainedSetHash: "a".repeat(64),
      checkedAt: "2026-09-01T12:00:00.000Z",
      checked: {
        currentWorkflows: 1,
        retainedRuns: 2,
        terminalRuns: 1,
        validations: 1,
        readers: 1,
        revisions: 1,
      },
      compatibilityFaults: [],
      existingFaults: [],
      rollbackApproval: "not-required" as const,
      remedy: "Candidate is checked",
    };
    expect(upgradeStatusLines({ ...base, outcome: "staged" })).toContain(
      "Managed upgrade check: staged.",
    );
    expect(
      upgradeStatusLines({
        ...base,
        outcome: "incompatible",
        compatibilityFaults: [
          {
            code: "RUNNER_PROTOCOL_REGRESSION",
            revisionId: "revision",
            affectedScope: ["retained-run:run"],
            detail: "protocol is removed",
            remedy: "Use a compatible candidate",
          },
        ],
      }).join("\n"),
    ).toContain("Compatibility RUNNER_PROTOCOL_REGRESSION for revision");
    expect(
      upgradeStatusLines({
        ...base,
        outcome: "existing-fault",
        existingFaults: [
          {
            code: "CONTENT_CORRUPT",
            revisionId: "revision",
            affectedScope: ["retained-run:run"],
            detail: "bytes differ",
            remedy: "Restore exact bytes",
          },
        ],
      }).join("\n"),
    ).toContain("Existing CONTENT_CORRUPT for revision");
    expect(
      upgradeStatusLines({
        ...base,
        outcome: "approval-required",
        rollbackApproval: "required",
        plan: {
          formatVersion: 1,
          planId: "plan",
          kind: "approve-no-rollback",
          dataIdentity: "data",
          candidateReleaseId: "candidate",
          requestHash: "b".repeat(64),
          affectedScope: ["daemon-data"],
          expectedStateVersion: "a".repeat(64),
          issuedAt: "2026-09-01T12:00:00.000Z",
          expiresAt: "2026-09-01T12:10:00.000Z",
          migration: {
            fromDataFormat: 1,
            toDataFormat: 2,
            description: "Rewrite receipt rows",
          },
        },
      }).join("\n"),
    ).toContain("Migration consequence: Rewrite receipt rows");
  });

  it("refuses extra fields in a private managed upgrade response", () => {
    expect(() =>
      decodeUpgradeCheckResult({
        report: {
          formatVersion: 1,
          outcome: "staged",
          candidateReleaseId: "candidate",
          sourceReleaseId: "source",
          dataIdentity: "data",
          retainedSetHash: "a".repeat(64),
          checkedAt: "2026-09-01T12:00:00.000Z",
          checked: {
            currentWorkflows: 0,
            retainedRuns: 0,
            terminalRuns: 0,
            validations: 0,
            readers: 0,
            revisions: 0,
          },
          compatibilityFaults: [],
          existingFaults: [],
          rollbackApproval: "not-required",
          remedy: "Candidate is checked.",
          untrusted: true,
        },
      }),
    ).toThrow("invalid managed upgrade report");
  });
});

describe("planned lifecycle command resume", () => {
  it("reuses the same pending operation after the observing CLI times out", () => {
    const journal = new InMemoryLifecycleJournalRepository();
    let operation = journal.begin({
      operationId: "operation-1",
      dataIdentity: "data-1",
      originalRequestHash: "a".repeat(64),
      kind: "stop",
      sourceReleaseId: "kojo-0.1.0-bun-1.4.0",
      startedAt: "2026-09-01T10:00:00.000Z",
    });
    operation = journal.advance({
      operationId: operation.operationId,
      expectedRevision: operation.stageRevision,
      stage: "draining",
      updatedAt: "2026-09-01T10:00:01.000Z",
    });

    expect(plannedLifecycleResume(journal, "stop")?.operationId).toBe(operation.operationId);
    expect(plannedLifecycleResume(journal, "stop", operation.operationId)?.operationId).toBe(
      operation.operationId,
    );
  });
});
