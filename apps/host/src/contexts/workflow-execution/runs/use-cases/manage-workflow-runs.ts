import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  ProjectIdentity,
  ProjectSnapshot,
  RequestKey,
  WorkflowRunListInput,
  WorkflowRunListResult,
  WorkflowRunMutationResult,
  WorkflowRunOperationError,
  WorkflowRunQueryResult,
  WorkflowRunSnapshot,
  WorkflowRunStartResult,
} from "@kojo/control";
import type { WorkflowDefinitionSnapshot } from "@kojo/control/project-definition-validation";
import { type AnyWorkflowDefinition, WorkflowOperations } from "@kojo/workflow";
import { Effect, Option, Schema } from "effect";
import { ProjectIndexRepository } from "../../../workflow-authoring/projects/repositories/project-index-repository";
import { loadExecutableWorkflowDefinitions } from "../../../workflow-authoring/projects/services/project-executable-definition-loader";
import { ProjectLayout } from "../../../workflow-authoring/projects/services/project-layout";
import { HOST_INFORMATION } from "../../control/models/host-information";
import { HostDiagnosticLogger } from "../../control/services/host-diagnostic-logger";
import { ProjectRuntime } from "../../projects/services/project-runtime";
import {
  type AnyLocalWorkflowDefinition,
  WorkflowBackend,
  type WorkflowBackendState,
  workflowBackendReference,
} from "../../projects/services/workflow-backend";
import { maskPayload } from "../models/sensitivity-map";
import {
  type StoredWorkflowRunSnapshot,
  type WorkflowRunOutcome,
  WorkflowRunRepository,
} from "../repositories/workflow-run-repository";

const stableJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Workflow input is not JSON encodable");
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};

const hash = (value: string) => createHash("sha256").update(value).digest();

const error = (
  code: WorkflowRunOperationError["code"],
  message: string,
  next: string,
  affectedResource: WorkflowRunOperationError["affectedResource"],
  findingKeys: WorkflowRunOperationError["findingKeys"] = [],
  currentWorkflow?: WorkflowDefinitionSnapshot,
): WorkflowRunOperationError => ({
  code,
  message,
  next,
  affectedResource,
  findingKeys,
  ...(currentWorkflow === undefined ? {} : { currentWorkflow }),
});

const missingProject = (identity: ProjectIdentity) =>
  error(
    "project-not-found",
    "Kojo Project was not found in the Project Index.",
    "Register the Project or choose a listed Project Identity.",
    { kind: "project", identity },
  );

const projectLayoutError = (identity: ProjectIdentity, message: string, findingKey: string) =>
  error(
    "project-layout-invalid",
    message,
    "Correct the Project layout and retry.",
    { kind: "project", identity },
    [findingKey as never],
  );

const asLocalDefinition = (definition: AnyWorkflowDefinition): AnyLocalWorkflowDefinition => ({
  workflowKey: definition.workflowKey,
  revision: definition.revision,
  inputSchema: definition.inputSchema,
  successSchema: definition.successSchema,
  failureSchema: definition.failureSchema,
  execute: (input, operations) =>
    definition.handler(input).pipe(Effect.provideService(WorkflowOperations, operations)),
});

const maskedWorkflowRun = (stored: StoredWorkflowRunSnapshot): WorkflowRunSnapshot => ({
  ...stored.run,
  startSnapshot: maskPayload(
    stored.run.startSnapshot,
    stored.startSnapshotSensitivityMap,
  ) as WorkflowRunSnapshot["startSnapshot"],
  outcome:
    stored.run.outcome === null
      ? null
      : (maskPayload(
          stored.run.outcome,
          stored.outcomeSensitivityMap,
        ) as WorkflowRunSnapshot["outcome"]),
});

const recordOutcome = (
  repository: WorkflowRunRepository["Service"],
  project: ProjectSnapshot,
  runId: string,
  state: WorkflowBackendState,
  definition: AnyWorkflowDefinition,
) =>
  Effect.gen(function* () {
    let outcome: WorkflowRunOutcome;
    if (state._tag === "Completed") {
      try {
        const successSchema = definition.successSchema as typeof Schema.Unknown;
        const encoded = Schema.encodeSync(successSchema)(state.result);
        outcome = {
          kind: "completed",
          sensitivityPaths: definition.sensitivity?.success ?? [],
          value: encoded,
        };
      } catch {
        outcome = { kind: "failed", sensitivityPaths: definition.sensitivity?.failure ?? [] };
      }
    } else {
      outcome = { kind: "failed", sensitivityPaths: definition.sensitivity?.failure ?? [] };
    }
    yield* repository.recordOutcome(project, runId, outcome, Date.now());
  });

const observeRun = (
  backend: WorkflowBackend["Service"],
  repository: WorkflowRunRepository["Service"],
  project: ProjectSnapshot,
  definition: AnyWorkflowDefinition,
  runId: string,
) =>
  Effect.gen(function* () {
    const reference = workflowBackendReference(definition.workflowKey, definition.revision, runId);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const state = yield* backend.observe(project, reference).pipe(
        Effect.map(Option.some),
        Effect.catchCause(() => Effect.succeed(Option.none())),
      );
      if (Option.isNone(state)) break;
      if (state.value._tag === "Pending") {
        yield* Effect.sleep("10 millis");
        continue;
      }
      if (state.value._tag === "Waiting") {
        yield* repository.recordSuspension(project, runId, state.value.suspension, Date.now());
        break;
      }
      yield* recordOutcome(repository, project, runId, state.value, definition);
      break;
    }
  });

const reconcileRun = (
  backend: WorkflowBackend["Service"],
  repository: WorkflowRunRepository["Service"],
  project: ProjectSnapshot,
  definition: AnyWorkflowDefinition,
  runId: string,
) =>
  Effect.gen(function* () {
    const pending = yield* repository.pendingSubmissions(project, runId);
    for (const submission of pending) {
      if (
        submission.workflowKey !== definition.workflowKey ||
        submission.workflowRevision !== definition.revision
      ) {
        continue;
      }
      const reference = yield* backend
        .submit(project, {
          workflowKey: submission.workflowKey,
          workflowRevision: submission.workflowRevision,
          runId: submission.runId,
          input: submission.input,
        })
        .pipe(
          Effect.map(Option.some),
          Effect.catchCause(() => Effect.succeed(Option.none())),
        );
      if (Option.isNone(reference)) continue;
      yield* repository.confirmSubmission(project, submission.runId, Date.now());
      yield* observeRun(backend, repository, project, definition, submission.runId);
    }
  });

const emitReconciliationDiagnostic = (project: ProjectSnapshot, runId: string) =>
  Effect.gen(function* () {
    const logger = yield* HostDiagnosticLogger;
    if (logger.hostIdentity === undefined) return;
    yield* logger
      .emit({
        eventVersion: 1,
        eventKind: "workflow-run.reconciliation.completed",
        hostIdentity: logger.hostIdentity,
        operation: "ReconcileWorkflowRun",
        outcome: "success",
        durationMs: 0,
        hostVersion: HOST_INFORMATION.hostVersion,
        protocolMajor: HOST_INFORMATION.protocol.major,
        protocolMinor: HOST_INFORMATION.protocol.minor,
        projectIdentity: project.identity,
        runId,
        timestamp: new Date().toISOString(),
      })
      .pipe(Effect.ignore);
  });

interface ResolvedProject {
  readonly indexed: ProjectSnapshot;
  readonly project: ProjectSnapshot;
}

const resolveProject = (
  identity: ProjectIdentity,
): Effect.Effect<
  ResolvedProject | WorkflowRunOperationError,
  never,
  ProjectIndexRepository | ProjectLayout
> =>
  Effect.gen(function* () {
    const index = yield* ProjectIndexRepository;
    const layout = yield* ProjectLayout;
    const indexed = (yield* index.read).projects.find((project) => project.identity === identity);
    if (indexed === undefined) return missingProject(identity);
    const validation = yield* layout.validate(indexed.path);
    return validation.ok
      ? { indexed, project: validation.project }
      : projectLayoutError(identity, validation.message, validation.findingKey);
  });

const reconcilePendingWorkflowRuns = (
  resolved: ResolvedProject,
): Effect.Effect<
  void,
  never,
  ProjectLayout | ProjectRuntime | WorkflowBackend | WorkflowRunRepository | HostDiagnosticLogger
> =>
  Effect.gen(function* () {
    const layout = yield* ProjectLayout;
    const runtime = yield* ProjectRuntime;
    const backend = yield* WorkflowBackend;
    const repository = yield* WorkflowRunRepository;
    const validation = yield* layout.validate(resolved.indexed.path);
    if (!validation.ok || !validation.definitions.ok) return;
    const definitions = yield* runtime.acceptDefinitions(
      validation.project,
      validation.definitions,
    );
    if (
      definitions === undefined ||
      (yield* runtime.readiness(resolved.indexed, validation.project, validation.definitions)) !==
        "ready"
    ) {
      return;
    }
    const executable = yield* Effect.promise(() =>
      loadExecutableWorkflowDefinitions(
        join(validation.project.path, "kojo.config.ts"),
        definitions,
      ),
    ).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    if (executable === undefined) return;
    yield* runtime.coordinateLifecycle(
      validation.project,
      Effect.gen(function* () {
        yield* backend.register(validation.project, executable.map(asLocalDefinition));
        const activeRuns = yield* repository.activeRuns(validation.project);
        for (const activeRun of activeRuns) {
          const definition = executable.find(
            (candidate) =>
              candidate.workflowKey === activeRun.workflowKey &&
              candidate.revision === activeRun.workflowRevision,
          );
          if (definition !== undefined) {
            yield* reconcileRun(
              backend,
              repository,
              validation.project,
              definition,
              activeRun.runId,
            );
            if (activeRun.state === "suspended" && backend.rehydrate !== undefined) {
              yield* backend
                .rehydrate(
                  validation.project,
                  workflowBackendReference(
                    definition.workflowKey,
                    definition.revision,
                    activeRun.runId,
                  ),
                )
                .pipe(Effect.catchCause(() => Effect.void));
            }
            yield* observeRun(backend, repository, validation.project, definition, activeRun.runId);
          }
        }
      }),
    );
    for (const activeRun of yield* repository.activeRuns(validation.project)) {
      if (
        executable.some(
          (candidate) =>
            candidate.workflowKey === activeRun.workflowKey &&
            candidate.revision === activeRun.workflowRevision,
        )
      ) {
        yield* emitReconciliationDiagnostic(validation.project, activeRun.runId);
      }
    }
  }).pipe(Effect.catchCause(() => Effect.void));

export const startWorkflowRun = (input: {
  readonly identity: ProjectIdentity;
  readonly workflowKey: string;
  readonly workflowRevision: string;
  readonly input: unknown;
  readonly requestKey: RequestKey;
}): Effect.Effect<
  WorkflowRunStartResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | WorkflowBackend
  | WorkflowRunRepository
  | HostDiagnosticLogger
> =>
  Effect.gen(function* () {
    const index = yield* ProjectIndexRepository;
    const layout = yield* ProjectLayout;
    const runtime = yield* ProjectRuntime;
    const backend = yield* WorkflowBackend;
    const repository = yield* WorkflowRunRepository;
    const indexed = (yield* index.read).projects.find(
      (project) => project.identity === input.identity,
    );
    if (indexed === undefined) {
      return { ok: false, requestKey: input.requestKey, error: missingProject(input.identity) };
    }
    const validation = yield* layout.validate(indexed.path);
    if (!validation.ok) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: projectLayoutError(input.identity, validation.message, validation.findingKey),
      };
    }
    if (!validation.definitions.ok) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: error(
          "project-runtime-not-ready",
          validation.definitions.message,
          "Correct the Kojo Configuration and retry.",
          { kind: "project", identity: input.identity },
          validation.definitions.findings.map((finding) => finding.findingKey),
        ),
      };
    }
    const definitions = yield* runtime.acceptDefinitions(
      validation.project,
      validation.definitions,
    );
    if (definitions === undefined) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: error(
          "project-runtime-not-ready",
          "Kojo Configuration has not been accepted.",
          "Correct the Kojo Configuration and retry.",
          { kind: "project", identity: input.identity },
        ),
      };
    }
    const workflow = definitions.workflows.find(
      (candidate) => candidate.workflowKey === input.workflowKey,
    );
    if (workflow === undefined) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: error(
          "workflow-not-found",
          `Workflow Definition ${input.workflowKey} was not found in the accepted Project snapshot.`,
          "List accepted Workflow Definitions and choose a Workflow Key from that snapshot.",
          { kind: "workflow", identity: input.identity, workflowKey: input.workflowKey },
        ),
      };
    }
    if (workflow.revision !== input.workflowRevision) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: error(
          "workflow-revision-conflict",
          "The Workflow Definition changed before this start request was accepted.",
          "Refresh the Workflow Definition and retry with its current revision.",
          { kind: "workflow", identity: input.identity, workflowKey: input.workflowKey },
          [],
          workflow,
        ),
      };
    }
    const ready = yield* runtime.readiness(indexed, validation.project, validation.definitions);
    if (ready !== "ready") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: error(
          "project-runtime-not-ready",
          "Kojo Project Runtime is not ready to start a Workflow Run.",
          "Repair the Project Runtime and retry.",
          { kind: "project", identity: input.identity },
        ),
      };
    }

    const executable = yield* Effect.promise(() =>
      loadExecutableWorkflowDefinitions(
        join(validation.project.path, "kojo.config.ts"),
        definitions,
      ),
    ).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    if (executable === undefined) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: error(
          "project-runtime-not-ready",
          "Workflow Definitions could not be loaded for durable execution.",
          "Correct the Kojo Configuration and retry.",
          { kind: "project", identity: input.identity },
        ),
      };
    }
    const definition = executable.find(
      (candidate) =>
        candidate.workflowKey === input.workflowKey &&
        candidate.revision === input.workflowRevision,
    );
    if (definition === undefined) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: error(
          "workflow-not-found",
          "Workflow Definition is not executable in the accepted Project snapshot.",
          "Refresh the Workflow Definition and retry.",
          { kind: "workflow", identity: input.identity, workflowKey: input.workflowKey },
        ),
      };
    }
    let encodedInput: unknown;
    try {
      const inputSchema = definition.inputSchema as typeof Schema.Unknown;
      const decoded = Schema.decodeUnknownSync(inputSchema)(input.input);
      encodedInput = Schema.encodeSync(inputSchema)(decoded);
    } catch {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: error(
          "workflow-input-invalid",
          "Workflow input does not match the Workflow Definition input schema.",
          "Provide schema-valid input and retry.",
          { kind: "workflow", identity: input.identity, workflowKey: input.workflowKey },
        ),
      };
    }
    const requestHash = hash(
      stableJson({
        input: encodedInput,
        workflowKey: input.workflowKey,
        workflowRevision: input.workflowRevision,
      }),
    );
    const runId = randomUUID();
    const acceptedAtMs = Date.now();
    const snapshot = {
      workflow: {
        workflowKey: workflow.workflowKey,
        workflowRevision: workflow.revision,
        sourceIdentity: workflow.sourceIdentity,
        inputSchemaFingerprint: workflow.inputSchemaFingerprint,
      },
      trigger: { kind: "manual" as const, requestKey: input.requestKey },
      environment: {
        projectIdentity: validation.project.identity,
        definitionSnapshotId: definitions.snapshotId,
        runtimeKind: "local-effect-workflow" as const,
      },
      input: encodedInput,
      inputSensitivityPaths: workflow.sensitivity.input,
    };
    const accepted = yield* runtime.coordinateLifecycle(
      validation.project,
      Effect.gen(function* () {
        yield* backend.register(validation.project, [asLocalDefinition(definition)]);
        return yield* repository.acceptManualStart({
          project: validation.project,
          requestKey: input.requestKey,
          requestHash,
          runId,
          workflowKey: input.workflowKey,
          workflowRevision: input.workflowRevision,
          encodedInput,
          inputSensitivityPaths: workflow.sensitivity.input,
          startSnapshot: snapshot,
          acceptedAtMs,
        });
      }),
    );
    if (accepted._tag === "request-key-conflict") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: error(
          "request-key-conflict",
          "This Request Key was already used for a different Workflow Run start.",
          "Retry with the original request contents or use a new Request Key.",
          { kind: "request-key", requestKey: input.requestKey },
        ),
      };
    }
    yield* reconcileRun(
      backend,
      repository,
      validation.project,
      definition,
      accepted.run.run.runId,
    ).pipe(Effect.catchCause(() => Effect.void));
    yield* emitReconciliationDiagnostic(validation.project, accepted.run.run.runId);
    const run = yield* repository.show(validation.project, accepted.run.run.runId);
    return {
      ok: true,
      run: maskedWorkflowRun(run ?? accepted.run),
      alreadyApplied: accepted.alreadyApplied,
      requestKey: input.requestKey,
    };
  });

export const listWorkflowRuns = (
  input: WorkflowRunListInput,
): Effect.Effect<
  WorkflowRunListResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | WorkflowBackend
  | WorkflowRunRepository
  | HostDiagnosticLogger
> =>
  Effect.gen(function* () {
    const resolved = yield* resolveProject(input.identity);
    if ("code" in resolved) return { ok: false, error: resolved };
    yield* reconcilePendingWorkflowRuns(resolved);
    const repository = yield* WorkflowRunRepository;
    return { ok: true, runs: yield* repository.list(resolved.project, input) };
  });

export const showWorkflowRun = (
  identity: ProjectIdentity,
  runId: string,
): Effect.Effect<
  WorkflowRunQueryResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | WorkflowBackend
  | WorkflowRunRepository
  | HostDiagnosticLogger
> =>
  Effect.gen(function* () {
    const resolved = yield* resolveProject(identity);
    if ("code" in resolved) return { ok: false, error: resolved };
    yield* reconcilePendingWorkflowRuns(resolved);
    const repository = yield* WorkflowRunRepository;
    const run = yield* repository.show(resolved.project, runId);
    return run === undefined
      ? {
          ok: false,
          error: error(
            "run-not-found",
            "Workflow Run was not found in this Project.",
            "List Workflow Runs and choose a Run Identity from that Project.",
            { kind: "run", identity, runId: runId as never },
          ),
        }
      : { ok: true, run: maskedWorkflowRun(run) };
  });

export const revealWorkflowRun = (
  identity: ProjectIdentity,
  runId: string,
): Effect.Effect<
  WorkflowRunQueryResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | WorkflowBackend
  | WorkflowRunRepository
  | HostDiagnosticLogger
> =>
  Effect.gen(function* () {
    const resolved = yield* resolveProject(identity);
    if ("code" in resolved) return { ok: false, error: resolved };
    yield* reconcilePendingWorkflowRuns(resolved);
    const repository = yield* WorkflowRunRepository;
    const run = yield* repository.show(resolved.project, runId);
    return run === undefined
      ? {
          ok: false,
          error: error(
            "run-not-found",
            "Workflow Run was not found in this Project.",
            "List Workflow Runs and choose a Run Identity from that Project.",
            { kind: "run", identity, runId: runId as never },
          ),
        }
      : { ok: true, run: run.run };
  });

const runControlReference = (run: WorkflowRunSnapshot) =>
  workflowBackendReference(run.workflowKey, run.workflowRevision, run.runId);

const runControlError = (
  identity: ProjectIdentity,
  runId: string,
  code: Extract<
    WorkflowRunOperationError["code"],
    | "run-not-suspended"
    | "run-resume-not-allowed"
    | "workflow-deferred-not-found"
    | "workflow-deferred-value-invalid"
    | "project-runtime-not-ready"
  >,
  message: string,
  next: string,
): WorkflowRunOperationError =>
  error(code, message, next, { kind: "run", identity, runId: runId as never });

export const resumeWorkflowRun = (input: {
  readonly identity: ProjectIdentity;
  readonly requestKey: RequestKey;
  readonly runId: string;
  readonly value: unknown;
}): Effect.Effect<
  WorkflowRunMutationResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | WorkflowBackend
  | WorkflowRunRepository
  | HostDiagnosticLogger
> =>
  Effect.gen(function* () {
    const resolved = yield* resolveProject(input.identity);
    if ("code" in resolved) return { ok: false, requestKey: input.requestKey, error: resolved };
    yield* reconcilePendingWorkflowRuns(resolved);
    const repository = yield* WorkflowRunRepository;
    const stored = yield* repository.show(resolved.project, input.runId);
    if (stored === undefined) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: error(
          "run-not-found",
          "Workflow Run was not found in this Project.",
          "List Workflow Runs and choose a Run Identity from that Project.",
          { kind: "run", identity: input.identity, runId: input.runId as never },
        ),
      };
    }
    const requestHash = hash(
      stableJson({ kind: "run.resume", runId: input.runId, value: input.value }),
    );
    const reserved = yield* repository.reserveControl(resolved.project, {
      kind: "run.resume",
      requestHash,
      requestKey: input.requestKey,
      requestedAtMs: Date.now(),
      runId: input.runId,
    });
    if (reserved._tag === "request-key-conflict") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: error(
          "request-key-conflict",
          "This Request Key was already used for a different Workflow Run control request.",
          "Retry with the original request contents or use a new Request Key.",
          { kind: "request-key", requestKey: input.requestKey },
        ),
      };
    }
    if (reserved._tag === "already-applied") {
      return {
        ok: true,
        run: maskedWorkflowRun(reserved.run),
        alreadyApplied: true,
        requestKey: input.requestKey,
      };
    }
    if (stored.run.state !== "suspended") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: runControlError(
          input.identity,
          input.runId,
          "run-not-suspended",
          "Only a suspended Workflow Run can be resumed.",
          "Wait for the Run to suspend, or inspect its current state.",
        ),
      };
    }
    if (stored.run.suspension?.kind !== "manual") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: runControlError(
          input.identity,
          input.runId,
          "run-resume-not-allowed",
          "This suspension is continued by a durable clock or Workflow Deferred, not Run resume.",
          "Wait for the clock or complete the Workflow Deferred with its token.",
        ),
      };
    }
    const backend = yield* WorkflowBackend;
    if (backend.resume === undefined) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: runControlError(
          input.identity,
          input.runId,
          "project-runtime-not-ready",
          "Kojo Project Runtime cannot resume Workflow Runs.",
          "Repair the Project Runtime and retry.",
        ),
      };
    }
    const resumed = yield* backend.resume(
      resolved.project,
      runControlReference(stored.run),
      input.value,
    );
    if (resumed._tag === "invalid-value") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: runControlError(
          input.identity,
          input.runId,
          "workflow-deferred-value-invalid",
          "The resume value does not match this Workflow Run's declared schema.",
          "Provide a schema-valid value and retry.",
        ),
      };
    }
    if (resumed._tag === "not-manually-suspended") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: runControlError(
          input.identity,
          input.runId,
          "run-resume-not-allowed",
          "This Workflow Run is no longer manually suspended.",
          "Refresh the Run and use one of its allowed actions.",
        ),
      };
    }
    const completed = yield* repository.completeControl(resolved.project, {
      kind: "run.resume",
      requestKey: input.requestKey,
      runId: input.runId,
      resumedAtMs: Date.now(),
      expectedSuspension: "manual",
    });
    if (completed === undefined) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: runControlError(
          input.identity,
          input.runId,
          "run-resume-not-allowed",
          "This Workflow Run changed before resume was committed.",
          "Refresh the Run and retry only an allowed action.",
        ),
      };
    }
    return {
      ok: true,
      run: maskedWorkflowRun(completed),
      alreadyApplied: false,
      requestKey: input.requestKey,
    };
  });

export const completeWorkflowDeferred = (input: {
  readonly identity: ProjectIdentity;
  readonly requestKey: RequestKey;
  readonly runId: string;
  readonly token: string;
  readonly value: unknown;
}): Effect.Effect<
  WorkflowRunMutationResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | WorkflowBackend
  | WorkflowRunRepository
  | HostDiagnosticLogger
> =>
  Effect.gen(function* () {
    const resolved = yield* resolveProject(input.identity);
    if ("code" in resolved) return { ok: false, requestKey: input.requestKey, error: resolved };
    yield* reconcilePendingWorkflowRuns(resolved);
    const repository = yield* WorkflowRunRepository;
    const stored = yield* repository.show(resolved.project, input.runId);
    if (stored === undefined) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: error(
          "run-not-found",
          "Workflow Run was not found in this Project.",
          "List Workflow Runs and choose a Run Identity from that Project.",
          { kind: "run", identity: input.identity, runId: input.runId as never },
        ),
      };
    }
    const requestHash = hash(
      stableJson({
        kind: "run.deferred-complete",
        runId: input.runId,
        token: input.token,
        value: input.value,
      }),
    );
    const reserved = yield* repository.reserveControl(resolved.project, {
      kind: "run.deferred-complete",
      requestHash,
      requestKey: input.requestKey,
      requestedAtMs: Date.now(),
      runId: input.runId,
    });
    if (reserved._tag === "request-key-conflict") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: error(
          "request-key-conflict",
          "This Request Key was already used for a different Workflow Run control request.",
          "Retry with the original request contents or use a new Request Key.",
          { kind: "request-key", requestKey: input.requestKey },
        ),
      };
    }
    if (reserved._tag === "already-applied") {
      return {
        ok: true,
        run: maskedWorkflowRun(reserved.run),
        alreadyApplied: true,
        requestKey: input.requestKey,
      };
    }
    if (stored.run.state !== "suspended" || stored.run.suspension?.kind !== "deferred") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: runControlError(
          input.identity,
          input.runId,
          "workflow-deferred-not-found",
          "This Workflow Run is not waiting for a Workflow Deferred.",
          "Refresh the Run and provide a completion token for its current Deferred wait.",
        ),
      };
    }
    const backend = yield* WorkflowBackend;
    if (backend.completeDeferred === undefined) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: runControlError(
          input.identity,
          input.runId,
          "project-runtime-not-ready",
          "Kojo Project Runtime cannot complete Workflow Deferreds.",
          "Repair the Project Runtime and retry.",
        ),
      };
    }
    const completedDeferred = yield* backend.completeDeferred(
      resolved.project,
      runControlReference(stored.run),
      input.token,
      input.value,
    );
    if (completedDeferred._tag === "invalid-value") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: runControlError(
          input.identity,
          input.runId,
          "workflow-deferred-value-invalid",
          "The Workflow Deferred value does not match its declared schema.",
          "Provide a schema-valid value and retry.",
        ),
      };
    }
    if (completedDeferred._tag === "not-deferred") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: runControlError(
          input.identity,
          input.runId,
          "workflow-deferred-not-found",
          "The supplied Workflow Deferred token does not identify this Run's current wait.",
          "Use the token returned by this Run's Workflow Deferred.",
        ),
      };
    }
    const completed = yield* repository.completeControl(resolved.project, {
      kind: "run.deferred-complete",
      requestKey: input.requestKey,
      runId: input.runId,
      resumedAtMs: Date.now(),
      expectedSuspension: "deferred",
    });
    if (completed === undefined) {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: runControlError(
          input.identity,
          input.runId,
          "workflow-deferred-not-found",
          "This Workflow Deferred changed before completion was committed.",
          "Refresh the Run and retry with its current Deferred token.",
        ),
      };
    }
    return {
      ok: true,
      run: maskedWorkflowRun(completed),
      alreadyApplied: false,
      requestKey: input.requestKey,
    };
  });
