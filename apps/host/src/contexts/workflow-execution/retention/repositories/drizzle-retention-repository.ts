import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type {
  ProjectRetentionPolicy,
  ProjectRetentionSetInput,
  ProjectRetentionSnapshot,
  ProjectRetentionWarning,
  ProjectSnapshot,
  RequestKey,
} from "@kojo/control";
import { Effect, Layer } from "effect";
import {
  transaction,
  withReadableProjectStore,
  withWritableProjectStore,
} from "../../projects/repositories/drizzle-project-repository";
import {
  DEFAULT_DIAGNOSTIC_MAX_AGE_MS,
  DEFAULT_DIAGNOSTIC_MAX_BYTES,
  DEFAULT_DISPOSABLE_MAX_AGE_MS,
  DEFAULT_DISPOSABLE_MAX_BYTES,
  DEFAULT_HOST_DIAGNOSTIC_MAX_AGE_MS,
  DEFAULT_HOST_DIAGNOSTIC_MAX_BYTES,
  type DisposableRetentionCandidate,
  effectiveRetentionPolicy,
  planDisposableCleanup,
  type StoredRetentionPolicyRow,
} from "../models/retention-policy";
import { RetentionRepository, type RetentionRepositoryShape } from "./retention-repository";

interface StoredArtifactRow {
  readonly artifact_id: string;
  readonly run_id: string;
  readonly storage_key: string;
  readonly byte_size: number;
  readonly condition: "available" | "missing" | "expired";
  readonly created_at_ms: number;
  readonly run_state: "running" | "suspended" | "stopping" | "stopped" | "failed" | "completed";
  readonly finalized_at_ms: number | null;
}

interface DisposableFile extends DisposableRetentionCandidate {
  readonly path: string;
  readonly artifactId?: string;
  readonly runId: string;
}

interface RunState {
  readonly state: StoredArtifactRow["run_state"];
  readonly finalizedAtMs: number | null;
}

interface StoredRunRow {
  readonly run_id: string;
  readonly state: RunState["state"];
  readonly finalized_at_ms: number | null;
}

const finalStates = new Set<RunState["state"]>(["stopped", "failed", "completed"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const lastCleanupAt = new Map<string, number>();

const stableJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") return JSON.stringify(String(value));
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
};

const digest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest();

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const readPolicyRow = (connection: Database): StoredRetentionPolicyRow | undefined => {
  const row = connection
    .query(
      `SELECT diagnostic_max_age_ms, diagnostic_max_bytes,
              disposable_max_age_ms, disposable_max_bytes, row_version, updated_at_ms
       FROM kojo_retention_policy WHERE singleton_key = 1`,
    )
    .get() as {
    readonly diagnostic_max_age_ms: number | null;
    readonly diagnostic_max_bytes: number | null;
    readonly disposable_max_age_ms: number | null;
    readonly disposable_max_bytes: number | null;
    readonly row_version: number;
    readonly updated_at_ms: number;
  } | null;
  return row === null
    ? undefined
    : {
        diagnosticMaxAgeMs: row.diagnostic_max_age_ms,
        diagnosticMaxBytes: row.diagnostic_max_bytes,
        disposableMaxAgeMs: row.disposable_max_age_ms,
        disposableMaxBytes: row.disposable_max_bytes,
        rowVersion: row.row_version,
        updatedAtMs: row.updated_at_ms,
      };
};

const readArtifacts = (connection: Database): ReadonlyArray<StoredArtifactRow> =>
  connection
    .query(
      `SELECT artifact.artifact_id, artifact.run_id, artifact.storage_key,
              artifact.byte_size, artifact.condition, artifact.created_at_ms,
              run.state AS run_state, run.finalized_at_ms
       FROM kojo_execution_artifacts artifact
       JOIN kojo_workflow_runs run ON run.run_id = artifact.run_id
       ORDER BY artifact.created_at_ms ASC, artifact.artifact_id ASC`,
    )
    .all() as ReadonlyArray<StoredArtifactRow>;

const readRuns = (connection: Database): ReadonlyArray<StoredRunRow> =>
  connection
    .query("SELECT run_id, state, finalized_at_ms FROM kojo_workflow_runs")
    .all() as ReadonlyArray<StoredRunRow>;

const safeArtifactPath = (project: ProjectSnapshot, row: StoredArtifactRow) => {
  if (
    !uuid.test(row.run_id) ||
    !uuid.test(row.artifact_id) ||
    row.storage_key !== `${row.run_id}/${row.artifact_id}.json`
  ) {
    return undefined;
  }
  return join(project.path, ".kojo", "artifacts", row.run_id, `${row.artifact_id}.json`);
};

const isMissing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const regularFileSize = async (path: string): Promise<number | undefined> => {
  try {
    const information = await lstat(path);
    return information.isFile() && !information.isSymbolicLink() ? information.size : undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

const walkRegularFiles = async (
  path: string,
  relative: string,
  result: Array<{ readonly path: string; readonly relative: string; readonly bytes: number }>,
) => {
  let information: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    information = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (information === undefined) return;
  if (information.isSymbolicLink()) return;
  if (information.isDirectory()) {
    for (const name of await readdir(path)) {
      await walkRegularFiles(join(path, name), join(relative, name), result);
    }
    return;
  }
  if (information.isFile()) result.push({ path, relative, bytes: information.size });
};

const collectRunDirectoryFiles = async (
  project: ProjectSnapshot,
  rootName: string,
  runs: ReadonlyMap<string, RunState>,
): Promise<ReadonlyArray<DisposableFile>> => {
  const root = join(project.path, ".kojo", rootName);
  let entries: ReadonlyArray<string>;
  try {
    entries = await readdir(root);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const result: Array<DisposableFile> = [];
  for (const runId of entries) {
    if (!uuid.test(runId)) continue;
    const run = runs.get(runId);
    if (run === undefined) continue;
    const files: Array<{
      readonly path: string;
      readonly relative: string;
      readonly bytes: number;
    }> = [];
    await walkRegularFiles(join(root, runId), "", files);
    for (const file of files) {
      result.push({
        key: `${rootName}:${runId}:${file.relative}`,
        path: file.path,
        runId,
        bytes: file.bytes,
        createdAtMs: run.finalizedAtMs ?? 0,
        finalizedAtMs: run.finalizedAtMs,
        continuationRequired: !finalStates.has(run.state),
      });
    }
  }
  return result;
};

const diagnosticFiles = async (path: string) => {
  const extension = extname(path);
  const stem = basename(path, extension);
  try {
    return (await readdir(dirname(path)))
      .filter((file) => file === basename(path) || file.startsWith(`${stem}.`))
      .filter((file) => file.endsWith(extension))
      .map((file) => join(dirname(path), file));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
};

const readDiagnosticBytes = async (path: string | undefined, identity: string) => {
  if (path === undefined) return 0;
  let bytes = 0;
  for (const candidate of await diagnosticFiles(path)) {
    for (const line of (await readFile(candidate, "utf8")).split("\n").filter(Boolean)) {
      try {
        const event = JSON.parse(line) as { readonly projectIdentity?: string };
        if (event.projectIdentity === identity) bytes += Buffer.byteLength(`${line}\n`);
      } catch {
        // Diagnostics are non-authoritative and malformed lines are omitted from usage.
      }
    }
  }
  return bytes;
};

const readSnapshot = async (
  project: ProjectSnapshot,
  nowMs: number,
  diagnosticPath?: string,
): Promise<ProjectRetentionSnapshot> => {
  const { policyRow, artifacts, runs } = withReadableProjectStore(project, (connection) => ({
    policyRow: readPolicyRow(connection),
    artifacts: readArtifacts(connection),
    runs: readRuns(connection),
  }));
  const policy = effectiveRetentionPolicy(policyRow);
  const runStates = new Map(
    runs.map((row) => [row.run_id, { state: row.state, finalizedAtMs: row.finalized_at_ms }]),
  );
  const files: Array<DisposableFile> = [];
  let availableArtifactCount = 0;
  let missingArtifactCount = 0;
  let expiredArtifactCount = 0;
  for (const artifact of artifacts) {
    if (artifact.condition === "expired") {
      expiredArtifactCount += 1;
      continue;
    }
    if (artifact.condition === "missing") {
      missingArtifactCount += 1;
      continue;
    }
    const path = safeArtifactPath(project, artifact);
    if (path === undefined) {
      missingArtifactCount += 1;
      continue;
    }
    const bytes = await regularFileSize(path);
    if (bytes === undefined) {
      missingArtifactCount += 1;
      continue;
    }
    availableArtifactCount += 1;
    files.push({
      key: `artifact:${artifact.run_id}:${artifact.artifact_id}`,
      path,
      artifactId: artifact.artifact_id,
      runId: artifact.run_id,
      bytes,
      createdAtMs: artifact.created_at_ms,
      finalizedAtMs: artifact.finalized_at_ms,
      continuationRequired: !finalStates.has(artifact.run_state),
    });
  }
  for (const rootName of ["sandboxes", "transcripts", "sessions", "agent-sessions"]) {
    files.push(...(await collectRunDirectoryFiles(project, rootName, runStates)));
  }
  const plan = planDisposableCleanup(files, policy, nowMs);
  const warnings: Array<ProjectRetentionWarning> = [];
  if (plan.protectedOverLimit) {
    warnings.push({
      code: "protected-over-limit",
      kind: "disposable",
      message: "Protected non-final execution content exceeds the disposable retention limit.",
      next: "Keep the content protected; finish or explicitly delete the related Workflow Run before reclaiming space.",
      observedAtMs: nowMs,
      currentBytes: plan.protectedBytes,
      limitBytes: policy.disposableMaxBytes,
    });
  }
  if (missingArtifactCount > 0) {
    warnings.push({
      code: "missing-retained-content",
      kind: "disposable",
      message: "Some retained Artifact content is missing, but its authoritative metadata remains.",
      next: "Inspect the Artifact trace evidence; do not treat missing bytes as a missing Workflow Run.",
      observedAtMs: nowMs,
      currentBytes: missingArtifactCount,
      limitBytes: null,
    });
  }
  return {
    project,
    policy,
    usage: {
      diagnosticBytes: await readDiagnosticBytes(diagnosticPath, project.identity),
      disposableBytes: plan.currentBytes,
      protectedDisposableBytes: plan.protectedBytes,
      eligibleDisposableBytes: plan.eligibleBytes,
      availableArtifactCount,
      missingArtifactCount,
      expiredArtifactCount,
      lastCleanupAtMs: lastCleanupAt.get(project.identity) ?? null,
    },
    warnings,
    hostDiagnosticMaxAgeMs: DEFAULT_HOST_DIAGNOSTIC_MAX_AGE_MS,
    hostDiagnosticMaxBytes: DEFAULT_HOST_DIAGNOSTIC_MAX_BYTES,
    observedAtMs: nowMs,
  };
};

const requestPayload = (input: ProjectRetentionSetInput | { readonly requestKey: RequestKey }) => {
  if (!("identity" in input)) return { operation: "reset" };
  const fields = [
    "diagnosticMaxAgeMs",
    "diagnosticMaxBytes",
    "disposableMaxAgeMs",
    "disposableMaxBytes",
  ] as const;
  return {
    operation: "set",
    ...Object.fromEntries(
      fields.filter((field) => Object.hasOwn(input, field)).map((field) => [field, input[field]]),
    ),
  };
};

const readReceipt = (connection: Database, requestKey: RequestKey) =>
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

const beginReceipt = (
  connection: Database,
  requestKey: RequestKey,
  operationKind: string,
  requestHash: Uint8Array,
  nowMs: number,
) => {
  const existing = readReceipt(connection, requestKey);
  if (existing !== null) {
    if (
      existing.operation_kind !== operationKind ||
      !sameBytes(existing.request_sha256, requestHash)
    ) {
      return { _tag: "request-key-conflict" as const };
    }
    if (existing.state === "completed" && existing.result_json !== null) {
      return {
        _tag: "already-applied" as const,
        snapshot: JSON.parse(existing.result_json) as ProjectRetentionSnapshot,
      };
    }
    return { _tag: "pending" as const };
  }
  connection
    .query(
      `INSERT INTO kojo_control_requests(
         request_key, operation_kind, request_sha256, target_kind, state, created_at_ms
       ) VALUES (?, ?, ?, 'none', 'pending', ?)`,
    )
    .run(requestKey, operationKind, requestHash, nowMs);
  return { _tag: "pending" as const };
};

const completeReceipt = (
  connection: Database,
  requestKey: RequestKey,
  snapshot: ProjectRetentionSnapshot,
  nowMs: number,
) => {
  const resultJson = JSON.stringify(snapshot);
  connection
    .query(
      `UPDATE kojo_control_requests
       SET state = 'completed', result_encoding_version = 1,
           result_schema_identity = 'kojo.retention.snapshot.v1', result_json = ?,
           result_sensitivity_map_version = 1, result_sensitivity_map_json = '{}',
           result_sha256 = ?, completed_at_ms = ?
       WHERE request_key = ?`,
    )
    .run(resultJson, createHash("sha256").update(resultJson).digest(), nowMs, requestKey);
};

const applyMutation = async (
  project: ProjectSnapshot,
  requestKey: RequestKey,
  operationKind: "retention.set" | "retention.reset",
  input: ProjectRetentionSetInput | undefined,
  diagnosticPath: string | undefined,
): Promise<
  ReturnType<RetentionRepositoryShape["set"]> extends Effect.Effect<infer A> ? A : never
> => {
  const payload = requestPayload(input ?? { requestKey });
  const requestHash = digest(payload);
  const nowMs = Date.now();
  const receipt = withWritableProjectStore(project, (connection) =>
    transaction(connection, () =>
      beginReceipt(connection, requestKey, operationKind, requestHash, nowMs),
    ),
  );
  if (receipt._tag === "request-key-conflict") return receipt;
  if (receipt._tag === "already-applied") {
    return { _tag: "success", snapshot: receipt.snapshot, alreadyApplied: true };
  }
  withWritableProjectStore(project, (connection) =>
    transaction(connection, () => {
      if (operationKind === "retention.reset") {
        connection.query("DELETE FROM kojo_retention_policy WHERE singleton_key = 1").run();
        return;
      }
      const current = effectiveRetentionPolicy(readPolicyRow(connection));
      const next: ProjectRetentionPolicy = {
        diagnosticMaxAgeMs: Object.hasOwn(input ?? {}, "diagnosticMaxAgeMs")
          ? (input?.diagnosticMaxAgeMs ?? null)
          : current.diagnosticMaxAgeMs,
        diagnosticMaxBytes: Object.hasOwn(input ?? {}, "diagnosticMaxBytes")
          ? (input?.diagnosticMaxBytes ?? null)
          : current.diagnosticMaxBytes,
        disposableMaxAgeMs: Object.hasOwn(input ?? {}, "disposableMaxAgeMs")
          ? (input?.disposableMaxAgeMs ?? null)
          : current.disposableMaxAgeMs,
        disposableMaxBytes: Object.hasOwn(input ?? {}, "disposableMaxBytes")
          ? (input?.disposableMaxBytes ?? null)
          : current.disposableMaxBytes,
      };
      const currentRow = readPolicyRow(connection);
      connection
        .query(
          `INSERT INTO kojo_retention_policy(
             singleton_key, diagnostic_max_age_ms, diagnostic_max_bytes,
             disposable_max_age_ms, disposable_max_bytes, row_version, updated_at_ms
           ) VALUES (1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(singleton_key) DO UPDATE SET
             diagnostic_max_age_ms = excluded.diagnostic_max_age_ms,
             diagnostic_max_bytes = excluded.diagnostic_max_bytes,
             disposable_max_age_ms = excluded.disposable_max_age_ms,
             disposable_max_bytes = excluded.disposable_max_bytes,
             row_version = excluded.row_version,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          next.diagnosticMaxAgeMs,
          next.diagnosticMaxBytes,
          next.disposableMaxAgeMs,
          next.disposableMaxBytes,
          (currentRow?.rowVersion ?? 0) + 1,
          nowMs,
        );
    }),
  );
  const snapshot = await readSnapshot(project, Date.now(), diagnosticPath);
  withWritableProjectStore(project, (connection) =>
    transaction(connection, () => completeReceipt(connection, requestKey, snapshot, Date.now())),
  );
  return { _tag: "success", snapshot, alreadyApplied: false };
};

const cleanupProject = async (
  project: ProjectSnapshot,
  nowMs: number,
  diagnosticPath: string | undefined,
) => {
  const {
    policyRow,
    artifacts,
    runs: runRows,
  } = withReadableProjectStore(project, (connection) => ({
    policyRow: readPolicyRow(connection),
    artifacts: readArtifacts(connection),
    runs: readRuns(connection),
  }));
  const policy = effectiveRetentionPolicy(policyRow);
  const runStates = new Map(
    runRows.map((row) => [row.run_id, { state: row.state, finalizedAtMs: row.finalized_at_ms }]),
  );
  const files: Array<DisposableFile> = [];
  const missingArtifactIds: Array<{ readonly runId: string; readonly artifactId: string }> = [];
  for (const artifact of artifacts) {
    if (artifact.condition !== "available") continue;
    const path = safeArtifactPath(project, artifact);
    if (path === undefined) {
      missingArtifactIds.push({ runId: artifact.run_id, artifactId: artifact.artifact_id });
      continue;
    }
    const bytes = await regularFileSize(path);
    if (bytes === undefined) {
      missingArtifactIds.push({ runId: artifact.run_id, artifactId: artifact.artifact_id });
      continue;
    }
    files.push({
      key: `artifact:${artifact.run_id}:${artifact.artifact_id}`,
      path,
      artifactId: artifact.artifact_id,
      runId: artifact.run_id,
      bytes,
      createdAtMs: artifact.created_at_ms,
      finalizedAtMs: artifact.finalized_at_ms,
      continuationRequired: !finalStates.has(artifact.run_state),
    });
  }
  for (const rootName of ["sandboxes", "transcripts", "sessions", "agent-sessions"]) {
    files.push(...(await collectRunDirectoryFiles(project, rootName, runStates)));
  }
  const plan = planDisposableCleanup(files, policy, nowMs);
  const removedArtifacts: Array<{ readonly runId: string; readonly artifactId: string }> = [];
  for (const candidate of plan.remove) {
    try {
      const information = await lstat(candidate.path);
      if (!information.isFile() || information.isSymbolicLink()) continue;
      await unlink(candidate.path);
      if (candidate.artifactId !== undefined) {
        removedArtifacts.push({ runId: candidate.runId, artifactId: candidate.artifactId });
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  withWritableProjectStore(project, (connection) =>
    transaction(connection, () => {
      for (const missing of missingArtifactIds) {
        connection
          .query(
            `UPDATE kojo_execution_artifacts
             SET condition = 'missing', unavailable_at_ms = ?, unavailable_reason_code = ?
             WHERE run_id = ? AND artifact_id = ? AND condition = 'available'`,
          )
          .run(nowMs, "artifact.missing", missing.runId, missing.artifactId);
      }
      for (const expired of removedArtifacts) {
        connection
          .query(
            `UPDATE kojo_execution_artifacts
             SET condition = 'expired', unavailable_at_ms = ?, unavailable_reason_code = ?
             WHERE run_id = ? AND artifact_id = ? AND condition = 'available'`,
          )
          .run(nowMs, "artifact.expired", expired.runId, expired.artifactId);
      }
    }),
  );
  lastCleanupAt.set(project.identity, nowMs);
  return readSnapshot(project, nowMs, diagnosticPath);
};

export interface DrizzleRetentionRepositoryOptions {
  readonly diagnosticPath?: string;
}

export const makeDrizzleRetentionRepository = (
  options: DrizzleRetentionRepositoryOptions = {},
): RetentionRepositoryShape => ({
  show: (project, observedAtMs = Date.now()) =>
    Effect.promise(() => readSnapshot(project, observedAtMs, options.diagnosticPath)),
  set: (project, input) =>
    Effect.promise(() =>
      applyMutation(project, input.requestKey, "retention.set", input, options.diagnosticPath),
    ),
  reset: (project, requestKey) =>
    Effect.promise(() =>
      applyMutation(project, requestKey, "retention.reset", undefined, options.diagnosticPath),
    ),
  cleanup: (project, nowMs = Date.now()) =>
    Effect.promise(() => cleanupProject(project, nowMs, options.diagnosticPath)),
});

export const DrizzleRetentionRepositoryLive = (options: DrizzleRetentionRepositoryOptions = {}) =>
  Layer.succeed(RetentionRepository, makeDrizzleRetentionRepository(options));

export const readProjectRetentionPolicy = (project: ProjectSnapshot): ProjectRetentionPolicy =>
  effectiveRetentionPolicy(withReadableProjectStore(project, readPolicyRow));

export {
  DEFAULT_DIAGNOSTIC_MAX_AGE_MS,
  DEFAULT_DIAGNOSTIC_MAX_BYTES,
  DEFAULT_DISPOSABLE_MAX_AGE_MS,
  DEFAULT_DISPOSABLE_MAX_BYTES,
};
