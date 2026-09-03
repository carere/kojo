import { Context, type Effect } from "effect";
import type { RunAuthority } from "../../workflow/models/DaemonRun.ts";
import type {
  CreateAsking,
  DaemonAsking,
  DeferredApplication,
  GateTransitionReceipt,
  RecordVerdictTransition,
} from "../models/DaemonAsking.ts";
import type { GateTransitionError } from "../models/GateTransitionError.ts";

export class DaemonGateRepository extends Context.Service<
  DaemonGateRepository,
  {
    readonly createAskingAndSuspend: (
      authority: RunAuthority,
      asking: CreateAsking,
    ) => Effect.Effect<DaemonAsking, GateTransitionError>;
    readonly recordVerdictAndSchedule: (
      request: RecordVerdictTransition,
    ) => Effect.Effect<GateTransitionReceipt, GateTransitionError>;
    readonly expireAndSchedule: (
      token: string,
      now: string,
    ) => Effect.Effect<DaemonAsking, GateTransitionError>;
    readonly markApplied: (
      authority: RunAuthority,
      wakeupId: string,
      appliedAt: string,
    ) => Effect.Effect<DaemonAsking, GateTransitionError>;
    readonly byToken: (
      token: string,
    ) => Effect.Effect<DaemonAsking | undefined, GateTransitionError>;
    readonly list: Effect.Effect<ReadonlyArray<DaemonAsking>, GateTransitionError>;
    readonly due: (now: string) => Effect.Effect<ReadonlyArray<DaemonAsking>, GateTransitionError>;
    readonly deferredApplications: (
      runId: string,
    ) => Effect.Effect<ReadonlyArray<DeferredApplication>, GateTransitionError>;
    readonly deferredResults: (
      runId: string,
    ) => Effect.Effect<ReadonlyArray<DeferredApplication>, GateTransitionError>;
    readonly reconcileTerminalInabilities: Effect.Effect<void, GateTransitionError>;
  }
>()("kojo/gate/DaemonGateRepository") {}
