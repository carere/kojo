import type { Project } from "./projects";
import type { SystemStore, WorkflowRunState } from "./storage";
import type { makeWorkflowRunService } from "./workflow-runs";

type WorkflowRuns = ReturnType<typeof makeWorkflowRunService>;

export interface InspectorFilters {
  readonly includeArchived?: boolean;
  readonly projectId?: string;
  readonly state?: WorkflowRunState;
  readonly workflowName?: string;
}

interface InspectedEvidence {
  readonly artifacts: ReadonlyArray<{
    readonly availability: "Available" | "Unavailable";
    readonly byteLength: number;
    readonly fingerprint: string;
    readonly mediaType: string;
    readonly name: string;
  }>;
  readonly attempt: number;
  readonly causationId: string | null;
  readonly details: unknown;
  readonly eventId: string;
  readonly parentEventId: string | null;
  readonly recordedAt: string;
  readonly sequence: number;
  readonly subject: string;
  readonly type: string;
}

interface InspectedRun {
  readonly attempts: ReadonlyArray<{
    readonly finishedAt: string | null;
    readonly number: number;
    readonly startedAt: string;
    readonly state: WorkflowRunState;
  }>;
  readonly children: ReadonlyArray<InspectedRun>;
  readonly createdAt: string;
  readonly evidence: ReadonlyArray<InspectedEvidence>;
  readonly input: unknown;
  readonly invocationKey?: string | null;
  readonly outcome: unknown;
  readonly parentRunId: string | null;
  readonly projectId: string;
  readonly resumeCompatibility: { readonly status: string };
  readonly rootRunId: string;
  readonly runId: string;
  readonly runtimeConfigurationCompatibility: { readonly status: string };
  readonly state: WorkflowRunState;
  readonly revision: { readonly stableName: string };
}

const decodeVersioned = (value: unknown) => {
  if (
    typeof value === "object" &&
    value !== null &&
    "encodingVersion" in value &&
    typeof value.encodingVersion === "number" &&
    "value" in value
  ) {
    return {
      schema:
        value.encodingVersion === 1
          ? ({ status: "Known", version: 1 } as const)
          : ({ status: "Unknown", version: value.encodingVersion } as const),
      value: value.value,
    };
  }
  return { schema: { status: "Unknown", version: 0 } as const, value };
};

const projectSummary = (project: Project) => ({
  availability:
    project.availability.status === "Available"
      ? ({ status: "Available" } as const)
      : {
          reason: project.availability.reasons[0]?.message ?? "Project availability is unavailable",
          status: "Unavailable" as const,
        },
  displayName: project.metadata.folderName,
  id: project.id,
  registrationState: project.registrationState,
});

const actionsFor = (run: InspectedRun, root: boolean, project: Project) => {
  if (!root || run.state === "Completed" || run.state === "Discarded") return [];
  if (run.state === "Running") {
    return [
      { enabled: true, name: "suspend" },
      { enabled: true, name: "discard" },
    ];
  }
  const availabilityReason =
    project.availability.status === "Unavailable"
      ? (project.availability.reasons[0]?.message ?? "Project source is unavailable")
      : undefined;
  return [
    {
      enabled: availabilityReason === undefined,
      name: "resume",
      ...(availabilityReason === undefined ? {} : { reason: availabilityReason }),
    },
    { enabled: true, name: "discard" },
  ];
};

const projectRun = (run: InspectedRun, project: Project, root = true): unknown => {
  const evidence = run.evidence.map((event) => {
    const decoded = decodeVersioned(event.details);
    return {
      ...event,
      artifacts: event.artifacts,
      details: decoded.value,
      schema: decoded.schema,
    };
  });
  const resumeCompatibility =
    run.state === "Completed" || run.state === "Discarded" || run.state === "Running"
      ? ({ status: "NotApplicable" } as const)
      : project.availability.status === "Unavailable"
        ? {
            reason: project.availability.reasons[0]?.message ?? "Project source is unavailable",
            status: "Unavailable" as const,
          }
        : run.resumeCompatibility;
  return {
    actions: actionsFor(run, root, project),
    attempts: run.attempts,
    children: run.children.map((child) => projectRun(child, project, false)),
    createdAt: run.createdAt,
    evidence,
    input: decodeVersioned(run.input).value,
    invocationKey: run.invocationKey ?? null,
    outcome: run.outcome === null ? null : decodeVersioned(run.outcome).value,
    parentRunId: run.parentRunId,
    projectId: run.projectId,
    resumeCompatibility,
    rootRunId: run.rootRunId,
    runId: run.runId,
    runtimeConfigurationCompatibility: run.runtimeConfigurationCompatibility,
    state: run.state,
    workflowName: run.revision.stableName,
  };
};

export const makeInspectorService = (
  store: SystemStore,
  workflowRuns: WorkflowRuns,
  listProjects: () => Promise<ReadonlyArray<Project>>,
) => ({
  inspect: async (runId: string) => {
    const raw = workflowRuns.inspectTree(runId) as InspectedRun | undefined;
    if (raw === undefined) return undefined;
    const project = (await listProjects()).find(({ id }) => id === raw.projectId);
    if (project === undefined) return undefined;
    return projectRun(raw, project);
  },
  list: async (filters: InspectorFilters = {}) => {
    const availableProjects = await listProjects();
    const projects = new Map(availableProjects.map((project) => [project.id, project]));
    return store.workflowRuns
      .list()
      .filter((run) => run.runId === run.rootRunId)
      .filter((run) => {
        const project = projects.get(run.projectId);
        if (project === undefined) return false;
        const workflowName = store.workflowRuns.find(run.runId)?.revision.stableName;
        return (
          (filters.includeArchived === true || project.registrationState !== "Archived") &&
          (filters.projectId === undefined || run.projectId === filters.projectId) &&
          (filters.state === undefined || run.state === filters.state) &&
          (filters.workflowName === undefined || workflowName === filters.workflowName)
        );
      })
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId),
      )
      .map((run) => {
        const project = projects.get(run.projectId);
        const stored = store.workflowRuns.find(run.runId);
        if (project === undefined || stored === undefined) {
          throw new Error(`Workflow Run ${run.runId} has incomplete inspection data`);
        }
        return {
          attempt: stored.attempts.at(-1)?.number ?? 1,
          createdAt: run.createdAt,
          project: projectSummary(project),
          runId: run.runId,
          state: run.state,
          workflowName: stored.revision.stableName,
        };
      });
  },
});
