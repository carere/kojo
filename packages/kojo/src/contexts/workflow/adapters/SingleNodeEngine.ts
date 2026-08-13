import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { Layer } from "effect";
import { ClusterWorkflowEngine, type ShardingConfig, SingleRunner } from "effect/unstable/cluster";
import type { SqlClient } from "effect/unstable/sql";
import type { WorkflowEngine } from "effect/unstable/workflow";

/**
 * The engine a factory runs on: a suspended run survives the process exiting.
 *
 * It is a cluster of one. No broker, no orchestrator, no container — `SingleRunner` wires no-op
 * runner transport and no-op health checks, and everything durable lands in the SQLite file the
 * caller's `SqlClient` opened. A run that suspends at a two-day gate is a row, not a held fiber, so
 * the process that started it is free to exit and another process can answer and resume it.
 *
 * Three things this layer is deliberate about:
 *
 * - **`SingleRunner.layer` is a function, and the layer it returns can fail.** It reads its sharding
 *   configuration from the environment, so it carries a `ConfigError`. That is a malformed
 *   environment at startup, not a condition a workflow can recover from, and nothing downstream
 *   would ever catch it — so it becomes a defect here, loudly, rather than an error channel that
 *   spreads to every caller and is handled by none of them.
 * - **`Crypto` is provided, `SqlClient` is not.** The runner needs both even with in-memory runner
 *   storage. Crypto has one right answer on Bun; the client does not, because it is the *shared*
 *   one — this layer leaves it in the requirement channel precisely so the trace can be given the
 *   same value. Two calls to a database layer are two handles on one file.
 * - **Sharding is single-node by configuration, not by hope.** Every runner under
 *   `ShardingConfig.layerFromEnv` defaults to the same address, so two Kojo runners on one machine
 *   upsert one row and contend for the same shard locks. `shardingConfig` is exposed for that, and
 *   for `entityMessagePollInterval`, which is how long an answer written by another process waits
 *   before the run notices it — ten seconds by default.
 */
export const layer = (options?: {
  readonly shardingConfig?: Partial<ShardingConfig.ShardingConfig["Service"]> | undefined;
  readonly runnerStorage?: "memory" | "sql" | undefined;
}): Layer.Layer<WorkflowEngine.WorkflowEngine, never, SqlClient.SqlClient> =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provide(
      Layer.orDie(
        SingleRunner.layer({
          shardingConfig: options?.shardingConfig,
          runnerStorage: options?.runnerStorage,
        }),
      ),
    ),
    Layer.provide(BunCrypto.layer),
  );
