import { describe, expect, it } from "vitest";
import { daemonStatusLines, plannedLifecycleResume } from "../../../src/cli/daemon.ts";
import { InMemoryLifecycleJournalRepository } from "../../../src/contexts/daemon/adapters/InMemoryLifecycleJournalRepository.ts";

describe("daemon status text", () => {
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
