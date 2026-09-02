import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type BoundRegistrationRequest,
  inspectRegisteredRevision,
} from "../../../../src/runner/main.ts";

const root = fileURLToPath(new URL("../../../fixtures/runner", import.meta.url));
const request = (revision: string): BoundRegistrationRequest => ({
  registrationVersion: 1,
  selectedProtocol: 1,
  daemonInstanceId: "daemon-1",
  runnerInstanceId: "runner-1",
  projectId: "project-1",
  boundProjectId: "project-1",
  revisionId: revision,
  packageGraphId: "b".repeat(64),
  boundPackageGraphId: "b".repeat(64),
  executionRoot: root,
  workflowName: "example",
  entrySource: "example.ts",
  payload: null,
  connectionSecret: "s".repeat(32),
});

describe("Project Runner handshake", () => {
  it("does not import Factory code before the Project and graph binding agrees", async () => {
    const state = globalThis as typeof globalThis & { __kojoRunnerImportCount?: number };
    state.__kojoRunnerImportCount = 0;
    await expect(
      inspectRegisteredRevision({ ...request("a".repeat(64)), boundProjectId: "project-other" }),
    ).rejects.toThrow("binding");
    expect(state.__kojoRunnerImportCount).toBe(0);

    const registered = await inspectRegisteredRevision(request("c".repeat(64)));
    expect(registered).toEqual({
      registrationVersion: 1,
      idempotencyKey: "null-payload",
      enginePayload: { value: null },
    });
    expect(state.__kojoRunnerImportCount).toBe(1);
  });

  it("refuses wrong protocol, graph, and scope before any Factory import", async () => {
    const state = globalThis as typeof globalThis & { __kojoRunnerImportCount?: number };
    for (const invalid of [
      { ...request("f".repeat(64)), selectedProtocol: 0 as 1 },
      { ...request("f".repeat(64)), boundPackageGraphId: "c".repeat(64) },
      { ...request("f".repeat(64)), entrySource: "../outside.ts" },
    ]) {
      state.__kojoRunnerImportCount = 0;
      await expect(inspectRegisteredRevision(invalid)).rejects.toThrow(/binding|escaped/);
      expect(state.__kojoRunnerImportCount).toBe(0);
    }
  });

  it("binds same-name registrations to their exact revision", async () => {
    const first = await inspectRegisteredRevision(request("d".repeat(64)));
    const second = await inspectRegisteredRevision(request("e".repeat(64)));
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.enginePayload).toEqual(second.enginePayload);
  });
});
