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
  readonly revision: {
    readonly declaredVersion: string;
    readonly fingerprint: string;
    readonly stableName: string;
    readonly workflowAbi: string;
  };
}

const decodeVersioned = (value: unknown) => {
  if (
    typeof value === "object" &&
    value !== null &&
    "encodingVersion" in value &&
    typeof value.encodingVersion === "number" &&
    "value" in value
  ) {
    if (value.encodingVersion !== 1) {
      return {
        schema: { status: "Unknown", version: value.encodingVersion } as const,
        value,
      };
    }
    return {
      schema: { status: "Known", version: 1 } as const,
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

interface CompatibilityFact {
  readonly reason?: string;
  readonly status: string;
}

const runtimeConfigurationCompatibilityFor = (run: InspectedRun): CompatibilityFact => {
  const latestBySubject = new Map<string, InspectedEvidence>();
  for (const event of run.evidence) {
    if (event.type.startsWith("RuntimeConfiguration.")) latestBySubject.set(event.subject, event);
  }
  const incompatibleSubjects = [...latestBySubject.values()]
    .filter(({ type }) => type === "RuntimeConfiguration.Incompatible")
    .map(({ subject }) => subject)
    .sort();
  if (incompatibleSubjects.length > 0) {
    return {
      reason: `Runtime configuration is incompatible for ${incompatibleSubjects.join(", ")}`,
      status: "Incompatible",
    };
  }
  return latestBySubject.size === 0
    ? run.runtimeConfigurationCompatibility
    : { status: "Compatible" };
};

const resumeCompatibilityFor = (run: InspectedRun, project: Project): CompatibilityFact => {
  if (run.state === "Completed" || run.state === "Discarded" || run.state === "Running") {
    return { status: "NotApplicable" };
  }
  if (project.registrationState !== "Enabled") {
    return {
      reason: `Project registration is ${project.registrationState}`,
      status: "Unavailable",
    };
  }
  if (project.availability.status === "Unavailable") {
    return {
      reason: project.availability.reasons[0]?.message ?? "Project source is unavailable",
      status: "Unavailable",
    };
  }
  const activeRevision = project.source?.revision?.workflows.find(
    ({ name }) => name === run.revision.stableName,
  );
  if (
    project.source?.revision !== null &&
    project.source !== null &&
    activeRevision === undefined
  ) {
    return {
      reason: `Developer Workflow ${run.revision.stableName} is not available in the active Project Source Revision`,
      status: "Incompatible",
    };
  }
  if (activeRevision === undefined) return run.resumeCompatibility;
  const compatible =
    activeRevision.version === run.revision.declaredVersion &&
    activeRevision.fingerprint === run.revision.fingerprint &&
    activeRevision.manifest.workflowAbi === run.revision.workflowAbi;
  if (!compatible) {
    return {
      reason: `The active Project source does not match the pinned revision of ${run.revision.stableName}`,
      status: "Incompatible",
    };
  }
  return { status: "Compatible" };
};

const resumeBlockerFor = (
  run: InspectedRun,
  project: Project,
  resumeCompatibility: CompatibilityFact,
  runtimeConfigurationCompatibility: CompatibilityFact,
): string | undefined => {
  if (project.registrationState !== "Enabled") {
    return `Project registration is ${project.registrationState}`;
  }
  if (project.availability.status === "Unavailable") {
    return project.availability.reasons[0]?.message ?? "Project source is unavailable";
  }
  const outcome = decodeVersioned(run.outcome).value;
  if (
    run.state === "Failed" &&
    typeof outcome === "object" &&
    outcome !== null &&
    "_tag" in outcome &&
    outcome._tag === "Defect"
  ) {
    return "The Workflow Run failed with a non-resumable Defect";
  }
  if (run.evidence.some(({ type }) => type === "Activity.Uncertain")) {
    return "An Uncertain Activity Outcome requires reconciliation";
  }
  if (runtimeConfigurationCompatibility.status === "Incompatible") {
    return runtimeConfigurationCompatibility.reason ?? "Runtime configuration is incompatible";
  }
  if (resumeCompatibility.status !== "Compatible") {
    return resumeCompatibility.reason ?? "Resume compatibility has not been established";
  }
  return undefined;
};

const actionsFor = (
  run: InspectedRun,
  project: Project,
  root: boolean,
  resumeCompatibility: CompatibilityFact,
  runtimeConfigurationCompatibility: CompatibilityFact,
) => {
  if (!root || run.state === "Completed" || run.state === "Discarded") return [];
  if (run.state === "Running") {
    return [
      { enabled: true, name: "suspend" },
      { enabled: true, name: "discard" },
    ];
  }
  const resumeBlocker = resumeBlockerFor(
    run,
    project,
    resumeCompatibility,
    runtimeConfigurationCompatibility,
  );
  return [
    {
      enabled: resumeBlocker === undefined,
      name: "resume",
      ...(resumeBlocker === undefined ? {} : { reason: resumeBlocker }),
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
  const runtimeConfigurationCompatibility = runtimeConfigurationCompatibilityFor(run);
  const resumeCompatibility = resumeCompatibilityFor(run, project);
  return {
    actions: actionsFor(run, project, root, resumeCompatibility, runtimeConfigurationCompatibility),
    attempts: run.attempts,
    children: run.children.map((child) => projectRun(child, project, false)),
    createdAt: run.createdAt,
    evidence,
    input: decodeVersioned(run.input).value,
    invocationKey: run.invocationKey ?? null,
    outcome: run.outcome === null ? null : decodeVersioned(run.outcome).value,
    parentRunId: run.parentRunId,
    project: projectSummary(project),
    projectId: run.projectId,
    resumeCompatibility,
    rootRunId: run.rootRunId,
    runId: run.runId,
    runtimeConfigurationCompatibility,
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
