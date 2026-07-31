import type {
  ControlSubscriptionTopic,
  ExecutionTraceQueryResult,
  ExecutionTraceReadInput,
  ProjectIdentity,
} from "@kojo/control";
import { Context, type Effect } from "effect";

export type ControlResourceTopic = Exclude<ControlSubscriptionTopic, "traces">;

/**
 * Port for the Host-owned snapshots that drive advisory control updates.
 * The Unix-RPC adapter never chooses topics, cursors, or slow-client policy.
 */
export interface ControlSubscriptionReaderShape<R = never> {
  readonly readResourceFingerprint: (
    identity: ProjectIdentity,
    topic: ControlResourceTopic,
  ) => Effect.Effect<string, never, R>;
  readonly readTrace: (
    input: ExecutionTraceReadInput,
  ) => Effect.Effect<ExecutionTraceQueryResult, never, R>;
}

export class ControlSubscriptionReader extends Context.Service<
  ControlSubscriptionReader,
  ControlSubscriptionReaderShape<unknown>
>()("kojo/host/ControlSubscriptionReader") {}
