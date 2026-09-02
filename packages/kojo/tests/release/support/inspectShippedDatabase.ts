import { Database } from "bun:sqlite";

const databasePath = process.argv[2];
const runId = process.argv[3];
if (databasePath === undefined || runId === undefined) {
  throw new Error("usage: inspectShippedDatabase.ts DATABASE RUN_ID");
}

const database = new Database(databasePath, { readonly: true, strict: true });
const count = (table: string, predicate: string): number => {
  const row = database
    .query<{ readonly count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`,
    )
    .get(runId);
  return row?.count ?? 0;
};

const evidence = {
  run: count("workflow_runs", "run_id = ?"),
  phaseResults: count("workflow_results", "run_id = ?"),
  gateAskings: count("gate_askings", "run_id = ?"),
  appliedGates: count("gate_askings", "run_id = ? AND state = 'applied'"),
  gateTraces: count("kojo_gates", "run_id = ?"),
  sandboxTraces: count("kojo_sandboxes", "run_id = ?"),
  sandboxResources: count(
    "project_resource_leases",
    "run_id = ? AND resource_kind = 'sandbox' AND state = 'released'",
  ),
  worktreeResources: count(
    "project_resource_leases",
    "run_id = ? AND resource_kind = 'worktree' AND state = 'released'",
  ),
  artifacts: count("retained_artifacts", "run_id = ?"),
};
database.close(false);

if (
  evidence.run !== 1 ||
  evidence.phaseResults < 2 ||
  evidence.gateAskings < 1 ||
  evidence.appliedGates < 1 ||
  evidence.gateTraces < 1 ||
  evidence.sandboxTraces < 2 ||
  evidence.sandboxResources < 2 ||
  evidence.worktreeResources < 2 ||
  evidence.artifacts < 1
) {
  throw new Error(
    `the stopped shipped database lacks required records: ${JSON.stringify(evidence)}`,
  );
}
console.log(JSON.stringify({ formatVersion: 1, runId, ...evidence }));
