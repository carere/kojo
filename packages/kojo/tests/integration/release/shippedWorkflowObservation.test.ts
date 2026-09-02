import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  observeShippedWorkflow,
  replaceFailedShippedWorkflowObservation,
} from "../../support/release/ShippedWorkflowObservation.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the shipped Workflow observation bound", () => {
  it("records a complete exact-row observation before it reports current", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-shipped-observation-"));
    roots.push(root);
    const output = JSON.stringify({
      observationVersion: 1,
      instanceId: "instance-id",
      dataIdentity: "data-identity",
      refreshAfterMillis: 10,
      workflows: [
        {
          projectId: "project-id",
          projectState: "available",
          factoryState: "available",
          refreshState: "current",
          workflowName: "review",
          availability: "available",
          currentRevisionId: "revision-id",
          currentPackageGraphId: "package-graph-id",
        },
      ],
    });

    const result = await observeShippedWorkflow({
      command: [process.execPath, "-e", `console.log(${JSON.stringify(output)})`],
      evidenceDirectory: root,
      projectId: "project-id",
      workflowName: "review",
      timeoutMillis: 1_000,
      commandTimeoutMillis: 250,
      hardKillAfterMillis: 50,
      finalizationReserveMillis: 50,
      delayMillis: 10,
      stabilityWindowMillis: 30,
    });

    expect(result.ready).toBe(true);
    const final = JSON.parse(
      readFileSync(join(root, "bounded-factory-refresh-observation-final.json"), "utf8"),
    );
    expect(final).toMatchObject({
      readiness: "current",
      noRepairReregisterRestartOrStart: true,
      finalAttempt: {
        exitCode: 0,
        readiness: { ready: true },
        stdout: `${output}\n`,
        stderr: "",
        stability: { accepted: true },
      },
    });
  });

  it("hard-kills a Workflow command that ignores TERM and writes final timeout evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-shipped-observation-"));
    roots.push(root);
    const fixture = new URL("../../fixtures/release/ignoreTermWorkflow.ts", import.meta.url)
      .pathname;
    const startedAt = Date.now();

    const result = await observeShippedWorkflow({
      command: [process.execPath, fixture],
      evidenceDirectory: root,
      projectId: "project-id",
      workflowName: "review",
      timeoutMillis: 700,
      commandTimeoutMillis: 250,
      hardKillAfterMillis: 50,
      finalizationReserveMillis: 50,
      delayMillis: 0,
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.ready).toBe(false);
    expect(result.elapsedMillis).toBeLessThan(1_000);
    const final = JSON.parse(
      readFileSync(join(root, "bounded-factory-refresh-observation-final.json"), "utf8"),
    ) as {
      readonly readiness: string;
      readonly lastAttempt: { readonly terminationSent: boolean; readonly hardKillSent: boolean };
    };
    expect(final).toMatchObject({
      readiness: "timed-out",
      lastAttempt: { terminationSent: true, hardKillSent: true },
    });
  });

  it("replaces a current final record when observer finalization fails before the summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-shipped-observation-"));
    roots.push(root);
    mkdirSync(join(root, "workflow-list.json"));
    const output = JSON.stringify({
      instanceId: "instance-id",
      dataIdentity: "data-identity",
      refreshAfterMillis: 10,
      workflows: [
        {
          projectId: "project-id",
          projectState: "available",
          factoryState: "available",
          refreshState: "current",
          workflowName: "review",
          availability: "available",
          currentRevisionId: "revision-id",
          currentPackageGraphId: "package-graph-id",
        },
      ],
    });

    await expect(
      observeShippedWorkflow({
        command: [process.execPath, "-e", `console.log(${JSON.stringify(output)})`],
        evidenceDirectory: root,
        projectId: "project-id",
        workflowName: "review",
        timeoutMillis: 1_000,
        commandTimeoutMillis: 250,
        hardKillAfterMillis: 50,
        finalizationReserveMillis: 50,
        stabilityWindowMillis: 0,
        delayMillis: 0,
      }),
    ).rejects.toThrow();
    const finalPath = join(root, "bounded-factory-refresh-observation-final.json");
    const summaryPath = join(root, "bounded-factory-refresh-observation.log");
    expect(JSON.parse(readFileSync(finalPath, "utf8"))).toMatchObject({ readiness: "current" });
    expect(existsSync(summaryPath)).toBe(false);

    replaceFailedShippedWorkflowObservation({
      evidenceDirectory: root,
      readiness: "observer-failed",
      observerExitCode: 1,
    });

    expect(JSON.parse(readFileSync(finalPath, "utf8"))).toMatchObject({
      readiness: "observer-failed",
      observerExitCode: 1,
      partialFinal: { readiness: "current" },
    });
    expect(readFileSync(summaryPath, "utf8")).toContain("FactoryRefreshReadiness=observer-failed");
  });
});
