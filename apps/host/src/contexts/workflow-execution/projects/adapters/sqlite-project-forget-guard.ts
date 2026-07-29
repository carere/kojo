import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { ProjectForgetGuard } from "../services/project-forget-guard";

const inspect = (projectPath: string) => {
  try {
    const database = new Database(join(projectPath, ".kojo", "kojo.sqlite"), {
      readonly: true,
      strict: true,
    });
    try {
      const tables = new Set(
        (
          database
            .query("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as ReadonlyArray<{ readonly name: string }>
        ).map(({ name }) => name),
      );
      const enabledScheduleKeys = tables.has("kojo_workflow_schedule_states")
        ? (
            database
              .query(
                "SELECT schedule_key FROM kojo_workflow_schedule_states WHERE enabled_intent = 1 ORDER BY schedule_key",
              )
              .all() as ReadonlyArray<{ readonly schedule_key: string }>
          ).map(({ schedule_key }) => schedule_key)
        : [];
      const nonFinalRunIds = tables.has("kojo_workflow_runs")
        ? (
            database
              .query(
                "SELECT run_id FROM kojo_workflow_runs WHERE state IN ('running', 'suspended', 'stopping') ORDER BY run_id",
              )
              .all() as ReadonlyArray<{ readonly run_id: string }>
          ).map(({ run_id }) => run_id)
        : [];
      return { assessment: "available" as const, enabledScheduleKeys, nonFinalRunIds };
    } finally {
      database.close();
    }
  } catch {
    return {
      assessment: "unavailable" as const,
      enabledScheduleKeys: [],
      nonFinalRunIds: [],
    };
  }
};

export const SqliteProjectForgetGuardLive = Layer.succeed(ProjectForgetGuard, {
  inspect: (project) => Effect.sync(() => inspect(project.path)),
});
