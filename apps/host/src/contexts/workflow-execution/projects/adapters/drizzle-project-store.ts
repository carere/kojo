import { Database } from "bun:sqlite";
import { join } from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Effect, Layer, Schema } from "effect";
import { ProjectStore } from "../services/project-store";

const scheduleStates = sqliteTable("kojo_workflow_schedule_states", {
  scheduleKey: text("schedule_key").notNull(),
  enabledIntent: integer("enabled_intent").notNull(),
});

const workflowRuns = sqliteTable("kojo_workflow_runs", {
  runId: text("run_id").notNull(),
  state: text("state").notNull(),
});

const ScheduleBlockerRows = Schema.Array(Schema.Struct({ scheduleKey: Schema.String }));
const RunBlockerRows = Schema.Array(Schema.Struct({ runId: Schema.String }));

const missingTable = (error: unknown) =>
  error instanceof Error && error.message.includes("no such table");

const inspect = (projectPath: string) => {
  try {
    const connection = new Database(join(projectPath, ".kojo", "kojo.sqlite"), {
      readonly: true,
      strict: true,
    });
    try {
      const store = drizzle(connection);
      let enabledScheduleKeys: ReadonlyArray<string> = [];
      let nonFinalRunIds: ReadonlyArray<string> = [];
      try {
        const rows = store
          .select({ scheduleKey: scheduleStates.scheduleKey })
          .from(scheduleStates)
          .where(eq(scheduleStates.enabledIntent, 1))
          .orderBy(asc(scheduleStates.scheduleKey))
          .all();
        enabledScheduleKeys = Schema.decodeUnknownSync(ScheduleBlockerRows)(rows).map(
          ({ scheduleKey }) => scheduleKey,
        );
      } catch (error) {
        if (!missingTable(error)) throw error;
      }
      try {
        const rows = store
          .select({ runId: workflowRuns.runId })
          .from(workflowRuns)
          .where(inArray(workflowRuns.state, ["running", "suspended", "stopping"]))
          .orderBy(asc(workflowRuns.runId))
          .all();
        nonFinalRunIds = Schema.decodeUnknownSync(RunBlockerRows)(rows).map(({ runId }) => runId);
      } catch (error) {
        if (!missingTable(error)) throw error;
      }
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
  inspectForgetBlockers: (project) => Effect.sync(() => inspect(project.path)),
});
