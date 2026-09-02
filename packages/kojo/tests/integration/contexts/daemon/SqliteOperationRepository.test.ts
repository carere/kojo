import { Database } from "bun:sqlite";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import { describe, expect, it } from "@effect/vitest";
import { SqliteOperationRepository } from "../../../../src/contexts/daemon/adapters/SqliteOperationRepository.ts";

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
  it("returns the original result without a second side effect for every SQLite mutation owner", () => {
    const database = new Database(":memory:", { strict: true });
    database.run(
      "CREATE TABLE domain_effects (request_id TEXT PRIMARY KEY NOT NULL, operation TEXT NOT NULL) STRICT",
    );
    const operations = new SqliteOperationRepository(database);
    const operationFamilies = [
      "registerProject",
      "relocateProject",
      "archiveProject",
      "restoreProject",
      "configureProject",
      "repairProject",
      "repairRevision",
      "collectRevision",
      "startWorkflow",
      "stopWorkflow",
      "cancelRun",
      "retryUncertainAction",
      "recordGateVerdict",
      "configureDaemon",
      "confirmDaemonConfiguration",
      "checkDaemonUpgrade",
    ] as const;

    for (const [index, operation] of operationFamilies.entries()) {
      const request: MutationEnvelope = {
        mutationVersion: 1,
        requestId: `sqlite-operation-${index}`,
        dataIdentity: "data-atomic",
        operation,
        target: {
          identityVersion: 1,
          kind:
            operation.includes("Daemon") || operation === "checkDaemonUpgrade"
              ? "daemonData"
              : "resource",
          parts: [operation, String(index)],
        },
        arguments: { operation, sequence: index },
        preconditions: { revision: index },
      };
      const apply = (): OperationReceipt => {
        const recorded = operations.readExact(request);
        if (recorded?.status === "committed") return recorded;
        const result: OperationReceipt = {
          receiptVersion: 1,
          requestId: request.requestId,
          dataIdentity: request.dataIdentity,
          operation,
          status: "committed",
          result: { operation, applied: true, sequence: index },
        };
        database
          .transaction(() => {
            database.run("INSERT INTO domain_effects VALUES (?, ?)", [
              request.requestId,
              operation,
            ]);
            operations.record(request, result, "2026-09-03T00:00:00.000Z");
          })
          .immediate();
        return result;
      };

      const first = apply();
      const replayed = apply();
      expect(replayed).toEqual(first);
      expect(
        database
          .query<{ readonly count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM domain_effects WHERE request_id = ?",
          )
          .get(request.requestId)?.count,
      ).toBe(1);
      expect(() => operations.readExact({ ...request, arguments: { replacement: true } })).toThrow(
        /different request content/,
      );
    }
    database.close(false);
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
