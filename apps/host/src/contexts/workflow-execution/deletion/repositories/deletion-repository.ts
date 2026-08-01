import type { Database } from "bun:sqlite";
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
import { Context, Effect, Layer } from "effect";
import {
  assertDatabaseFile,
  databasePath,
  transaction,
  withReadableProjectStore,
  withWritableProjectStore,
} from "../../projects/repositories/project-store-adapter";
import {
  countsFor,
  type DeletionPlanRecord,
  type DeletionTargetSnapshot,
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

interface StoredSchedule {
  readonly schedule_key: string;
  readonly enabled_intent: number;
  readonly condition: string;
  readonly condition_reason_code: string | null;
  readonly row_version: number;
  readonly updated_at_ms: number;
}

const readRuns = (connection: Database): ReadonlyArray<StoredRun> =>
  connection
    .query(
      `SELECT run_id, parent_run_id, workflow_key, workflow_revision, state,
              row_version, last_event_sequence
       FROM kojo_workflow_runs
       ORDER BY accepted_at_ms ASC, run_id ASC`,
    )
    .all() as ReadonlyArray<StoredRun>;

const readOccurrences = (connection: Database): ReadonlyArray<StoredOccurrence> =>
  connection
    .query(
      `SELECT schedule_key, scheduled_at_ms, applied_revision, outcome,
              linked_run_id, deleted_run_id, row_version, processed_at_ms
       FROM kojo_workflow_schedule_occurrences
       ORDER BY schedule_key ASC, scheduled_at_ms ASC`,
    )
    .all() as ReadonlyArray<StoredOccurrence>;

const readSchedules = (connection: Database): ReadonlyArray<StoredSchedule> =>
  connection
    .query(
      `SELECT schedule_key, enabled_intent, condition, condition_reason_code,
              row_version, updated_at_ms
       FROM kojo_workflow_schedule_states
       ORDER BY schedule_key ASC`,
    )
    .all() as ReadonlyArray<StoredSchedule>;

const readSubmitGenerations = (connection: Database, runIds: ReadonlyArray<string>) => {
  if (runIds.length === 0) return new Map<string, number>();
  const placeholders = runIds.map(() => "?").join(", ");
  const rows = connection
    .query(
      `SELECT run_id, MAX(attempt_count) AS attempt_count
       FROM kojo_engine_operations
       WHERE kind = 'submit' AND run_id IN (${placeholders})
       GROUP BY run_id`,
    )
    .all(...runIds) as ReadonlyArray<{ readonly run_id: string; readonly attempt_count: number }>;
  return new Map(rows.map((row) => [row.run_id, Math.max(1, row.attempt_count + 1)]));
};

const readArtifactRows = (connection: Database, runIds: ReadonlyArray<string>) => {
  if (runIds.length === 0) return [];
  const placeholders = runIds.map(() => "?").join(", ");
  return connection
    .query(
      `SELECT run_id, artifact_id, condition, storage_key
       FROM kojo_execution_artifacts WHERE run_id IN (${placeholders})
       ORDER BY run_id ASC, artifact_id ASC`,
    )
    .all(...runIds) as ReadonlyArray<{
    readonly run_id: string;
    readonly artifact_id: string;
    readonly condition: string;
    readonly storage_key: string;
  }>;
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
    items.push({ kind: "provider", key: `provider:${run.run_id}`, runId: run.run_id });
  }
  return items;
};

const occurrenceItem = (occurrence: StoredOccurrence): DeletionWorkItem => ({
  kind: "occurrence",
  key: `occurrence:${occurrence.schedule_key}:${occurrence.scheduled_at_ms}`,
  scheduleKey: occurrence.schedule_key,
  scheduledAtMs: occurrence.scheduled_at_ms,
});

const scheduleItem = (schedule: StoredSchedule): DeletionWorkItem => ({
  kind: "schedule",
  key: `schedule:${schedule.schedule_key}`,
  scheduleKey: schedule.schedule_key,
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
  const read = withReadableProjectStore(project, (connection) => {
    const runs = readRuns(connection);
    const occurrences = readOccurrences(connection);
    const schedules = readSchedules(connection);
    const runsById = new Map(runs.map((run) => [run.run_id, run]));
    const schedulesByKey = new Map(schedules.map((schedule) => [schedule.schedule_key, schedule]));
    const generations = readSubmitGenerations(
      connection,
      runs.map((run) => run.run_id),
    );
    return { runs, occurrences, schedules, runsById, schedulesByKey, generations };
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
    items.push(...runItems(selectedRuns, read.generations));
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
      ...runItems(selectedRuns, read.generations),
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
    const artifactRows = withReadableProjectStore(project, (connection) =>
      readArtifactRows(
        connection,
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

const readControlRequest = (connection: Database, requestKey: RequestKey) =>
  connection
    .query(
      `SELECT operation_kind, request_sha256, state, result_json
       FROM kojo_control_requests WHERE request_key = ?`,
    )
    .get(requestKey) as {
    readonly operation_kind: string;
    readonly request_sha256: Uint8Array;
    readonly state: "pending" | "completed" | "needs-attention";
    readonly result_json: string | null;
  } | null;

const readIntent = (connection: Database, requestKey: RequestKey) =>
  connection
    .query(
      `SELECT deletion_id, request_key, phase, target_snapshot_json
       FROM kojo_deletion_intents WHERE request_key = ?`,
    )
    .get(requestKey) as {
    readonly deletion_id: string;
    readonly request_key: RequestKey;
    readonly phase: DeletionPhase;
    readonly target_snapshot_json: string;
  } | null;

const decodeTarget = (json: string): DeletionTargetSnapshot => {
  const decoded = JSON.parse(json) as DeletionTargetSnapshot;
  if (decoded.version !== 1 || typeof decoded.scopeDigest !== "string") {
    throw new Error("Project deletion target snapshot is invalid");
  }
  return decoded;
};

const readTargetForScope = (connection: Database, scope: DeletionScope) => {
  // The transaction-level drift check reuses the same authoritative reader.
  // Its async owned-file walk is intentionally omitted here: the database
  // preconditions protect records, while the no-follow unlinker protects each
  // discovered file at the final external boundary.
  const runs = readRuns(connection);
  const occurrences = readOccurrences(connection);
  const schedules = readSchedules(connection);
  const runsById = new Map(runs.map((run) => [run.run_id, run]));
  const schedulesByKey = new Map(schedules.map((schedule) => [schedule.schedule_key, schedule]));
  const generations = readSubmitGenerations(
    connection,
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
    items.push(...runItems(tree, generations));
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
      ...runItems(runs, generations),
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

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

const clearProjectExecutionRows = (connection: Database, requestKey: RequestKey) => {
  // Keep only the schema, store identity, and the current target-free receipt.
  // The Effect Workflow tables are private implementation state, but they are
  // still part of the Project database and must not survive a Project reset.
  connection.query("DELETE FROM kojo_execution_event_artifacts").run();
  connection.query("DELETE FROM kojo_execution_artifacts").run();
  connection.query("DELETE FROM kojo_execution_events").run();
  connection.query("DELETE FROM kojo_workflow_activity_attempts").run();
  connection.query("DELETE FROM kojo_workflow_activity_operations").run();
  connection.query("DELETE FROM kojo_engine_operations").run();
  connection.query("DELETE FROM kojo_workflow_schedule_occurrences").run();
  connection.query("DELETE FROM kojo_workflow_runs").run();
  connection.query("DELETE FROM kojo_workflow_schedule_states").run();
  connection.query("DELETE FROM kojo_retention_policy").run();
  connection.query("DELETE FROM kojo_deletion_items").run();
  connection.query("DELETE FROM kojo_deletion_intents").run();
  connection.query("DELETE FROM kojo_control_requests WHERE request_key != ?").run(requestKey);

  // Effect's current adapter uses cluster_* tables. Clear rows from every
  // private operational table except its migration ledger so a future Host
  // can reopen the same schema and rebuild a clean runner.
  const protectedTables = new Set([
    "cluster_migrations",
    "kojo_schema_migrations",
    "kojo_store_metadata",
    "kojo_control_requests",
  ]);
  const tables = connection
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as ReadonlyArray<{ readonly name: string }>;
  for (const { name } of tables) {
    if (protectedTables.has(name)) continue;
    connection.query(`DELETE FROM ${quoteIdentifier(name)}`).run();
  }
};

const completeRecordDeletion = (
  connection: Database,
  deletionId: string,
  requestKey: RequestKey,
  target: DeletionTargetSnapshot,
  nowMs: number,
) => {
  const scope = target.scope;
  const runIds = target.items
    .filter((item) => item.kind === "run" && item.runId !== undefined)
    .map((item) => item.runId as string);
  const warningRows = connection
    .query(
      `SELECT safe_error_code FROM kojo_deletion_items
       WHERE deletion_id = ? AND state = 'warning' ORDER BY stable_order ASC`,
    )
    .all(deletionId) as ReadonlyArray<{ readonly safe_error_code: string | null }>;
  const warnings = warningRows.flatMap((row) => {
    const warning = warningFor(row.safe_error_code);
    return warning === undefined ? [] : [warning];
  });
  if (scope.kind === "run") {
    for (const runId of runIds) {
      connection
        .query(
          `UPDATE kojo_workflow_schedule_occurrences
           SET linked_run_id = NULL, deleted_run_id = ?, deleted_run_at_ms = ?, row_version = row_version + 1
           WHERE linked_run_id = ?`,
        )
        .run(runId, nowMs, runId);
    }
    for (const runId of [...runIds].sort((left, right) => right.localeCompare(left))) {
      connection.query("DELETE FROM kojo_workflow_runs WHERE run_id = ?").run(runId);
    }
  } else if (scope.kind === "occurrences") {
    for (const item of target.items.filter((candidate) => candidate.kind === "occurrence")) {
      const scheduleKey = item.scheduleKey;
      const scheduledAtMs = item.scheduledAtMs;
      if (scheduleKey === undefined || scheduledAtMs === undefined) {
        throw new Error("Project deletion occurrence item is invalid");
      }
      connection
        .query(
          "DELETE FROM kojo_workflow_schedule_occurrences WHERE schedule_key = ? AND scheduled_at_ms = ?",
        )
        .run(scheduleKey, scheduledAtMs);
    }
  } else if (scope.kind === "schedule") {
    connection
      .query("DELETE FROM kojo_workflow_schedule_states WHERE schedule_key = ?")
      .run(scope.scheduleKey);
    connection
      .query("DELETE FROM kojo_workflow_schedule_occurrences WHERE schedule_key = ?")
      .run(scope.scheduleKey);
  } else {
    // Keep the Project Identity and store metadata. Everything else is
    // execution/operational state and is removed in dependency order.
    clearProjectExecutionRows(connection, requestKey);
  }

  const receipt = makeReceipt(requestKey, target.counts, warnings, nowMs);
  const resultJson = JSON.stringify(receipt);
  connection
    .query(
      `UPDATE kojo_control_requests
       SET target_kind = 'none', target_run_id = NULL, target_schedule_key = NULL,
           state = 'completed', result_code = ?, result_encoding_version = 1,
           result_schema_identity = 'kojo.execution-deletion-receipt.v1', result_json = ?,
           result_sensitivity_map_version = 1, result_sensitivity_map_json = '{}',
           result_sha256 = ?, completed_at_ms = ?, expires_at_ms = ?
       WHERE request_key = ?`,
    )
    .run(
      scope.kind === "project" ? "project-reset" : null,
      resultJson,
      hash(resultJson),
      nowMs,
      nowMs + receiptExpiryMs,
      requestKey,
    );
  // Project reset clears the item rows above; the other scopes retain their
  // item history only until this intent is removed.
  connection.query("DELETE FROM kojo_deletion_items WHERE deletion_id = ?").run(deletionId);
  connection.query("DELETE FROM kojo_deletion_intents WHERE deletion_id = ?").run(deletionId);
  return receipt;
};

export const makeDrizzleDeletionRepository = (): DeletionRepositoryShape => ({
  inspect: (project, scope) => Effect.promise(() => makeTarget(project, scope)),
  readRequest: (project, requestKey) =>
    Effect.sync(() =>
      withReadableProjectStore(project, (connection) => {
        const control = readControlRequest(connection, requestKey);
        if (control === null || control.operation_kind !== deletionOperationKind) return undefined;
        if (control.state === "completed" && control.result_json !== null) {
          return {
            _tag: "completed" as const,
            receipt: JSON.parse(control.result_json) as DeletionReceipt,
          };
        }
        const intent = readIntent(connection, requestKey);
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
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const fingerprint = requestHash(plan.target);
          const existingControl = readControlRequest(connection, plan.planKey);
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
                receipt: JSON.parse(existingControl.result_json) as DeletionReceipt,
              };
            }
            const existingIntent = readIntent(connection, plan.planKey);
            if (existingIntent === null) return { _tag: "in-progress" as const };
            return {
              _tag: "started" as const,
              deletionId: existingIntent.deletion_id,
              resumed: true,
            };
          }

          const activeIntent = connection
            .query("SELECT deletion_id FROM kojo_deletion_intents LIMIT 1")
            .get() as { readonly deletion_id: string } | null;
          if (activeIntent !== null) return { _tag: "in-progress" as const };

          const actual = readTargetForScope(connection, plan.target.scope);
          if (actual === undefined || !preconditionsMatch(plan.target, actual)) {
            return { _tag: "conflict" as const };
          }
          const deletionId = randomUUID();
          connection
            .query(
              `INSERT INTO kojo_control_requests(
                request_key, operation_kind, request_sha256, target_kind, state, created_at_ms
              ) VALUES (?, ?, ?, 'none', 'pending', ?)`,
            )
            .run(plan.planKey, deletionOperationKind, fingerprint, nowMs);
          const snapshotJson = JSON.stringify(plan.target);
          connection
            .query(
              `INSERT INTO kojo_deletion_intents(
                deletion_id, request_key, target_kind, target_sha256, target_snapshot_json,
                phase, created_at_ms, updated_at_ms
              ) VALUES (?, ?, ?, ?, ?, 'quiescing', ?, ?)`,
            )
            .run(
              deletionId,
              plan.planKey,
              plan.target.scope.kind,
              digestBytes(plan.target.scopeDigest),
              snapshotJson,
              nowMs,
              nowMs,
            );
          for (const [stableOrder, item] of plan.target.items.entries()) {
            connection
              .query(
                `INSERT INTO kojo_deletion_items(
                  deletion_id, item_kind, item_key, stable_order, state, attempt_count
                ) VALUES (?, ?, ?, ?, 'pending', 0)`,
              )
              .run(deletionId, item.kind, item.key, stableOrder);
          }
          const schedules =
            plan.target.scope.kind === "schedule"
              ? [plan.target.scope.scheduleKey]
              : plan.target.scope.kind === "project"
                ? (
                    connection
                      .query("SELECT schedule_key FROM kojo_workflow_schedule_states")
                      .all() as ReadonlyArray<{ readonly schedule_key: string }>
                  ).map((row) => row.schedule_key)
                : [];
          for (const scheduleKey of schedules) {
            connection
              .query(
                `UPDATE kojo_workflow_schedule_states
                 SET enabled_intent = 0, condition = 'unavailable',
                     condition_reason_code = 'project.deletion', next_occurrence_ms = NULL,
                     row_version = row_version + 1, updated_at_ms = ?
                 WHERE schedule_key = ?`,
              )
              .run(nowMs, scheduleKey);
          }
          return { _tag: "started" as const, deletionId, resumed: false };
        }),
      ),
    ),
  readItems: (project, deletionId) =>
    Effect.sync(() =>
      withReadableProjectStore(project, (connection) => {
        const intent = connection
          .query("SELECT target_snapshot_json FROM kojo_deletion_intents WHERE deletion_id = ?")
          .get(deletionId) as { readonly target_snapshot_json: string } | null;
        if (intent === null) return [];
        const target = decodeTarget(intent.target_snapshot_json);
        const states = new Map(
          (
            connection
              .query(
                `SELECT item_kind, item_key, state, safe_error_code
               FROM kojo_deletion_items WHERE deletion_id = ?`,
              )
              .all(deletionId) as ReadonlyArray<{
              readonly item_kind: DeletionWorkItem["kind"];
              readonly item_key: string;
              readonly state: DeletionItemStatus;
              readonly safe_error_code: string | null;
            }>
          ).map((row) => [`${row.item_kind}:${row.item_key}`, row]),
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
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          if (state === "completed") {
            connection
              .query(
                `UPDATE kojo_deletion_items
                 SET state = 'completed', completed_at_ms = ?, safe_error_code = NULL,
                     attempt_count = attempt_count + 1
                 WHERE deletion_id = ? AND item_kind = ? AND item_key = ? AND state != 'completed'`,
              )
              .run(Date.now(), deletionId, item.kind, item.key);
          } else {
            connection
              .query(
                `UPDATE kojo_deletion_items
                 SET state = ?, completed_at_ms = NULL, safe_error_code = ?,
                     attempt_count = attempt_count + 1
                 WHERE deletion_id = ? AND item_kind = ? AND item_key = ?`,
              )
              .run(state, safeErrorCode ?? null, deletionId, item.kind, item.key);
          }
        }),
      ),
    ),
  setPhase: (project, deletionId, phase, safeErrorCode) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          connection
            .query(
              `UPDATE kojo_deletion_intents
               SET phase = ?, safe_error_code = ?, updated_at_ms = ? WHERE deletion_id = ?`,
            )
            .run(phase, safeErrorCode ?? null, Date.now(), deletionId);
        }),
      ),
    ),
  complete: (project, deletionId, nowMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const intent = connection
            .query(
              `SELECT request_key, target_snapshot_json FROM kojo_deletion_intents WHERE deletion_id = ?`,
            )
            .get(deletionId) as {
            readonly request_key: RequestKey;
            readonly target_snapshot_json: string;
          } | null;
          if (intent === null) throw new Error("Project deletion intent is missing");
          return completeRecordDeletion(
            connection,
            deletionId,
            intent.request_key,
            decodeTarget(intent.target_snapshot_json),
            nowMs,
          );
        }),
      ),
    ),
  hasCompletedProjectReset: (project) =>
    Effect.sync(() =>
      withReadableProjectStore(
        project,
        (connection) =>
          connection
            .query(
              `SELECT 1 FROM kojo_control_requests
             WHERE operation_kind = 'execution.delete'
               AND state = 'completed'
               AND result_code = 'project-reset'
               AND expires_at_ms > ?
             LIMIT 1`,
            )
            .get(Date.now()) !== null,
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
