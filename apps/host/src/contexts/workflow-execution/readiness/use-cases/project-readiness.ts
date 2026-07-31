import { createHash } from "node:crypto";
import type {
  ProjectCondition,
  ProjectIdentity,
  ProjectReadinessActionKey,
  ProjectReadinessAssessment,
  ProjectReadinessCapability,
  ProjectReadinessFinding,
  ProjectReadinessQueryResult,
  ProjectReadinessRepairResult,
  ProjectReadinessResource,
  ProjectSnapshot,
  ReadinessFindingKey,
  RequestKey,
} from "@kojo/control";
import type {
  ProjectDefinitionSnapshot,
  ProjectDefinitionValidation,
} from "@kojo/control/project-definition-validation";
import { Effect } from "effect";
import { ProjectIndexRepository } from "../../../workflow-authoring/projects/repositories/project-index-repository";
import { ProjectLayout } from "../../../workflow-authoring/projects/services/project-layout";
import { ProjectRepository } from "../../projects/repositories/project-repository";
import { ProjectRuntime } from "../../projects/services/project-runtime";
import {
  WorkflowBackend,
  workflowBackendReference,
} from "../../projects/services/workflow-backend";
import { WorkflowRunRepository } from "../../runs/repositories/workflow-run-repository";
import { WorkflowScheduleRepository } from "../../schedules/repositories/workflow-schedule-repository";

const capabilityOrder = [
  "project:inspect",
  "history:inspect",
  "runs:control",
  "runs:recover",
  "runs:start",
  "schedules:process",
  "repair:safe",
] as const satisfies ReadonlyArray<ProjectReadinessCapability>;

const observations = new Map<
  string,
  { readonly firstObservedAtMs: number; lastObservedAtMs: number }
>();

const stableJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") return JSON.stringify(String(value));
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
};

const revision = (value: unknown) =>
  createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24);

const projectResource = (project: ProjectSnapshot): ProjectReadinessResource => ({
  kind: "project",
  identity: project.identity,
});

const action = (
  key:
    | "layout.add-ignore-rule"
    | "project.assign-new-identity"
    | "project.replace-missing-data"
    | "store.retry-migration"
    | "readiness.refresh",
) => ({
  key,
  label:
    key === "layout.add-ignore-rule"
      ? "Add the /.kojo/ ignore rule"
      : key === "project.assign-new-identity"
        ? "Assign a new Project Identity"
        : key === "project.replace-missing-data"
          ? "Replace missing Project data"
          : key === "store.retry-migration"
            ? "Retry the Project database migration"
            : "Refresh readiness",
});

const finding = (input: {
  readonly code: ReadinessFindingKey;
  readonly affectedResource: ProjectReadinessResource;
  readonly blockedCapabilities: ReadonlyArray<ProjectReadinessCapability>;
  readonly dependents?: ReadonlyArray<ProjectReadinessResource>;
  readonly summary: string;
  readonly relevant?: ReadonlyArray<string>;
  readonly repairClass: ProjectReadinessFinding["repairClass"];
  readonly actions?: ProjectReadinessFinding["actions"];
}): ProjectReadinessFinding => {
  const key = `${input.code}:${revision(input.affectedResource)}`;
  const now = Date.now();
  const prior = observations.get(key);
  const observed = prior ?? { firstObservedAtMs: now, lastObservedAtMs: now };
  observed.lastObservedAtMs = now;
  observations.set(key, observed);
  return {
    key,
    code: input.code,
    affectedResource: input.affectedResource,
    blockedCapabilities: [...input.blockedCapabilities],
    dependents: [...(input.dependents ?? [])],
    summary: input.summary,
    relevant: [...(input.relevant ?? [])],
    repairClass: input.repairClass,
    actions: [...(input.actions ?? [action("readiness.refresh")])],
    firstObservedAtMs: observed.firstObservedAtMs,
    lastObservedAtMs: observed.lastObservedAtMs,
  };
};

const projectWideCapabilities = [
  "runs:recover",
  "runs:start",
  "schedules:process",
] as const satisfies ReadonlyArray<ProjectReadinessCapability>;

const newWorkCapabilities = [
  "runs:start",
  "schedules:process",
] as const satisfies ReadonlyArray<ProjectReadinessCapability>;

const workflowConflictCapabilities = [
  "runs:recover",
  "runs:start",
  "schedules:process",
] as const satisfies ReadonlyArray<ProjectReadinessCapability>;

const resourceForLayout = (
  project: ProjectSnapshot,
  code: ReadinessFindingKey,
): ProjectReadinessResource => {
  if (code.startsWith("store.")) return { kind: "store", identity: project.identity };
  if (code.startsWith("engine.")) return { kind: "engine", identity: project.identity };
  if (code.startsWith("configuration.") || code.startsWith("dependency.")) {
    return { kind: "configuration", identity: project.identity };
  }
  if (code.startsWith("project.identity")) return projectResource(project);
  return { kind: "layout", path: project.path };
};

const layoutActions = (code: ReadinessFindingKey) => {
  if (code === "layout.ignore-rule-missing") return [action("layout.add-ignore-rule")];
  if (code === "project.identity-duplicate") return [action("project.assign-new-identity")];
  if (code === "project.identity-missing" || code === "store.missing") {
    return [action("project.replace-missing-data")];
  }
  if (code === "store.migration-failed") return [action("store.retry-migration")];
  return [action("readiness.refresh")];
};

const definitionFindings = (
  project: ProjectSnapshot,
  definitions: ProjectDefinitionValidation,
  condition: ProjectCondition,
) => {
  if (definitions.ok) return [];
  return definitions.findings.map((source) => {
    const workflow = source.workflowKey;
    const affectedResource: ProjectReadinessResource =
      workflow === undefined
        ? { kind: "configuration", identity: project.identity }
        : { kind: "workflow", identity: project.identity, workflowKey: workflow };
    const blockedCapabilities =
      source.findingKey === "workflow.revision-conflict"
        ? workflowConflictCapabilities
        : condition === "limited"
          ? newWorkCapabilities
          : projectWideCapabilities;
    return finding({
      code: source.findingKey,
      affectedResource,
      // A live Runtime retains only its last accepted executable snapshot.
      // Invalid replacement source blocks new starts and schedule delivery,
      // while compatible existing work continues to be assessed per Run.
      // Cold activation has no executable source to retain, so it blocks
      // every execution-progress capability project-wide.
      blockedCapabilities,
      summary: source.message.replace(/\s*Run:\s*[^.]+\.?$/u, ""),
      ...(workflow === undefined ? {} : { relevant: [workflow] }),
      repairClass: "developer-action",
      actions: [action("readiness.refresh")],
      ...(condition === "limited" ? {} : { dependents: [projectResource(project)] }),
    });
  });
};

const conditionForFindings = (
  runtimeCondition: ProjectCondition,
  findings: ReadonlyArray<ProjectReadinessFinding>,
): ProjectCondition => {
  if (runtimeCondition === "needs-attention") return "needs-attention";
  if (findings.length === 0) return "ready";
  return "limited";
};

const capabilities = (findings: ReadonlyArray<ProjectReadinessFinding>) =>
  capabilityOrder.map((capability) => ({
    capability,
    available: !findings.some((item) => item.blockedCapabilities.includes(capability)),
    findingKeys: Array.from(
      new Set(
        findings
          .filter((item) => item.blockedCapabilities.includes(capability))
          .map((item) => item.code),
      ),
    ),
  }));

const layoutFinding = (project: ProjectSnapshot, code: ReadinessFindingKey, summary: string) =>
  finding({
    code,
    affectedResource: resourceForLayout(project, code),
    blockedCapabilities: projectWideCapabilities,
    summary,
    repairClass:
      code === "layout.ignore-rule-missing" || code === "store.migration-failed"
        ? "explicit"
        : "developer-action",
    actions: layoutActions(code),
  });

const layoutRepairs = (
  repairs: ReadonlyArray<{
    readonly code: "layout.permissions-tightened";
    readonly path: string;
    readonly summary: string;
  }>,
): ReadonlyArray<ProjectReadinessAssessment["repairs"][number]> =>
  repairs.map((repair) => ({
    code: repair.code,
    summary: repair.summary,
    affectedResource: { kind: "layout", path: repair.path },
  }));

const unavailableRunFindings = (
  project: ProjectSnapshot,
  activeRuns: ReadonlyArray<{
    readonly parentRunId: string | null;
    readonly runId: string;
    readonly workflowKey: string;
    readonly workflowRevision: string;
  }>,
  definitions: ProjectDefinitionSnapshot | undefined,
) => {
  const unavailable = activeRuns.filter(
    (run) =>
      !definitions?.workflows.some(
        (definition) =>
          definition.workflowKey === run.workflowKey &&
          definition.revision === run.workflowRevision,
      ),
  );
  const parentByRunId = new Map(activeRuns.map((run) => [run.runId, run.parentRunId]));
  const parentDependents = (runId: string) => {
    const dependents: Array<ProjectReadinessResource> = [];
    let parentId = parentByRunId.get(runId) ?? null;
    while (parentId !== null) {
      dependents.push({ kind: "run", identity: project.identity, runId: parentId });
      parentId = parentByRunId.get(parentId) ?? null;
    }
    return dependents;
  };
  return unavailable.map((run) =>
    finding({
      code: "workflow.revision-unavailable",
      affectedResource: { kind: "run", identity: project.identity, runId: run.runId },
      blockedCapabilities: ["runs:recover"],
      dependents: parentDependents(run.runId),
      summary: `Workflow Run ${run.runId} needs ${run.workflowKey}@${run.workflowRevision}, which is not available from current source.`,
      relevant: [run.workflowKey, run.workflowRevision],
      repairClass: "developer-action",
      actions: [action("readiness.refresh")],
    }),
  );
};

const unavailableScheduleFindings = (
  project: ProjectSnapshot,
  schedules: ReadonlyArray<{
    readonly condition: string;
    readonly enabledIntent: boolean;
    readonly scheduleKey: string;
  }>,
) =>
  schedules
    .filter((schedule) => schedule.enabledIntent && schedule.condition === "unavailable")
    .map((schedule) =>
      finding({
        code: "schedule.definition-unavailable",
        affectedResource: {
          kind: "schedule",
          identity: project.identity,
          scheduleKey: schedule.scheduleKey,
        },
        blockedCapabilities: ["schedules:process"],
        summary: `Enabled Workflow Schedule ${schedule.scheduleKey} has no compatible current definition.`,
        relevant: [schedule.scheduleKey],
        repairClass: "developer-action",
        actions: [action("readiness.refresh")],
      }),
    );

const missingEngineStateFindings = (
  project: ProjectSnapshot,
  activeRuns: ReadonlyArray<{
    readonly parentRunId: string | null;
    readonly runId: string;
    readonly workflowKey: string;
    readonly workflowRevision: string;
  }>,
  backend: WorkflowBackend["Service"],
) =>
  Effect.forEach(activeRuns, (run) => {
    if (typeof backend.observe !== "function") return Effect.succeed(undefined);
    return backend
      .observe(project, workflowBackendReference(run.workflowKey, run.workflowRevision, run.runId))
      .pipe(
        Effect.as(undefined),
        Effect.catchCause(() =>
          Effect.succeed(
            finding({
              code: "run.engine-state-missing",
              affectedResource: { kind: "run", identity: project.identity, runId: run.runId },
              blockedCapabilities: ["runs:recover"],
              dependents: (() => {
                const parentByRunId = new Map(
                  activeRuns.map((candidate) => [candidate.runId, candidate.parentRunId]),
                );
                const dependents: Array<ProjectReadinessResource> = [];
                let parentId = parentByRunId.get(run.runId) ?? null;
                while (parentId !== null) {
                  dependents.push({ kind: "run", identity: project.identity, runId: parentId });
                  parentId = parentByRunId.get(parentId) ?? null;
                }
                return dependents;
              })(),
              summary: `Workflow Engine state for Workflow Run ${run.runId} is unavailable.`,
              relevant: [run.workflowKey, run.workflowRevision],
              repairClass: "developer-action",
              actions: [action("readiness.refresh")],
            }),
          ),
        ),
      );
  }).pipe(Effect.map((values) => values.filter((value) => value !== undefined)));

const missingSandboxStateFindings = (
  project: ProjectSnapshot,
  activeRuns: ReadonlyArray<{
    readonly parentRunId: string | null;
    readonly runId: string;
  }>,
  backend: WorkflowBackend["Service"],
) =>
  Effect.forEach(activeRuns, (run) => {
    if (typeof backend.inspectSandboxState !== "function") return Effect.succeed([]);
    return backend.inspectSandboxState(project, run.runId).pipe(
      Effect.map((states) => {
        const parentByRunId = new Map(
          activeRuns.map((candidate) => [candidate.runId, candidate.parentRunId]),
        );
        const dependents: Array<ProjectReadinessResource> = [];
        let parentId = parentByRunId.get(run.runId) ?? null;
        while (parentId !== null) {
          dependents.push({ kind: "run", identity: project.identity, runId: parentId });
          parentId = parentByRunId.get(parentId) ?? null;
        }
        return states
          .filter((state) => !state.available)
          .map((state) =>
            finding({
              code: "sandbox.state-missing",
              affectedResource: {
                kind: "sandbox",
                identity: project.identity,
                runId: run.runId,
                sandboxKey: state.sandboxKey,
              },
              blockedCapabilities: ["runs:recover"],
              dependents,
              summary: `Required Sandbox state ${state.sandboxKey} for Workflow Run ${run.runId} is unavailable.`,
              relevant: [state.sandboxKey],
              repairClass: "developer-action",
              actions: [action("readiness.refresh")],
            }),
          );
      }),
      // An observation failure is not proof that a Sandbox is missing. The
      // next refresh remains the safe path rather than guessing a finding.
      Effect.catchCause(() => Effect.succeed([])),
    );
  }).pipe(Effect.map((values) => values.flat()));

const projectNotFound = (): ProjectReadinessQueryResult => ({
  ok: false,
  error: {
    code: "project-not-found",
    message: "Kojo Project was not found in the Project Index.",
    next: "Register the Project or choose a listed Project Identity.",
    findingKeys: [],
  },
});

const repairFailure = (
  requestKey: RequestKey,
  code: "stale-assessment" | "repair-not-available" | "repair-precondition-failed",
  message: string,
  next: string,
  assessment: ProjectReadinessAssessment,
): ProjectReadinessRepairResult => ({
  ok: false,
  requestKey,
  error: {
    code,
    message,
    next,
    findingKeys: assessment.findings.map((item) => item.code),
    assessment,
  },
});

/**
 * Builds one complete safe assessment. It deliberately continues with every
 * check that has a proven prerequisite, collecting findings rather than
 * returning the first layout or configuration failure.
 */
export const assessProjectReadiness = (
  identity: ProjectIdentity,
): Effect.Effect<
  ProjectReadinessQueryResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRepository
  | ProjectRuntime
  | WorkflowBackend
  | WorkflowRunRepository
  | WorkflowScheduleRepository
> =>
  Effect.gen(function* () {
    const index = yield* ProjectIndexRepository;
    const layout = yield* ProjectLayout;
    const projectRepository = yield* ProjectRepository;
    const runtime = yield* ProjectRuntime;
    const backend = yield* WorkflowBackend;
    const runs = yield* WorkflowRunRepository;
    const schedules = yield* WorkflowScheduleRepository;
    const indexState = yield* index.read;
    const indexed = indexState.projects.find((candidate) => candidate.identity === identity);
    if (indexed === undefined) return projectNotFound();

    let validation = yield* layout.validate(indexed.path);
    const automaticRepairs: Array<ProjectReadinessAssessment["repairs"][number]> = [];
    if (!validation.ok) {
      const candidate = validation.project ?? indexed;
      const artifactsRecreated = yield* layout.recreateArtifacts?.(candidate) ??
        Effect.succeed(false);
      if (artifactsRecreated) {
        automaticRepairs.push({
          code: "layout.artifacts-recreated",
          summary: "Kojo recreated the missing empty artifacts directory.",
          affectedResource: { kind: "layout", path: `${candidate.path}/.kojo/artifacts` },
        });
      }
      const activeRuns = yield* runs.activeRuns(candidate).pipe(
        Effect.map((value) => value),
        Effect.catchCause(() => Effect.succeed(undefined)),
      );
      const sandboxesRecreated =
        activeRuns !== undefined && activeRuns.length === 0
          ? yield* layout.recreateEmptySandboxes?.(candidate) ?? Effect.succeed(false)
          : false;
      if (sandboxesRecreated) {
        automaticRepairs.push({
          code: "layout.empty-sandboxes-recreated",
          summary:
            "Kojo recreated the missing empty sandboxes directory after confirming no non-final Run needs it.",
          affectedResource: { kind: "layout", path: `${candidate.path}/.kojo/sandboxes` },
        });
      }
      if (automaticRepairs.length > 0) validation = yield* layout.validate(indexed.path);
    }
    const project = validation.ok ? validation.project : (validation.project ?? indexed);
    const findings: Array<ProjectReadinessFinding> = [];
    const repairs: Array<ProjectReadinessAssessment["repairs"][number]> = [...automaticRepairs];
    let runtimeCondition: ProjectCondition = "needs-attention";

    if (!validation.ok) {
      const layoutFindings = validation.findings ?? [validation];
      findings.push(
        ...layoutFindings.map((item) => layoutFinding(project, item.findingKey, item.message)),
      );
      if (validation.definitions !== undefined) {
        findings.push(...definitionFindings(project, validation.definitions, "needs-attention"));
      }
      repairs.push(...layoutRepairs(validation.repairs ?? []));
    } else {
      const initialStoreCondition = yield* projectRepository.readiness(project);
      const initialBackendCondition = yield* backend.readiness(project);
      const backendFinding =
        (typeof backend.readinessFinding === "function"
          ? yield* backend.readinessFinding(project)
          : undefined) ?? "engine.ownership-unavailable";
      runtimeCondition = yield* runtime.readiness(indexed, project, validation.definitions);
      findings.push(...definitionFindings(project, validation.definitions, runtimeCondition));
      repairs.push(...layoutRepairs(validation.repairs ?? []));

      if (initialStoreCondition === "limited" && runtimeCondition === "ready") {
        repairs.push({
          code: "store.migrated",
          summary: "Kojo completed and verified a compatible Project database migration.",
          affectedResource: { kind: "store", identity: project.identity },
        });
      } else if (initialStoreCondition !== "ready") {
        findings.push(
          layoutFinding(
            project,
            initialStoreCondition === "limited"
              ? "store.migration-failed"
              : "store.integrity-failed",
            initialStoreCondition === "limited"
              ? "The Project database needs a compatible migration before execution can continue."
              : "The Project database could not be verified safely.",
          ),
        );
      }
      if (initialBackendCondition === "needs-attention") {
        findings.push(
          layoutFinding(
            project,
            backendFinding,
            "Kojo could not acquire safe Workflow Engine ownership for this Project.",
          ),
        );
      }

      if (initialStoreCondition === "ready") {
        const activeRuns = yield* runs
          .activeRuns(project)
          .pipe(Effect.catchCause(() => Effect.succeed([])));
        const executableSnapshot = validation.definitions.ok
          ? validation.definitions.snapshot
          : yield* runtime.definitions(project);
        findings.push(...unavailableRunFindings(project, activeRuns, executableSnapshot));
        findings.push(...(yield* missingEngineStateFindings(project, activeRuns, backend)));
        findings.push(...(yield* missingSandboxStateFindings(project, activeRuns, backend)));
        const currentSchedules = yield* schedules
          .list(project, { identity: project.identity, workflowKeys: [], conditions: [] })
          .pipe(Effect.catchCause(() => Effect.succeed([])));
        findings.push(...unavailableScheduleFindings(project, currentSchedules));
      }
    }

    const duplicatePaths = indexState.projects
      .filter((candidate) => candidate.identity === identity && candidate.path !== indexed.path)
      .map((candidate) => candidate.path);
    if (duplicatePaths.length > 0) {
      findings.push(
        finding({
          code: "project.identity-duplicate",
          affectedResource: projectResource(project),
          blockedCapabilities: projectWideCapabilities,
          dependents: duplicatePaths.map((path) => ({ kind: "project-path" as const, path })),
          summary: "This Project Identity appears at more than one indexed path.",
          relevant: [project.path, ...duplicatePaths],
          repairClass: "explicit",
          actions: [action("project.assign-new-identity")],
        }),
      );
    }

    const condition = conditionForFindings(runtimeCondition, findings);
    const capabilityResults = capabilities(findings);
    const assessment: ProjectReadinessAssessment = {
      project,
      revision: revision({
        project,
        condition,
        findings: findings.map((item) => ({
          code: item.code,
          affectedResource: item.affectedResource,
          blockedCapabilities: item.blockedCapabilities,
        })),
      }),
      assessedAtMs: Date.now(),
      condition,
      capabilities: capabilityResults,
      findings,
      repairs,
    };
    return { ok: true, assessment };
  });

/**
 * Rechecks the complete assessment before a mutation and assesses again after
 * it. Nothing accepts a repair solely because a client previously displayed a
 * finding, which prevents stale actions from replacing changed Project data.
 */
export const repairProjectReadiness = (input: {
  readonly identity: ProjectIdentity;
  readonly assessmentRevision: string;
  readonly action: ProjectReadinessActionKey;
  readonly requestKey: RequestKey;
}): Effect.Effect<
  ProjectReadinessRepairResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRepository
  | ProjectRuntime
  | WorkflowBackend
  | WorkflowRunRepository
  | WorkflowScheduleRepository
> =>
  Effect.gen(function* () {
    const current = yield* assessProjectReadiness(input.identity);
    if (!current.ok) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: current.error,
      };
    }
    if (current.assessment.revision !== input.assessmentRevision) {
      return repairFailure(
        input.requestKey,
        "stale-assessment",
        "Project Runtime Readiness changed before this repair request was accepted.",
        "Refresh readiness and retry the action shown for the current assessment.",
        current.assessment,
      );
    }
    if (
      input.action !== "readiness.refresh" &&
      !current.assessment.findings.some((item) =>
        item.actions.some((candidate) => candidate.key === input.action),
      )
    ) {
      return repairFailure(
        input.requestKey,
        "repair-not-available",
        "This repair action is not available for the current Project Runtime Readiness findings.",
        "Use a repair action shown by the current assessment, or refresh readiness.",
        current.assessment,
      );
    }

    const layout = yield* ProjectLayout;
    const repository = yield* ProjectRepository;
    const runtime = yield* ProjectRuntime;
    const index = yield* ProjectIndexRepository;
    let identity = input.identity;
    const project = current.assessment.project;
    let changed = input.action === "readiness.refresh";

    if (input.action === "layout.add-ignore-rule") {
      changed = (yield* layout.addIgnoreRule?.(project) ?? Effect.succeed(false)) === true;
    } else if (input.action === "project.replace-missing-data") {
      changed = (yield* layout.replaceMissingData?.(project) ?? Effect.succeed(false)) === true;
    } else if (input.action === "project.assign-new-identity") {
      const reassigned = yield* layout.assignNewIdentity?.(project) ?? Effect.succeed(undefined);
      if (reassigned !== undefined) {
        identity = reassigned.identity;
        changed = true;
        yield* index.update((state) =>
          Effect.succeed({
            state: {
              ...state,
              projects: state.projects.map((candidate) =>
                candidate.identity === input.identity && candidate.path === project.path
                  ? reassigned
                  : candidate,
              ),
            },
            result: undefined,
          }),
        );
      } else {
        changed = false;
      }
    } else if (input.action === "store.retry-migration") {
      yield* repository.retryMigration?.(project) ?? Effect.void;
      // Runtime activation repeats the compatibility checks, ownership
      // acquisition, migration, and postflight verification as one sequence.
      yield* runtime.readiness(project, project);
      changed = true;
    }

    if (!changed) {
      return repairFailure(
        input.requestKey,
        "repair-precondition-failed",
        "Kojo could not prove every safety precondition for this repair.",
        "Correct the Project manually, refresh readiness, and try again only if the action remains available.",
        current.assessment,
      );
    }

    const reassessed = yield* assessProjectReadiness(identity);
    if (!reassessed.ok) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: reassessed.error,
      };
    }
    const repairs =
      input.action === "store.retry-migration" && reassessed.assessment.condition === "ready"
        ? [
            {
              code: "store.migrated" as const,
              summary: "Kojo completed and verified a compatible Project database migration.",
              affectedResource: {
                kind: "store" as const,
                identity: reassessed.assessment.project.identity,
              },
            },
          ]
        : [];
    return {
      ok: true,
      requestKey: input.requestKey,
      assessment: { ...reassessed.assessment, repairs },
    };
  });
