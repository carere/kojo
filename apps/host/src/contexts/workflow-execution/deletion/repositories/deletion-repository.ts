import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type {
  DeletionOperationError,
  DeletionReceipt,
  DeletionScope,
  ProjectSnapshot,
  RequestKey,
} from "@kojo/control";
import {
  DeletionReceipt as DeletionReceiptSchema,
  RequestKey as RequestKeySchema,
} from "@kojo/control";
import { and, asc, eq, gt, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import type { ConstraintDecoder } from "effect/Schema";
import {
  controlRequests,
  deletionIntents,
  deletionItems,
  engineOperations,
  executionArtifacts,
  executionEventArtifacts,
  executionEvents,
  retentionPolicy,
  workflowActivityAttempts,
  workflowActivityOperations,
  workflowRuns,
  workflowScheduleOccurrences,
  workflowScheduleStates,
} from "../../projects/repositories/project-repository-schema";
import {
  assertDatabaseFile,
  type DrizzleProjectStore,
  databasePath,
  withDrizzleReadableProjectStore,
  withDrizzleWritableProjectStoreTransaction,
} from "../../projects/repositories/project-store-adapter";
import {
  countsFor,
  type DeletionPlanRecord,
  type DeletionTargetSnapshot,
  DeletionTargetSnapshotSchema,
  type DeletionWorkItem,
  deletionScopeDigest,
  stableJson,
} from "../models/deletion-plan";

const finalRunStates = new Set(["completed", "failed", "stopped"]);
const deletionOperationKind = "execution.delete";
const receiptExpiryMs = 30 * 24 * 60 * 60 * 1_000;

type DeletionPhase =
  | "quiescing"
  | "clearing-engine"
  | "clearing-owned-content"
  | "deleting-records"
  | "needs-attention";
export type DeletionItemStatus = "pending" | "completed" | "warning" | "needs-attention";

export type DeletionOwnedFileReconciliation =
  | { readonly _tag: "unchanged" }
  | { readonly _tag: "added"; readonly count: number }
  | { readonly _tag: "needs-attention" };

export interface DeletionInspectionAccepted {
  readonly _tag: "accepted";
  readonly target: DeletionTargetSnapshot;
}

export interface DeletionInspectionRejected {
  readonly _tag: "rejected";
  readonly error: DeletionOperationError;
}

export type DeletionInspection = DeletionInspectionAccepted | DeletionInspectionRejected;

export interface DeletionPendingRequest {
  readonly _tag: "pending";
  readonly deletionId: string;
  readonly phase: DeletionPhase;
  readonly target: DeletionTargetSnapshot;
}

export interface DeletionCompletedRequest {
  readonly _tag: "completed";
  readonly receipt: DeletionReceipt;
}

export type DeletionExistingRequest = DeletionPendingRequest | DeletionCompletedRequest;

export type DeletionBeginResult =
  | { readonly _tag: "started"; readonly deletionId: string; readonly resumed: boolean }
  | { readonly _tag: "completed"; readonly receipt: DeletionReceipt }
  | { readonly _tag: "conflict" }
  | { readonly _tag: "in-progress" };

export interface DeletionItemState {
  readonly item: DeletionWorkItem;
  readonly state: DeletionItemStatus;
  readonly safeErrorCode: string | null;
}

export interface DeletionRepositoryShape {
  readonly inspect: (
    project: ProjectSnapshot,
    scope: DeletionScope,
  ) => Effect.Effect<DeletionInspection>;
  readonly readRequest: (
    project: ProjectSnapshot,
    requestKey: RequestKey,
    nowMs?: number,
  ) => Effect.Effect<DeletionExistingRequest | undefined>;
  readonly begin: (
    project: ProjectSnapshot,
    plan: DeletionPlanRecord,
    nowMs: number,
  ) => Effect.Effect<DeletionBeginResult>;
  readonly readItems: (
    project: ProjectSnapshot,
    deletionId: string,
  ) => Effect.Effect<ReadonlyArray<DeletionItemState>>;
  readonly markItem: (
    project: ProjectSnapshot,
    deletionId: string,
    item: DeletionWorkItem,
    state: Exclude<DeletionItemStatus, "pending">,
    safeErrorCode?: string,
  ) => Effect.Effect<void>;
  readonly reconcileOwnedFiles: (
    project: ProjectSnapshot,
    deletionId: string,
    nowMs: number,
  ) => Effect.Effect<DeletionOwnedFileReconciliation>;
  readonly setPhase: (
    project: ProjectSnapshot,
    deletionId: string,
    phase: DeletionPhase,
    safeErrorCode?: string,
  ) => Effect.Effect<void>;
  readonly complete: (
    project: ProjectSnapshot,
    deletionId: string,
    nowMs: number,
  ) => Effect.Effect<DeletionReceipt>;
  /** A completed Project reset suppresses background schedule activation until
   * an explicit schedule/run operation asks for reconciliation. */
  readonly hasCompletedProjectReset: (project: ProjectSnapshot) => Effect.Effect<boolean>;
}

export class DeletionRepository extends Context.Service<
  DeletionRepository,
  DeletionRepositoryShape
>()("kojo/host/DeletionRepository") {}

const digestBytes = (digest: string) => Buffer.from(digest, "hex");
const hash = (value: string) => createHash("sha256").update(value).digest();

const projectError = (
  code: DeletionOperationError["code"],
  message: string,
  next: string,
  scope: DeletionScope,
): DeletionOperationError => ({
  code,
  message,
  next,
  affectedResource:
    scope.kind === "run"
      ? { kind: "run", identity: scope.identity, runId: scope.runId }
      : scope.kind === "schedule"
        ? { kind: "schedule", identity: scope.identity, scheduleKey: scope.scheduleKey }
        : scope.kind === "occurrences"
          ? { kind: "occurrences", identity: scope.identity }
          : { kind: "project", identity: scope.identity },
  findingKeys: [],
});

const invalidScope = (scope: DeletionScope, message: string, next: string) =>
  projectError("scope-invalid", message, next, scope);

const targetNotFound = (scope: DeletionScope, message: string) =>
  projectError(
    "target-not-found",
    message,
    "Refresh the Project execution data and create a new deletion preview.",
    scope,
  );

const targetNotFinal = (
  scope: DeletionScope,
  message: string,
  code: DeletionOperationError["code"] = "target-not-final",
) =>
  projectError(
    code,
    message,
    "Wait for every affected Workflow Run or occurrence to become final, then create a new deletion preview.",
    scope,
  );

interface StoredRun {
  readonly run_id: string;
  readonly parent_run_id: string | null;
  readonly workflow_key: string;
  readonly workflow_revision: string;
  readonly state: string;
  readonly row_version: number;
  readonly last_event_sequence: number;
}

const StoredRunRows = Schema.Array(
  Schema.Struct({
    run_id: Schema.String,
    parent_run_id: Schema.NullOr(Schema.String),
    workflow_key: Schema.String,
    workflow_revision: Schema.String,
    state: Schema.String,
    row_version: Schema.Number,
    last_event_sequence: Schema.Number,
  }),
);

interface StoredOccurrence {
  readonly schedule_key: string;
  readonly scheduled_at_ms: number;
  readonly applied_revision: string;
  readonly outcome: string;
  readonly linked_run_id: string | null;
  readonly deleted_run_id: string | null;
  readonly row_version: number;
  readonly processed_at_ms: number | null;
}

const StoredOccurrenceRows = Schema.Array(
  Schema.Struct({
    schedule_key: Schema.String,
    scheduled_at_ms: Schema.Number,
    applied_revision: Schema.String,
    outcome: Schema.String,
    linked_run_id: Schema.NullOr(Schema.String),
    deleted_run_id: Schema.NullOr(Schema.String),
    row_version: Schema.Number,
    processed_at_ms: Schema.NullOr(Schema.Number),
  }),
);

interface StoredSchedule {
  readonly applied_revision: string | null;
  readonly schedule_key: string;
  readonly enabled_intent: number;
  readonly condition: string;
  readonly condition_reason_code: string | null;
  readonly next_occurrence_ms: number | null;
  readonly row_version: number;
  readonly updated_at_ms: number;
}

const StoredScheduleRows = Schema.Array(
  Schema.Struct({
    applied_revision: Schema.NullOr(Schema.String),
    schedule_key: Schema.String,
    enabled_intent: Schema.Number,
    condition: Schema.String,
    condition_reason_code: Schema.NullOr(Schema.String),
    next_occurrence_ms: Schema.NullOr(Schema.Number),
    row_version: Schema.Number,
    updated_at_ms: Schema.Number,
  }),
);

const SubmitOperationRows = Schema.Array(
  Schema.Struct({ run_id: Schema.String, attempt_count: Schema.Number }),
);

const ArtifactRows = Schema.Array(
  Schema.Struct({
    run_id: Schema.String,
    artifact_id: Schema.String,
    condition: Schema.String,
    storage_key: Schema.String,
  }),
);

const ProviderTraceRows = Schema.Array(
  Schema.Struct({ run_id: Schema.String, kind: Schema.String, payload_json: Schema.String }),
);

const ProviderTracePayload = Schema.Struct({
  providerKind: Schema.optionalKey(Schema.String),
  evidence: Schema.optionalKey(Schema.Struct({ providerKind: Schema.optionalKey(Schema.String) })),
});

const ControlRequestRow = Schema.Struct({
  operation_kind: Schema.String,
  request_sha256: Schema.Uint8Array,
  state: Schema.Literals(["pending", "completed", "needs-attention"]),
  result_json: Schema.NullOr(Schema.String),
});

const IntentRow = Schema.Struct({
  deletion_id: Schema.String,
  request_key: Schema.String,
  phase: Schema.Literals([
    "quiescing",
    "clearing-engine",
    "clearing-owned-content",
    "deleting-records",
    "needs-attention",
  ]),
  target_snapshot_json: Schema.String,
});

const DeletionItemRows = Schema.Array(
  Schema.Struct({
    item_kind: Schema.String,
    item_key: Schema.String,
    state: Schema.Literals(["pending", "completed", "warning", "needs-attention"]),
    safe_error_code: Schema.NullOr(Schema.String),
  }),
);

const WarningRows = Schema.Array(Schema.Struct({ safe_error_code: Schema.NullOr(Schema.String) }));

const ScheduleKeyRows = Schema.Array(Schema.Struct({ schedule_key: Schema.String }));

const decodeRows = <S extends ConstraintDecoder<unknown>>(schema: S, rows: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(rows);

const readRuns = (store: DrizzleProjectStore): ReadonlyArray<StoredRun> =>
  decodeRows(
    StoredRunRows,
    store
      .select({
        run_id: workflowRuns.runId,
        parent_run_id: workflowRuns.parentRunId,
        workflow_key: workflowRuns.workflowKey,
        workflow_revision: workflowRuns.workflowRevision,
        state: workflowRuns.state,
        row_version: workflowRuns.rowVersion,
        last_event_sequence: workflowRuns.lastEventSequence,
      })
      .from(workflowRuns)
      .orderBy(asc(workflowRuns.acceptedAtMs), asc(workflowRuns.runId))
      .all(),
  );

const readOccurrences = (store: DrizzleProjectStore): ReadonlyArray<StoredOccurrence> =>
  decodeRows(
    StoredOccurrenceRows,
    store
      .select({
        schedule_key: workflowScheduleOccurrences.scheduleKey,
        scheduled_at_ms: workflowScheduleOccurrences.scheduledAtMs,
        applied_revision: workflowScheduleOccurrences.appliedRevision,
        outcome: workflowScheduleOccurrences.outcome,
        linked_run_id: workflowScheduleOccurrences.linkedRunId,
        deleted_run_id: workflowScheduleOccurrences.deletedRunId,
        row_version: workflowScheduleOccurrences.rowVersion,
        processed_at_ms: workflowScheduleOccurrences.processedAtMs,
      })
      .from(workflowScheduleOccurrences)
      .orderBy(
        asc(workflowScheduleOccurrences.scheduleKey),
        asc(workflowScheduleOccurrences.scheduledAtMs),
      )
      .all(),
  );

const readSchedules = (store: DrizzleProjectStore): ReadonlyArray<StoredSchedule> =>
  decodeRows(
    StoredScheduleRows,
    store
      .select({
        schedule_key: workflowScheduleStates.scheduleKey,
        enabled_intent: workflowScheduleStates.enabledIntent,
        condition: workflowScheduleStates.condition,
        condition_reason_code: workflowScheduleStates.conditionReasonCode,
        applied_revision: workflowScheduleStates.appliedRevision,
        next_occurrence_ms: workflowScheduleStates.nextOccurrenceMs,
        row_version: workflowScheduleStates.rowVersion,
        updated_at_ms: workflowScheduleStates.updatedAtMs,
      })
      .from(workflowScheduleStates)
      .orderBy(asc(workflowScheduleStates.scheduleKey))
      .all(),
  );

const readSubmitGenerations = (store: DrizzleProjectStore, runIds: ReadonlyArray<string>) => {
  if (runIds.length === 0) return new Map<string, number>();
  const rows = decodeRows(
    SubmitOperationRows,
    store
      .select({ run_id: engineOperations.runId, attempt_count: engineOperations.attemptCount })
      .from(engineOperations)
      .where(and(eq(engineOperations.kind, "submit"), inArray(engineOperations.runId, runIds)))
      .all(),
  );
  const maximums = new Map<string, number>();
  for (const row of rows) {
    maximums.set(row.run_id, Math.max(maximums.get(row.run_id) ?? 0, row.attempt_count));
  }
  return new Map(
    [...maximums].map(([runId, attemptCount]) => [runId, Math.max(1, attemptCount + 1)]),
  );
};

const readArtifactRows = (store: DrizzleProjectStore, runIds: ReadonlyArray<string>) => {
  if (runIds.length === 0) return [];
  return decodeRows(
    ArtifactRows,
    store
      .select({
        run_id: executionArtifacts.runId,
        artifact_id: executionArtifacts.artifactId,
        condition: executionArtifacts.condition,
        storage_key: executionArtifacts.storageKey,
      })
      .from(executionArtifacts)
      .where(inArray(executionArtifacts.runId, runIds))
      .orderBy(asc(executionArtifacts.runId), asc(executionArtifacts.artifactId))
      .all(),
  );
};

const providerTraceKinds = [
  "sandbox.acquired",
  "sandbox.session-recreated",
  "command.completed",
  "command.failed",
  "command.timed-out",
  "boundary.started",
  "boundary.completed",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.session-continued",
  "agent.replayed",
] as const;

const readProviderCleanupExpectations = (
  store: DrizzleProjectStore,
  runIds: ReadonlyArray<string>,
) => {
  const expectations = new Map<string, "supported" | "unsupported">();
  if (runIds.length === 0) return expectations;
  const rows = decodeRows(
    ProviderTraceRows,
    store
      .select({
        run_id: executionEvents.runId,
        kind: executionEvents.kind,
        payload_json: executionEvents.payloadJson,
      })
      .from(executionEvents)
      .where(
        and(
          inArray(executionEvents.runId, runIds),
          inArray(executionEvents.kind, [...providerTraceKinds]),
        ),
      )
      .all(),
  );
  for (const row of rows) {
    try {
      const payload = Schema.decodeUnknownSync(ProviderTracePayload)(JSON.parse(row.payload_json));
      const providerKind =
        typeof payload.providerKind === "string"
          ? payload.providerKind
          : typeof payload.evidence?.providerKind === "string"
            ? payload.evidence.providerKind
            : undefined;
      if (providerKind === undefined) continue;
      const expected = providerKind === "custom" ? "unsupported" : "supported";
      if (expectations.get(row.run_id) !== "unsupported") {
        expectations.set(row.run_id, expected);
      }
    } catch {
      // Invalid payloads are already treated as sensitive by the trace reader;
      // they cannot prove a Provider cleanup capability here.
    }
  }
  return expectations;
};

const isSafeRelativePath = (value: string) => {
  return (
    value !== "" &&
    !value.startsWith(sep) &&
    !value.startsWith("../") &&
    !value.startsWith(`..${sep}`) &&
    value !== ".." &&
    !value.split(/[\\/]/).includes("..")
  );
};

const walkOwnedFiles = async (
  project: ProjectSnapshot,
  runIds: ReadonlySet<string>,
  roots: ReadonlyArray<string>,
  includeAllFiles: boolean,
) => {
  const rootPath = resolve(project.path);
  const result: Array<{ readonly relativePath: string; readonly key: string }> = [];
  const walk = async (path: string, relativePath: string) => {
    let information: Awaited<ReturnType<typeof lstat>>;
    try {
      information = await lstat(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    if (information.isSymbolicLink()) return;
    if (information.isDirectory()) {
      for (const name of await readdir(path))
        await walk(join(path, name), join(relativePath, name));
      return;
    }
    if (!information.isFile()) return;
    const relativeToProject = relative(rootPath, path);
    if (!isSafeRelativePath(relativeToProject)) return;
    result.push({
      relativePath: relativeToProject,
      key: `file:${relativeToProject}`,
    });
  };
  for (const root of roots) {
    const rootPathForRunFiles = join(project.path, ".kojo", root);
    let rootInformation: Awaited<ReturnType<typeof lstat>>;
    try {
      rootInformation = await lstat(rootPathForRunFiles);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    if (rootInformation.isSymbolicLink() || !rootInformation.isDirectory()) continue;
    let entries: ReadonlyArray<string>;
    try {
      entries = await readdir(rootPathForRunFiles);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    for (const runId of entries) {
      if (!includeAllFiles && !runIds.has(runId)) continue;
      await walk(join(rootPathForRunFiles, runId), join(".kojo", root, runId));
    }
  }
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
};

const runItems = (
  runs: ReadonlyArray<StoredRun>,
  generations: ReadonlyMap<string, number>,
  providerCleanup: ReadonlyMap<string, "supported" | "unsupported"> = new Map(),
): Array<DeletionWorkItem> => {
  const items: Array<DeletionWorkItem> = [];
  for (const run of runs) {
    items.push({ kind: "run", key: `run:${run.run_id}`, runId: run.run_id });
    const generationCount = generations.get(run.run_id) ?? 1;
    for (let generation = 1; generation <= generationCount; generation += 1) {
      items.push({
        kind: "engine",
        key: `engine:${run.run_id}:${generation}`,
        runId: run.run_id,
        workflowKey: run.workflow_key,
        workflowRevision: run.workflow_revision,
        engineGeneration: generation,
      });
    }
    // A provider item is explicit so an adapter can report unsupported or
    // failed remote cleanup without blocking local logical deletion.
    const expectedCleanup = providerCleanup.get(run.run_id);
    items.push({
      kind: "provider",
      key: `provider:${run.run_id}`,
      runId: run.run_id,
      ...(expectedCleanup === undefined ? {} : { providerCleanup: expectedCleanup }),
    });
  }
  return items;
};

const occurrenceItem = (occurrence: StoredOccurrence): DeletionWorkItem => ({
  kind: "occurrence",
  key: `occurrence:${occurrence.schedule_key}:${occurrence.scheduled_at_ms}`,
  scheduleKey: occurrence.schedule_key,
  scheduledAtMs: occurrence.scheduled_at_ms,
  scheduleRevision: occurrence.applied_revision,
});

const scheduleItem = (schedule: StoredSchedule): DeletionWorkItem => ({
  kind: "schedule",
  key: `schedule:${schedule.schedule_key}`,
  scheduleKey: schedule.schedule_key,
  ...(schedule.next_occurrence_ms === null || schedule.applied_revision === null
    ? {}
    : {
        scheduledAtMs: schedule.next_occurrence_ms,
        scheduleRevision: schedule.applied_revision,
      }),
});

const occurrenceIsFinal = (
  occurrence: StoredOccurrence,
  runsById: ReadonlyMap<string, StoredRun>,
) =>
  occurrence.outcome !== "planned" &&
  (occurrence.linked_run_id === null ||
    finalRunStates.has(runsById.get(occurrence.linked_run_id)?.state ?? ""));

const requestedScheduleKeys = (scope: DeletionScope) =>
  scope.kind === "occurrences" && scope.scheduleKeys.length > 0
    ? new Set(scope.scheduleKeys)
    : undefined;

const makeTarget = async (
  project: ProjectSnapshot,
  scope: DeletionScope,
): Promise<DeletionInspection> => {
  const read = withDrizzleReadableProjectStore(project, (store) => {
    const runs = readRuns(store);
    const occurrences = readOccurrences(store);
    const schedules = readSchedules(store);
    const runsById = new Map(runs.map((run) => [run.run_id, run]));
    const schedulesByKey = new Map(schedules.map((schedule) => [schedule.schedule_key, schedule]));
    const generations = readSubmitGenerations(
      store,
      runs.map((run) => run.run_id),
    );
    const providerCleanup = readProviderCleanupExpectations(
      store,
      runs.map((run) => run.run_id),
    );
    return { runs, occurrences, schedules, runsById, schedulesByKey, generations, providerCleanup };
  });

  const items: Array<DeletionWorkItem> = [];
  const preconditions: Array<{ readonly key: string; readonly value: string }> = [];
  let selectedRuns: ReadonlyArray<StoredRun> = [];
  let selectedOccurrences: ReadonlyArray<StoredOccurrence> = [];
  let selectedSchedules: ReadonlyArray<StoredSchedule> = [];

  if (scope.kind === "run") {
    const root = read.runsById.get(scope.runId);
    if (root === undefined) {
      return {
        _tag: "rejected",
        error: targetNotFound(scope, `Workflow Run ${scope.runId} was not found.`),
      };
    }
    if (root.parent_run_id !== null) {
      return {
        _tag: "rejected",
        error: invalidScope(
          scope,
          "Run deletion accepts only a final top-level Workflow Run.",
          "Choose the top-level Run; its complete Child Run tree is included automatically.",
        ),
      };
    }
    const tree: Array<StoredRun> = [];
    const queue = [root.run_id];
    while (queue.length > 0) {
      const runId = queue.shift() as string;
      const run = read.runsById.get(runId);
      if (run === undefined) {
        return {
          _tag: "rejected",
          error: invalidScope(
            scope,
            "The Workflow Run tree is incomplete.",
            "Repair the Project Runtime before deleting this Run.",
          ),
        };
      }
      tree.push(run);
      for (const child of read.runs.filter((candidate) => candidate.parent_run_id === runId)) {
        queue.push(child.run_id);
      }
    }
    if (tree.some((run) => !finalRunStates.has(run.state))) {
      return {
        _tag: "rejected",
        error: targetNotFinal(scope, "Every Run in the complete Child Run tree must be final."),
      };
    }
    selectedRuns = tree.sort((left, right) => left.run_id.localeCompare(right.run_id));
    items.push(...runItems(selectedRuns, read.generations, read.providerCleanup));
    selectedOccurrences = read.occurrences.filter((occurrence) =>
      selectedRuns.some((run) => run.run_id === occurrence.linked_run_id),
    );
    for (const occurrence of selectedOccurrences) items.push(occurrenceItem(occurrence));
    for (const run of selectedRuns) {
      preconditions.push({
        key: `run:${run.run_id}`,
        value: `${run.row_version}:${run.state}:${run.last_event_sequence}:${run.parent_run_id ?? ""}`,
      });
    }
  } else if (scope.kind === "occurrences") {
    const selectedKeys = requestedScheduleKeys(scope);
    if (
      selectedKeys !== undefined &&
      [...selectedKeys].some((key) => key.length === 0 || key === "*")
    ) {
      return {
        _tag: "rejected",
        error: invalidScope(
          scope,
          "Occurrence deletion requires explicit Schedule Keys; wildcard selection is not supported.",
          "Repeat the command with concrete --schedule values.",
        ),
      };
    }
    selectedOccurrences = read.occurrences.filter(
      (occurrence) =>
        occurrence.scheduled_at_ms < scope.beforeMs &&
        (selectedKeys === undefined || selectedKeys.has(occurrence.schedule_key)),
    );
    const missingKeys =
      selectedKeys === undefined
        ? []
        : [...selectedKeys].filter((key) => !read.schedulesByKey.has(key));
    if (missingKeys.length > 0) {
      return {
        _tag: "rejected",
        error: targetNotFound(scope, `Workflow Schedule ${missingKeys[0]} was not found.`),
      };
    }
    const nonFinal = selectedOccurrences.find(
      (occurrence) => !occurrenceIsFinal(occurrence, read.runsById),
    );
    if (nonFinal !== undefined) {
      return {
        _tag: "rejected",
        error: targetNotFinal(
          scope,
          `Occurrence ${nonFinal.schedule_key} at ${nonFinal.scheduled_at_ms} is not final.`,
        ),
      };
    }
    for (const occurrence of selectedOccurrences) {
      items.push(occurrenceItem(occurrence));
      preconditions.push({
        key: occurrenceItem(occurrence).key,
        value: `${occurrence.row_version}:${occurrence.outcome}:${occurrence.linked_run_id ?? ""}:${occurrence.deleted_run_id ?? ""}`,
      });
    }
  } else if (scope.kind === "schedule") {
    const schedule = read.schedulesByKey.get(scope.scheduleKey);
    if (schedule === undefined) {
      return {
        _tag: "rejected",
        error: targetNotFound(scope, `Workflow Schedule ${scope.scheduleKey} was not found.`),
      };
    }
    if (schedule.enabled_intent !== 0) {
      return {
        _tag: "rejected",
        error: projectError(
          "schedule-not-disabled",
          `Workflow Schedule ${scope.scheduleKey} is still enabled.`,
          "Disable the Schedule, wait for accepted Runs to finish, and create a new deletion preview.",
          scope,
        ),
      };
    }
    if (schedule.condition !== "unavailable") {
      return {
        _tag: "rejected",
        error: projectError(
          "schedule-not-unavailable",
          `Workflow Schedule ${scope.scheduleKey} is not proven unavailable.`,
          "Repair the Schedule condition before creating a deletion preview.",
          scope,
        ),
      };
    }
    selectedSchedules = [schedule];
    selectedOccurrences = read.occurrences.filter(
      (occurrence) => occurrence.schedule_key === schedule.schedule_key,
    );
    const nonFinalOccurrence = selectedOccurrences.find(
      (occurrence) => !occurrenceIsFinal(occurrence, read.runsById),
    );
    if (nonFinalOccurrence !== undefined) {
      return {
        _tag: "rejected",
        error: targetNotFinal(
          scope,
          `Occurrence ${nonFinalOccurrence.schedule_key} at ${nonFinalOccurrence.scheduled_at_ms} is not final.`,
        ),
      };
    }
    items.push(scheduleItem(schedule), ...selectedOccurrences.map(occurrenceItem));
    preconditions.push({
      key: scheduleItem(schedule).key,
      value: `${schedule.row_version}:${schedule.enabled_intent}:${schedule.condition}:${schedule.updated_at_ms}`,
    });
    for (const occurrence of selectedOccurrences) {
      preconditions.push({
        key: occurrenceItem(occurrence).key,
        value: `${occurrence.row_version}:${occurrence.outcome}:${occurrence.linked_run_id ?? ""}`,
      });
      if (occurrence.linked_run_id !== null) {
        const run = read.runsById.get(occurrence.linked_run_id);
        if (run === undefined) {
          return {
            _tag: "rejected",
            error: targetNotFinal(
              scope,
              `Occurrence ${occurrence.schedule_key} at ${occurrence.scheduled_at_ms} has a missing linked Run.`,
            ),
          };
        }
        preconditions.push({
          key: `run:${run.run_id}`,
          value: `${run.row_version}:${run.state}:${run.last_event_sequence}:${run.parent_run_id ?? ""}`,
        });
      }
    }
  } else {
    const nonFinalRun = read.runs.find((run) => !finalRunStates.has(run.state));
    if (nonFinalRun !== undefined) {
      return {
        _tag: "rejected",
        error: targetNotFinal(
          scope,
          `Workflow Run ${nonFinalRun.run_id} is not final; Project data cannot be deleted yet.`,
          "project-runs-not-final",
        ),
      };
    }
    selectedRuns = read.runs;
    selectedOccurrences = read.occurrences;
    selectedSchedules = read.schedules;
    items.push(
      ...selectedSchedules.map(scheduleItem),
      ...selectedOccurrences.map(occurrenceItem),
      ...runItems(selectedRuns, read.generations, read.providerCleanup),
    );
    for (const schedule of selectedSchedules) {
      preconditions.push({
        key: scheduleItem(schedule).key,
        value: `${schedule.row_version}:${schedule.enabled_intent}:${schedule.condition}:${schedule.updated_at_ms}`,
      });
    }
    for (const run of selectedRuns) {
      preconditions.push({
        key: `run:${run.run_id}`,
        value: `${run.row_version}:${run.state}:${run.last_event_sequence}:${run.parent_run_id ?? ""}`,
      });
    }
  }

  const runIds = new Set(selectedRuns.map((run) => run.run_id));
  const files = await walkOwnedFiles(
    project,
    runIds,
    ["artifacts", "sandboxes", "transcripts", "sessions", "agent-sessions"],
    scope.kind === "project",
  );
  for (const file of files) {
    items.push({ kind: "owned-file", key: file.key, relativePath: file.relativePath });
  }

  // Artifacts whose authoritative row exists but whose file is missing still
  // appear in the scope. The completion path treats the missing leaf as an
  // idempotent warning rather than silently changing the requested scope.
  if (scope.kind === "run" || scope.kind === "project") {
    const artifactRows = withDrizzleReadableProjectStore(project, (store) =>
      readArtifactRows(
        store,
        selectedRuns.map((run) => run.run_id),
      ),
    );
    for (const artifact of artifactRows) {
      const relativePath = join(
        ".kojo",
        "artifacts",
        artifact.run_id,
        `${artifact.artifact_id}.json`,
      );
      if (!items.some((item) => item.kind === "owned-file" && item.relativePath === relativePath)) {
        items.push({
          kind: "owned-file",
          key: `file:${relativePath}`,
          relativePath,
        });
      }
    }
  }

  const sortedItems = [...items].sort((left, right) => {
    const kind = left.kind.localeCompare(right.kind);
    return kind === 0 ? left.key.localeCompare(right.key) : kind;
  });
  return {
    _tag: "accepted",
    target: {
      version: 1,
      scope,
      scopeDigest: deletionScopeDigest(scope),
      items: sortedItems,
      counts: countsFor(sortedItems),
      preconditions: preconditions.sort((left, right) => left.key.localeCompare(right.key)),
    },
  };
};

const requestHash = (target: DeletionTargetSnapshot) =>
  hash(
    stableJson({
      operation: deletionOperationKind,
      version: target.version,
      scopeDigest: target.scopeDigest,
    }),
  );

const readControlRequest = (store: DrizzleProjectStore, requestKey: RequestKey) =>
  decodeRows(
    Schema.Array(ControlRequestRow),
    store
      .select({
        operation_kind: controlRequests.operationKind,
        request_sha256: controlRequests.requestSha256,
        state: controlRequests.state,
        result_json: controlRequests.resultJson,
      })
      .from(controlRequests)
      .where(eq(controlRequests.requestKey, requestKey))
      .limit(1)
      .all(),
  )[0] ?? null;

const readIntent = (store: DrizzleProjectStore, requestKey: RequestKey) =>
  decodeRows(
    Schema.Array(IntentRow),
    store
      .select({
        deletion_id: deletionIntents.deletionId,
        request_key: deletionIntents.requestKey,
        phase: deletionIntents.phase,
        target_snapshot_json: deletionIntents.targetSnapshotJson,
      })
      .from(deletionIntents)
      .where(eq(deletionIntents.requestKey, requestKey))
      .limit(1)
      .all(),
  )[0] ?? null;

const decodeTarget = (json: string): DeletionTargetSnapshot => {
  return Schema.decodeUnknownSync(DeletionTargetSnapshotSchema)(JSON.parse(json));
};

const readTargetForScope = (store: DrizzleProjectStore, scope: DeletionScope) => {
  // The transaction-level drift check reuses the same authoritative reader.
  // Its async owned-file walk is intentionally omitted here: the database
  // preconditions protect records, while the no-follow unlinker protects each
  // discovered file at the final external boundary.
  const runs = readRuns(store);
  const occurrences = readOccurrences(store);
  const schedules = readSchedules(store);
  const runsById = new Map(runs.map((run) => [run.run_id, run]));
  const schedulesByKey = new Map(schedules.map((schedule) => [schedule.schedule_key, schedule]));
  const generations = readSubmitGenerations(
    store,
    runs.map((run) => run.run_id),
  );
  const providerCleanup = readProviderCleanupExpectations(
    store,
    runs.map((run) => run.run_id),
  );
  const items: Array<DeletionWorkItem> = [];
  const preconditions: Array<{ readonly key: string; readonly value: string }> = [];
  if (scope.kind === "run") {
    const root = runsById.get(scope.runId);
    if (root === undefined || root.parent_run_id !== null) return undefined;
    const tree: Array<StoredRun> = [];
    const queue = [root.run_id];
    while (queue.length > 0) {
      const runId = queue.shift() as string;
      const run = runsById.get(runId);
      if (run === undefined) return undefined;
      tree.push(run);
      for (const child of runs.filter((candidate) => candidate.parent_run_id === runId)) {
        queue.push(child.run_id);
      }
    }
    if (tree.some((run) => !finalRunStates.has(run.state))) return undefined;
    items.push(...runItems(tree, generations, providerCleanup));
    for (const occurrence of occurrences.filter((row) =>
      tree.some((run) => run.run_id === row.linked_run_id),
    )) {
      items.push(occurrenceItem(occurrence));
    }
    for (const run of tree) {
      preconditions.push({
        key: `run:${run.run_id}`,
        value: `${run.row_version}:${run.state}:${run.last_event_sequence}:${run.parent_run_id ?? ""}`,
      });
    }
  } else if (scope.kind === "occurrences") {
    const selectedKeys = requestedScheduleKeys(scope);
    const selected = occurrences.filter(
      (row) =>
        row.scheduled_at_ms < scope.beforeMs &&
        (selectedKeys === undefined || selectedKeys.has(row.schedule_key)),
    );
    items.push(...selected.map(occurrenceItem));
    for (const occurrence of selected) {
      preconditions.push({
        key: occurrenceItem(occurrence).key,
        value: `${occurrence.row_version}:${occurrence.outcome}:${occurrence.linked_run_id ?? ""}:${occurrence.deleted_run_id ?? ""}`,
      });
    }
  } else if (scope.kind === "schedule") {
    const schedule = schedulesByKey.get(scope.scheduleKey);
    if (schedule === undefined) return undefined;
    const scheduleOccurrences = occurrences.filter((row) => row.schedule_key === scope.scheduleKey);
    if (
      scheduleOccurrences.some(
        (occurrence) =>
          !occurrenceIsFinal(occurrence, runsById) ||
          (occurrence.linked_run_id !== null && !runsById.has(occurrence.linked_run_id)),
      )
    ) {
      return undefined;
    }
    items.push(scheduleItem(schedule));
    for (const occurrence of scheduleOccurrences) items.push(occurrenceItem(occurrence));
    preconditions.push({
      key: scheduleItem(schedule).key,
      value: `${schedule.row_version}:${schedule.enabled_intent}:${schedule.condition}:${schedule.updated_at_ms}`,
    });
    for (const occurrence of scheduleOccurrences) {
      preconditions.push({
        key: occurrenceItem(occurrence).key,
        value: `${occurrence.row_version}:${occurrence.outcome}:${occurrence.linked_run_id ?? ""}`,
      });
      if (occurrence.linked_run_id !== null) {
        const run = runsById.get(occurrence.linked_run_id);
        if (run === undefined) return undefined;
        preconditions.push({
          key: `run:${run.run_id}`,
          value: `${run.row_version}:${run.state}:${run.last_event_sequence}:${run.parent_run_id ?? ""}`,
        });
      }
    }
  } else {
    items.push(
      ...schedules.map(scheduleItem),
      ...occurrences.map(occurrenceItem),
      ...runItems(runs, generations, providerCleanup),
    );
    for (const schedule of schedules)
      preconditions.push({
        key: scheduleItem(schedule).key,
        value: `${schedule.row_version}:${schedule.enabled_intent}:${schedule.condition}:${schedule.updated_at_ms}`,
      });
    for (const run of runs)
      preconditions.push({
        key: `run:${run.run_id}`,
        value: `${run.row_version}:${run.state}:${run.last_event_sequence}:${run.parent_run_id ?? ""}`,
      });
  }
  const sortedItems = [...items].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key),
  );
  return {
    version: 1 as const,
    scope,
    scopeDigest: deletionScopeDigest(scope),
    items: sortedItems,
    counts: countsFor(sortedItems),
    preconditions: preconditions.sort((left, right) => left.key.localeCompare(right.key)),
  } satisfies DeletionTargetSnapshot;
};

const preconditionsMatch = (expected: DeletionTargetSnapshot, actual: DeletionTargetSnapshot) =>
  expected.scopeDigest === actual.scopeDigest &&
  stableJson(expected.preconditions) === stableJson(actual.preconditions);

const ownedFileItems = (target: DeletionTargetSnapshot) =>
  target.items.filter((item) => item.kind === "owned-file");

const ownedFilesMatch = (expected: DeletionTargetSnapshot, actual: DeletionTargetSnapshot) =>
  stableJson(ownedFileItems(expected)) === stableJson(ownedFileItems(actual));

const addOwnedFiles = (
  expected: DeletionTargetSnapshot,
  actual: DeletionTargetSnapshot,
): ReadonlyArray<DeletionWorkItem> => {
  const known = new Set(ownedFileItems(expected).map((item) => item.key));
  return ownedFileItems(actual).filter((item) => !known.has(item.key));
};

const warningFor = (safeErrorCode: string | null) => {
  switch (safeErrorCode) {
    case "provider-unsupported":
      return {
        code: "provider-unsupported" as const,
        message: "The configured Provider does not support cleanup for this execution.",
        next: "Remove any remote Provider state separately; Kojo only confirms local logical deletion.",
      };
    case "provider-failed":
      return {
        code: "provider-failed" as const,
        message: "The Provider cleanup request failed after local deletion completed.",
        next: "Inspect the Provider and remove any remote session or workspace separately.",
      };
    case "owned-file-missing":
      return {
        code: "owned-file-missing" as const,
        message: "Some Kojo-owned execution files were already missing.",
        next: "Local logical deletion completed; physical erasure cannot be proven.",
      };
    default:
      return undefined;
  }
};

const makeReceipt = (
  requestKey: RequestKey,
  counts: DeletionTargetSnapshot["counts"],
  warnings: DeletionReceipt["warnings"],
  completedAtMs: number,
): DeletionReceipt => ({
  version: 1,
  requestKey,
  completedAtMs,
  counts,
  warnings,
});

const decodeReceipt = (json: string): DeletionReceipt =>
  Schema.decodeUnknownSync(DeletionReceiptSchema)(JSON.parse(json));

const IntentSnapshotRow = Schema.Struct({ target_snapshot_json: Schema.String });

const readIntentSnapshot = (store: DrizzleProjectStore, deletionId: string) =>
  decodeRows(
    Schema.Array(IntentSnapshotRow),
    store
      .select({ target_snapshot_json: deletionIntents.targetSnapshotJson })
      .from(deletionIntents)
      .where(eq(deletionIntents.deletionId, deletionId))
      .limit(1)
      .all(),
  )[0] ?? null;

const clearProjectExecutionRecords = (store: DrizzleProjectStore, requestKey: RequestKey) => {
  // Keep only the schema, store identity, and the current target-free receipt.
  // These are Kojo-owned records. Effect Workflow state is private to the
  // LocalWorkflowBackend and is cleared through its adapter seam before this
  // transaction runs.
  store.delete(executionEventArtifacts).run();
  store.delete(executionArtifacts).run();
  store.delete(executionEvents).run();
  store.delete(workflowActivityAttempts).run();
  store.delete(workflowActivityOperations).run();
  store.delete(engineOperations).run();
  store.delete(workflowScheduleOccurrences).run();
  store.delete(workflowRuns).run();
  store.delete(workflowScheduleStates).run();
  store.delete(retentionPolicy).run();
  store.delete(deletionItems).run();
  store.delete(deletionIntents).run();
  store.delete(controlRequests).where(ne(controlRequests.requestKey, requestKey)).run();
};

const purgeExpiredReceipts = (store: DrizzleProjectStore, nowMs: number) =>
  store
    .delete(controlRequests)
    .where(
      and(
        eq(controlRequests.operationKind, deletionOperationKind),
        eq(controlRequests.state, "completed"),
        isNotNull(controlRequests.expiresAtMs),
        lte(controlRequests.expiresAtMs, nowMs),
      ),
    )
    .run();

const completeRecordDeletion = (
  store: DrizzleProjectStore,
  deletionId: string,
  requestKey: RequestKey,
  target: DeletionTargetSnapshot,
  nowMs: number,
) => {
  const scope = target.scope;
  const runIds = target.items
    .filter(
      (item): item is Extract<DeletionWorkItem, { readonly kind: "run" }> => item.kind === "run",
    )
    .map((item) => item.runId);
  const warningRows = decodeRows(
    WarningRows,
    store
      .select({ safe_error_code: deletionItems.safeErrorCode })
      .from(deletionItems)
      .where(and(eq(deletionItems.deletionId, deletionId), eq(deletionItems.state, "warning")))
      .orderBy(asc(deletionItems.stableOrder))
      .all(),
  );
  const warnings = warningRows.flatMap((row) => {
    const warning = warningFor(row.safe_error_code);
    return warning === undefined ? [] : [warning];
  });
  if (scope.kind === "run") {
    for (const runId of runIds) {
      store
        .update(workflowScheduleOccurrences)
        .set({
          linkedRunId: null,
          deletedRunId: runId,
          deletedRunAtMs: nowMs,
          rowVersion: sql`${workflowScheduleOccurrences.rowVersion} + 1`,
        })
        .where(eq(workflowScheduleOccurrences.linkedRunId, runId))
        .run();
    }
    for (const runId of [...runIds].sort((left, right) => right.localeCompare(left))) {
      store.delete(workflowRuns).where(eq(workflowRuns.runId, runId)).run();
    }
  } else if (scope.kind === "occurrences") {
    for (const item of target.items.filter((candidate) => candidate.kind === "occurrence")) {
      const scheduleKey = item.scheduleKey;
      const scheduledAtMs = item.scheduledAtMs;
      if (scheduleKey === undefined || scheduledAtMs === undefined) {
        throw new Error("Project deletion occurrence item is invalid");
      }
      store
        .delete(workflowScheduleOccurrences)
        .where(
          and(
            eq(workflowScheduleOccurrences.scheduleKey, scheduleKey),
            eq(workflowScheduleOccurrences.scheduledAtMs, scheduledAtMs),
          ),
        )
        .run();
    }
  } else if (scope.kind === "schedule") {
    store
      .delete(workflowScheduleOccurrences)
      .where(eq(workflowScheduleOccurrences.scheduleKey, scope.scheduleKey))
      .run();
    store
      .delete(workflowScheduleStates)
      .where(eq(workflowScheduleStates.scheduleKey, scope.scheduleKey))
      .run();
  } else {
    // Keep the Project Identity and store metadata. Everything else is
    // execution/operational state and is removed in dependency order.
    clearProjectExecutionRecords(store, requestKey);
  }

  const receipt = makeReceipt(requestKey, target.counts, warnings, nowMs);
  const resultJson = JSON.stringify(receipt);
  store
    .update(controlRequests)
    .set({
      targetKind: "none",
      targetRunId: null,
      targetScheduleKey: null,
      state: "completed",
      resultCode: scope.kind === "project" ? "project-reset" : null,
      resultEncodingVersion: 1,
      resultSchemaIdentity: "kojo.execution-deletion-receipt.v1",
      resultJson,
      resultSensitivityMapVersion: 1,
      resultSensitivityMapJson: "{}",
      resultSha256: hash(resultJson),
      completedAtMs: nowMs,
      expiresAtMs: nowMs + receiptExpiryMs,
    })
    .where(eq(controlRequests.requestKey, requestKey))
    .run();
  // Project reset clears the item rows above; the other scopes retain their
  // item history only until this intent is removed.
  store.delete(deletionItems).where(eq(deletionItems.deletionId, deletionId)).run();
  store.delete(deletionIntents).where(eq(deletionIntents.deletionId, deletionId)).run();
  return receipt;
};

export const makeDrizzleDeletionRepository = (): DeletionRepositoryShape => ({
  inspect: (project, scope) => Effect.promise(() => makeTarget(project, scope)),
  readRequest: (project, requestKey, nowMs = Date.now()) =>
    Effect.sync(() =>
      withDrizzleWritableProjectStoreTransaction(project, (store) => {
        purgeExpiredReceipts(store, nowMs);
        const control = readControlRequest(store, requestKey);
        if (control === null || control.operation_kind !== deletionOperationKind) return undefined;
        if (control.state === "completed" && control.result_json !== null) {
          return {
            _tag: "completed" as const,
            receipt: decodeReceipt(control.result_json),
          };
        }
        const intent = readIntent(store, requestKey);
        if (intent === null) return undefined;
        return {
          _tag: "pending" as const,
          deletionId: intent.deletion_id,
          phase: intent.phase,
          target: decodeTarget(intent.target_snapshot_json),
        };
      }),
    ),
  begin: (project, plan, nowMs) =>
    Effect.gen(function* () {
      const inspected = yield* Effect.promise(() => makeTarget(project, plan.target.scope));
      return yield* Effect.sync(() =>
        withDrizzleWritableProjectStoreTransaction(project, (store) => {
          purgeExpiredReceipts(store, nowMs);
          const fingerprint = requestHash(plan.target);
          const existingControl = readControlRequest(store, plan.planKey);
          if (existingControl !== null) {
            if (
              existingControl.operation_kind !== deletionOperationKind ||
              existingControl.request_sha256.length !== fingerprint.length ||
              !existingControl.request_sha256.every((value, index) => value === fingerprint[index])
            ) {
              return { _tag: "conflict" as const };
            }
            if (existingControl.state === "completed" && existingControl.result_json !== null) {
              return {
                _tag: "completed" as const,
                receipt: decodeReceipt(existingControl.result_json),
              };
            }
            const existingIntent = readIntent(store, plan.planKey);
            if (existingIntent === null) return { _tag: "in-progress" as const };
            return {
              _tag: "started" as const,
              deletionId: existingIntent.deletion_id,
              resumed: true,
            };
          }

          const activeIntent = decodeRows(
            Schema.Array(Schema.Struct({ deletion_id: Schema.String })),
            store
              .select({ deletion_id: deletionIntents.deletionId })
              .from(deletionIntents)
              .limit(1)
              .all(),
          )[0];
          if (activeIntent !== undefined) return { _tag: "in-progress" as const };

          const actual = readTargetForScope(store, plan.target.scope);
          if (
            inspected._tag !== "accepted" ||
            actual === undefined ||
            !preconditionsMatch(plan.target, actual) ||
            !ownedFilesMatch(plan.target, inspected.target)
          ) {
            return { _tag: "conflict" as const };
          }
          const deletionId = randomUUID();
          const snapshotJson = JSON.stringify(plan.target);
          store
            .insert(controlRequests)
            .values({
              requestKey: plan.planKey,
              operationKind: deletionOperationKind,
              requestSha256: fingerprint,
              targetKind: "none",
              targetRunId: null,
              targetScheduleKey: null,
              state: "pending",
              createdAtMs: nowMs,
            })
            .run();
          store
            .insert(deletionIntents)
            .values({
              deletionId,
              requestKey: plan.planKey,
              targetKind: plan.target.scope.kind,
              targetSha256: digestBytes(plan.target.scopeDigest),
              targetSnapshotJson: snapshotJson,
              phase: "quiescing",
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
            })
            .run();
          if (plan.target.items.length > 0) {
            store
              .insert(deletionItems)
              .values(
                plan.target.items.map((item, stableOrder) => ({
                  deletionId,
                  itemKind: item.kind,
                  itemKey: item.key,
                  stableOrder,
                  state: "pending" as const,
                  attemptCount: 0,
                })),
              )
              .run();
          }
          const schedules =
            plan.target.scope.kind === "schedule"
              ? [plan.target.scope.scheduleKey]
              : plan.target.scope.kind === "project"
                ? decodeRows(
                    ScheduleKeyRows,
                    store
                      .select({ schedule_key: workflowScheduleStates.scheduleKey })
                      .from(workflowScheduleStates)
                      .all(),
                  ).map((row) => row.schedule_key)
                : [];
          for (const scheduleKey of schedules) {
            store
              .update(workflowScheduleStates)
              .set({
                enabledIntent: 0,
                condition: "unavailable",
                conditionReasonCode: "project.deletion",
                nextOccurrenceMs: null,
                rowVersion: sql`${workflowScheduleStates.rowVersion} + 1`,
                updatedAtMs: nowMs,
              })
              .where(eq(workflowScheduleStates.scheduleKey, scheduleKey))
              .run();
          }
          return { _tag: "started" as const, deletionId, resumed: false };
        }),
      );
    }),
  readItems: (project, deletionId) =>
    Effect.sync(() =>
      withDrizzleReadableProjectStore(project, (store) => {
        const intent = readIntentSnapshot(store, deletionId);
        if (intent === null) return [];
        const target = decodeTarget(intent.target_snapshot_json);
        const decodedStates = decodeRows(
          DeletionItemRows,
          store
            .select({
              item_kind: deletionItems.itemKind,
              item_key: deletionItems.itemKey,
              state: deletionItems.state,
              safe_error_code: deletionItems.safeErrorCode,
            })
            .from(deletionItems)
            .where(eq(deletionItems.deletionId, deletionId))
            .all(),
        );
        const states = new Map(
          decodedStates.map((row) => [`${row.item_kind}:${row.item_key}`, row] as const),
        );
        return target.items.map((item) => {
          const state = states.get(`${item.kind}:${item.key}`);
          return {
            item,
            state: state?.state ?? "pending",
            safeErrorCode: state?.safe_error_code ?? null,
          };
        });
      }),
    ),
  markItem: (project, deletionId, item, state, safeErrorCode) =>
    Effect.sync(() =>
      withDrizzleWritableProjectStoreTransaction(project, (store) => {
        const where = and(
          eq(deletionItems.deletionId, deletionId),
          eq(deletionItems.itemKind, item.kind),
          eq(deletionItems.itemKey, item.key),
        );
        if (state === "completed") {
          store
            .update(deletionItems)
            .set({
              state: "completed",
              completedAtMs: Date.now(),
              safeErrorCode: null,
              attemptCount: sql`${deletionItems.attemptCount} + 1`,
            })
            .where(and(where, ne(deletionItems.state, "completed")))
            .run();
        } else {
          store
            .update(deletionItems)
            .set({
              state,
              completedAtMs: null,
              safeErrorCode: safeErrorCode ?? null,
              attemptCount: sql`${deletionItems.attemptCount} + 1`,
            })
            .where(where)
            .run();
        }
      }),
    ),
  reconcileOwnedFiles: (project, deletionId) =>
    Effect.gen(function* () {
      const persisted = yield* Effect.sync(() =>
        withDrizzleReadableProjectStore(project, (store) => {
          const intent = readIntentSnapshot(store, deletionId);
          return intent === null ? undefined : decodeTarget(intent.target_snapshot_json);
        }),
      );
      if (persisted === undefined) return { _tag: "needs-attention" as const };
      const inspected = yield* Effect.promise(() => makeTarget(project, persisted.scope));
      if (inspected._tag === "rejected") return { _tag: "needs-attention" as const };
      const additions = addOwnedFiles(persisted, inspected.target);
      // Confirmation is an immutable capability boundary. A file discovered
      // after intent was recorded was never authorized by the confirmed
      // snapshot, so it must remain untouched and force deterministic
      // needs-attention recovery. The caller persists that phase/code without
      // changing the target snapshot or item rows.
      return additions.length === 0
        ? { _tag: "unchanged" as const }
        : { _tag: "needs-attention" as const };
    }),
  setPhase: (project, deletionId, phase, safeErrorCode) =>
    Effect.sync(() =>
      withDrizzleWritableProjectStoreTransaction(project, (store) => {
        store
          .update(deletionIntents)
          .set({ phase, safeErrorCode: safeErrorCode ?? null, updatedAtMs: Date.now() })
          .where(eq(deletionIntents.deletionId, deletionId))
          .run();
      }),
    ),
  complete: (project, deletionId, nowMs) =>
    Effect.sync(() =>
      withDrizzleWritableProjectStoreTransaction(project, (store) => {
        const intent = decodeRows(
          Schema.Array(
            Schema.Struct({ request_key: Schema.String, target_snapshot_json: Schema.String }),
          ),
          store
            .select({
              request_key: deletionIntents.requestKey,
              target_snapshot_json: deletionIntents.targetSnapshotJson,
            })
            .from(deletionIntents)
            .where(eq(deletionIntents.deletionId, deletionId))
            .limit(1)
            .all(),
        )[0];
        if (intent === undefined) throw new Error("Project deletion intent is missing");
        return completeRecordDeletion(
          store,
          deletionId,
          Schema.decodeUnknownSync(RequestKeySchema)(intent.request_key),
          decodeTarget(intent.target_snapshot_json),
          nowMs,
        );
      }),
    ),
  hasCompletedProjectReset: (project) =>
    Effect.sync(() =>
      withDrizzleReadableProjectStore(
        project,
        (store) =>
          decodeRows(
            Schema.Array(Schema.Struct({ request_key: Schema.String })),
            store
              .select({ request_key: controlRequests.requestKey })
              .from(controlRequests)
              .where(
                and(
                  eq(controlRequests.operationKind, deletionOperationKind),
                  eq(controlRequests.state, "completed"),
                  eq(controlRequests.resultCode, "project-reset"),
                  gt(controlRequests.expiresAtMs, Date.now()),
                ),
              )
              .limit(1)
              .all(),
          ).length > 0,
      ),
    ),
});

export const DrizzleDeletionRepositoryLive = Layer.succeed(
  DeletionRepository,
  makeDrizzleDeletionRepository(),
);

/** Only used by focused repository tests to assert the store path seam. */
export const deletionStorePath = (project: ProjectSnapshot) => {
  const path = databasePath(project.path);
  assertDatabaseFile(path);
  return path;
};
