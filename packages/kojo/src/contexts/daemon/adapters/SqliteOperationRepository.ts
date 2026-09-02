import type { Database } from "bun:sqlite";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import {
  decodeOperationReceipt,
  type OperationReceipt,
} from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { ProjectStoreError } from "../../project/models/ProjectStoreError.ts";
import { canonicalJson } from "../../workflow/services/canonicalJson.ts";
import type { OperationRepository } from "../ports/OperationRepository.ts";

interface OperationRow {
  readonly request_json: string;
  readonly receipt_json: string;
}

const conflict = (): ProjectStoreError =>
  new ProjectStoreError({
    code: "REQUEST_ID_CONFLICT",
    message: "This request ID already names different request content or outcome.",
    status: 409,
    retry: "lookupOriginal",
    remedy: "Look up the original request and its recorded outcome.",
  });

const receiptOf = (encoded: string): OperationReceipt => {
  const decoded = decodeOperationReceipt(JSON.parse(encoded) as unknown);
  if (!decoded.ok) throw new Error("The recorded operation outcome is damaged.");
  return decoded.value;
};

/** SQLite operation adapter. record never starts a transaction, so it joins the caller's write. */
export class SqliteOperationRepository implements OperationRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
    database.run(`CREATE TABLE IF NOT EXISTS daemon_operations (
      data_identity TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (data_identity, request_id)
    ) STRICT`);
  }

  readonly read = (dataIdentity: string, requestId: string): OperationReceipt | undefined => {
    const row = this.#database
      .query<Pick<OperationRow, "receipt_json">, [string, string]>(
        "SELECT receipt_json FROM daemon_operations WHERE data_identity = ? AND request_id = ?",
      )
      .get(dataIdentity, requestId);
    return row === null ? undefined : receiptOf(row.receipt_json);
  };

  readonly readExact = (request: MutationEnvelope): OperationReceipt | undefined => {
    const row = this.#database
      .query<OperationRow, [string, string]>(
        "SELECT request_json, receipt_json FROM daemon_operations WHERE data_identity = ? AND request_id = ?",
      )
      .get(request.dataIdentity, request.requestId);
    if (row === null) return undefined;
    if (row.request_json !== canonicalJson(request)) throw conflict();
    return receiptOf(row.receipt_json);
  };

  readonly record = (
    request: MutationEnvelope,
    receipt: OperationReceipt,
    recordedAt: string,
  ): OperationReceipt => {
    if (
      receipt.requestId !== request.requestId ||
      receipt.dataIdentity !== request.dataIdentity ||
      receipt.operation !== request.operation
    ) {
      throw conflict();
    }
    const requestJson = canonicalJson(request);
    const receiptJson = canonicalJson(receipt as unknown as JsonValue);
    const prior = this.#database
      .query<OperationRow, [string, string]>(
        "SELECT request_json, receipt_json FROM daemon_operations WHERE data_identity = ? AND request_id = ?",
      )
      .get(request.dataIdentity, request.requestId);
    if (prior !== null) {
      if (prior.request_json !== requestJson) throw conflict();
      const priorReceipt = receiptOf(prior.receipt_json);
      if (priorReceipt.status === "committed") {
        if (prior.receipt_json !== receiptJson) throw conflict();
        return priorReceipt;
      }
      if (receipt.status === "accepted") {
        if (prior.receipt_json !== receiptJson) throw conflict();
        return priorReceipt;
      }
      this.#database.run(
        `UPDATE daemon_operations SET receipt_json = ?, recorded_at = ?
          WHERE data_identity = ? AND request_id = ?`,
        [receiptJson, recordedAt, request.dataIdentity, request.requestId],
      );
      return receipt;
    }
    this.#database.run(
      `INSERT INTO daemon_operations
         (data_identity, request_id, request_json, receipt_json, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
      [request.dataIdentity, request.requestId, requestJson, receiptJson, recordedAt],
    );
    return receipt;
  };
}
