import { createHash, randomUUID } from "node:crypto";
import { EXECUTION_EVENT_KINDS_V1 } from "@kojo/control";
import {
  encodeSensitivityMap,
  SENSITIVITY_MAP_VERSION,
  sensitivityMap,
} from "../../runs/models/sensitivity-map";
import type { ProjectStoreConnection } from "./project-store-adapter";

export type ArtifactUnavailableReasonCode = "artifact.missing" | "artifact.expired";

const executionEventKindsV1 = new Set<string>(EXECUTION_EVENT_KINDS_V1);

const hash = (value: string) => createHash("sha256").update(value).digest();

const nextEventSequence = (connection: ProjectStoreConnection, runId: string) =>
  (
    connection
      .query("SELECT last_event_sequence FROM kojo_workflow_runs WHERE run_id = ?")
      .get(runId) as { readonly last_event_sequence: number }
  ).last_event_sequence + 1;

const appendEvent = (
  connection: ProjectStoreConnection,
  event: {
    readonly eventId: string;
    readonly kind: string;
    readonly payload: unknown;
    readonly recordedAtMs: number;
    readonly runId: string;
    readonly sequence: number;
  },
) => {
  if (!executionEventKindsV1.has(event.kind)) {
    throw new Error(`Unsupported Execution Event v1 kind: ${event.kind}`);
  }
  const payloadJson = JSON.stringify(event.payload);
  connection
    .query(
      `INSERT INTO kojo_execution_events(
        event_id, run_id, sequence, envelope_version, kind, kind_version, recorded_at_ms,
        payload_encoding_version, payload_schema_identity, payload_json,
        payload_sensitivity_map_version, payload_sensitivity_map_json, payload_sha256
      ) VALUES (?, ?, ?, 1, ?, 1, ?, 1, 'kojo.workflow-run-event/v1', ?, ?, ?, ?)`,
    )
    .run(
      event.eventId,
      event.runId,
      event.sequence,
      event.kind,
      event.recordedAtMs,
      payloadJson,
      SENSITIVITY_MAP_VERSION,
      encodeSensitivityMap(sensitivityMap([])),
      hash(payloadJson),
    );
};

const advanceRunTrace = (
  connection: ProjectStoreConnection,
  runId: string,
  sequence: number,
  recordedAtMs: number,
) => {
  connection
    .query(
      `UPDATE kojo_workflow_runs
       SET last_event_sequence = ?, row_version = row_version + 1, updated_at_ms = ?
       WHERE run_id = ?`,
    )
    .run(sequence, recordedAtMs, runId);
};

/**
 * Appends immutable Artifact unavailability evidence and updates its metadata.
 * Callers must invoke this inside their Project Store transaction.
 */
export const recordArtifactUnavailable = (
  connection: ProjectStoreConnection,
  runId: string,
  artifactId: string,
  reasonCode: string,
  recordedAtMs: number,
): boolean => {
  const artifact = connection
    .query(
      `SELECT condition FROM kojo_execution_artifacts
       WHERE run_id = ? AND artifact_id = ?`,
    )
    .get(runId, artifactId) as {
    readonly condition: "available" | "missing" | "expired";
  } | null;
  if (artifact?.condition !== "available") return false;

  const condition = reasonCode === "artifact.expired" ? "expired" : "missing";
  const sequence = nextEventSequence(connection, runId);
  const eventId = randomUUID();
  appendEvent(connection, {
    eventId,
    kind: "artifact.unavailable",
    payload: { artifactId, condition, reasonCode },
    recordedAtMs,
    runId,
    sequence,
  });
  connection
    .query(
      `UPDATE kojo_execution_artifacts
       SET condition = ?, unavailable_at_ms = ?, unavailable_reason_code = ?
       WHERE run_id = ? AND artifact_id = ? AND condition = 'available'`,
    )
    .run(condition, recordedAtMs, reasonCode, runId, artifactId);
  connection
    .query(
      `INSERT INTO kojo_execution_event_artifacts(run_id, event_id, artifact_id, role)
       VALUES (?, ?, ?, 'unavailable')`,
    )
    .run(runId, eventId, artifactId);
  advanceRunTrace(connection, runId, sequence, recordedAtMs);
  return true;
};
