import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer, Schema } from "effect";
import { ProjectStore } from "../services/project-store";
import { workflowRuns, workflowScheduleStates } from "./project-store-schema";

const ScheduleBlockerRows = Schema.Array(Schema.Struct({ scheduleKey: Schema.String }));
const RunBlockerRows = Schema.Array(Schema.Struct({ runId: Schema.String }));

const migration = readFileSync(
  fileURLToPath(new URL("./migrations/0001_project_lifecycle.sql", import.meta.url)),
  "utf8",
);

const prepare = (connection: Database) => {
  const version = connection.query("PRAGMA user_version").get() as { user_version: number };
  if (version.user_version === 0) {
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection.exec(migration);
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  } else if (version.user_version !== 1) {
    throw new Error("unsupported Project store version");
  }
  const rows = connection
    .query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?) ORDER BY name",
    )
    .all("kojo_schema_migrations", "kojo_workflow_runs", "kojo_workflow_schedule_states") as Array<{
    name: string;
    sql: string;
  }>;
  if (rows.length !== 3 || rows.some((row) => !/\bSTRICT\s*$/i.test(row.sql.trim()))) {
    throw new Error("Project store schema is incomplete or unconstrained");
  }
};

const inspect = (projectPath: string) => {
  try {
    const connection = new Database(join(projectPath, ".kojo", "kojo.sqlite"), { strict: true });
    try {
      prepare(connection);
      const store = drizzle(connection);
      const scheduleRows = store
        .select({ scheduleKey: workflowScheduleStates.scheduleKey })
        .from(workflowScheduleStates)
        .where(eq(workflowScheduleStates.enabledIntent, 1))
        .orderBy(asc(workflowScheduleStates.scheduleKey))
        .all();
      const enabledScheduleKeys = Schema.decodeUnknownSync(ScheduleBlockerRows)(scheduleRows).map(
        ({ scheduleKey }) => scheduleKey,
      );
      const runRows = store
        .select({ runId: workflowRuns.runId })
        .from(workflowRuns)
        .where(inArray(workflowRuns.state, ["running", "suspended", "stopping"]))
        .orderBy(asc(workflowRuns.runId))
        .all();
      const nonFinalRunIds = Schema.decodeUnknownSync(RunBlockerRows)(runRows).map(
        ({ runId }) => runId,
      );
      return { assessment: "available" as const, enabledScheduleKeys, nonFinalRunIds };
    } finally {
      connection.close();
    }
  } catch {
    return {
      assessment: "unavailable" as const,
      enabledScheduleKeys: [],
      nonFinalRunIds: [],
    };
  }
};

export const DrizzleProjectStoreLive = Layer.succeed(ProjectStore, {
  prepare: (project) =>
    Effect.sync(() => {
      try {
        const connection = new Database(join(project.path, ".kojo", "kojo.sqlite"), {
          strict: true,
        });
        try {
          prepare(connection);
          return true;
        } finally {
          connection.close();
        }
      } catch {
        return false;
      }
    }),
  inspectForgetBlockers: (project) => Effect.sync(() => inspect(project.path)),
});
