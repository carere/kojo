import type { InspectorRun, InspectorRunSummary } from "./types";

const readJson = async <A>(response: Response): Promise<A> => {
  if (!response.ok) throw new Error(`System Process returned ${response.status}`);
  return (await response.json()) as A;
};

export const listInspectorRuns = async (includeArchived: boolean) =>
  (
    await readJson<{
      readonly runs: ReadonlyArray<InspectorRunSummary>;
      readonly schemaVersion: 1;
    }>(
      await fetch(
        includeArchived ? "/api/inspector/runs?includeArchived=true" : "/api/inspector/runs",
      ),
    )
  ).runs;

export const inspectWorkflowRun = async (runId: string) =>
  (
    await readJson<{ readonly run: InspectorRun; readonly schemaVersion: 1 }>(
      await fetch(`/api/inspector/runs/${encodeURIComponent(runId)}`),
    )
  ).run;
