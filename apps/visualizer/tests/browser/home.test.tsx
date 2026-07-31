import { ProjectIdentity, WorkflowRunId } from "@kojo/control";
import { Schema } from "effect";
import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { ColorModeProvider } from "../../src/contexts/preferences/services/color-mode";
import { HostOverview } from "../../src/contexts/workflow-execution/host/components/host-overview";
import { setLocale } from "../../src/i18n/runtime";

let dispose: VoidFunction | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

test("shows the Kojo starting point", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview />
      </ColorModeProvider>
    ),
    root,
  );

  await expect
    .element(page.getByRole("heading", { name: "The new Kojo starts here." }))
    .toBeVisible();
});

test("switches to the dark color mode", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview />
      </ColorModeProvider>
    ),
    root,
  );

  await page.getByRole("button", { name: "Dark" }).click();

  await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.style.colorScheme).toBe("dark");
});

test("shows Host connectivity and the authoritative empty Project state", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview
          loadOverview={() =>
            Promise.resolve({
              host: {
                protocol: { major: 1, minor: 1 },
                hostVersion: "0.1.0",
                capabilities: ["projects:list"],
              },
              projects: [],
              projectDefinitions: [],
              workflowRuns: [],
            })
          }
        />
      </ColorModeProvider>
    ),
    root,
  );

  await expect.element(page.getByText("Connected to Kojo Host 0.1.0")).toBeVisible();
  await expect.element(page.getByText("No Kojo Projects yet.")).toBeVisible();
});

test("shows accepted Workflow Definition snapshots from the Host", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000001",
  );
  const runId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000010");
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview
          loadOverview={() =>
            Promise.resolve({
              host: {
                protocol: { major: 1, minor: 2 },
                hostVersion: "0.1.0",
                capabilities: ["projects:list", "workflows:list"],
              },
              projects: [{ identity, path: "/projects/demo" }],
              projectDefinitions: [
                {
                  project: { identity, path: "/projects/demo" },
                  definitions: {
                    snapshotId: "snapshot",
                    workflows: [
                      {
                        workflowKey: "echo",
                        revision: "1",
                        inputSchemaFingerprint: "input",
                        successSchemaFingerprint: "success",
                        failureSchemaFingerprint: "failure",
                        sourceIdentity: "source",
                        sensitivity: { input: ["token"], success: [], failure: [] },
                        childWorkflowKeys: [],
                      },
                    ],
                  },
                },
              ],
              workflowRuns: [
                {
                  project: { identity, path: "/projects/demo" },
                  runs: [
                    {
                      runId,
                      workflowKey: "echo",
                      workflowRevision: "1",
                      state: "completed",
                      acceptedAtMs: 1,
                      engineConfirmedAtMs: 1,
                      updatedAtMs: 2,
                      finalizedAtMs: 2,
                      activitySummary: {
                        invocationAttempts: 1,
                        incompleteAttempts: 0,
                        retries: 0,
                        durableCompletions: 1,
                        replayReuses: 0,
                      },
                    },
                  ],
                },
              ],
            })
          }
        />
      </ColorModeProvider>
    ),
    root,
  );

  await expect.element(page.getByText("Accepted Workflow Definitions")).toBeVisible();
  await expect.element(page.getByText("echo 1")).toBeVisible();
  await expect.element(page.getByText("00000000-0000-7000-8000-000000000010")).toBeVisible();
  await expect.element(page.getByText("completed")).toBeVisible();
});
