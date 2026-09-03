import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import { describe, expect, it } from "@effect/vitest";
import { SqliteOperationRepository } from "../../../../../src/contexts/daemon/adapters/SqliteOperationRepository.ts";
import {
  sqliteMutationOperations,
  sqliteMutationOwnerEvidence,
  sqliteMutationOwnerRegistry,
} from "../../../../support/release/SqliteMutationOwnerEvidence.ts";

const mutation = (argument = "one"): MutationEnvelope => ({
  mutationVersion: 1,
  requestId: "request-atomic",
  dataIdentity: "data-atomic",
  operation: "configureDaemon",
  target: { identityVersion: 1, kind: "daemonData", parts: ["data-atomic"] },
  arguments: { value: argument },
  preconditions: {},
});

const receipt = (status: "accepted" | "committed"): OperationReceipt => ({
  receiptVersion: 1,
  requestId: "request-atomic",
  dataIdentity: "data-atomic",
  operation: "configureDaemon",
  status,
  result: status === "accepted" ? { state: "planned" } : { state: "applied" },
});

describe("SQLite operation receipt boundary", () => {
  it("maps every SQLite mutation operation to one exact actual-owner integration leaf", () => {
    expect(sqliteMutationOwnerEvidence.map(({ operation }) => operation).toSorted()).toEqual(
      [...sqliteMutationOperations].toSorted(),
    );
    expect(new Set(sqliteMutationOwnerEvidence.map(({ operation }) => operation)).size).toBe(
      sqliteMutationOperations.length,
    );
    const root = resolve(import.meta.dirname, "../../../../../../..");
    for (const observation of sqliteMutationOwnerEvidence) {
      const source = readFileSync(resolve(root, observation.path), "utf8");
      expect(source, observation.operation).toContain(
        JSON.stringify(observation.declaration ?? observation.name),
      );
      expect(observation.owner, observation.operation).toBe(
        sqliteMutationOwnerRegistry[observation.operation].name,
      );
    }
  });

  it("rolls the domain write and receipt back as one transition at the kill point", () => {
    const database = new Database(":memory:", { strict: true });
    database.run("CREATE TABLE domain_state (value TEXT NOT NULL) STRICT");
    const operations = new SqliteOperationRepository(database);

    expect(() =>
      database
        .transaction(() => {
          database.run("INSERT INTO domain_state VALUES ('applied')");
          operations.record(mutation(), receipt("committed"), "2026-09-03T00:00:00.000Z");
          throw new Error("kill after receipt before commit");
        })
        .immediate(),
    ).toThrow("kill after receipt before commit");

    expect(database.query("SELECT * FROM domain_state").all()).toEqual([]);
    expect(operations.read("data-atomic", "request-atomic")).toBeUndefined();
    database.close(false);
  });

  it("returns one exact result, upgrades intent once, and refuses changed content", () => {
    const database = new Database(":memory:", { strict: true });
    const operations = new SqliteOperationRepository(database);
    database
      .transaction(() =>
        operations.record(mutation(), receipt("accepted"), "2026-09-03T00:00:00.000Z"),
      )
      .immediate();
    database
      .transaction(() =>
        operations.record(mutation(), receipt("committed"), "2026-09-03T00:00:01.000Z"),
      )
      .immediate();

    expect(operations.readExact(mutation())).toEqual(receipt("committed"));
    expect(() => operations.readExact(mutation("changed"))).toThrow(/different request content/);
    expect(() =>
      operations.record(
        mutation(),
        { ...receipt("committed"), result: { state: "other" } },
        "2026-09-03T00:00:02.000Z",
      ),
    ).toThrow(/different request content/);
    database.close(false);
  });
});
