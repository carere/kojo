import {
  type ProjectIdentity,
  type RequestKey,
  WorkflowScheduleMutationResult,
} from "@kojo/control";
import { Effect, Schema } from "effect";
import { HostOverviewError } from "../../../shared/models/contracts";
import { HostControlClient } from "../services/host-control-client";

const mapHostError = <A, E extends { readonly _tag: string; readonly message: string }>(
  effect: Effect.Effect<A, E, HostControlClient>,
) =>
  effect.pipe(
    Effect.mapError((error) =>
      error._tag === "IncompatibleProtocolError"
        ? new HostOverviewError({
            code: "incompatible-protocol",
            message: error.message,
            next: "Upgrade Kojo Host or the visualizer so their protocol major versions match.",
          })
        : new HostOverviewError({
            code: "host-unavailable",
            message: error.message,
            next: "Start the Kojo Host and try again.",
          }),
    ),
  );

export const enableWorkflowSchedule = (input: {
  readonly identity: ProjectIdentity;
  readonly requestKey: RequestKey;
  readonly scheduleKey: string;
  readonly scheduleRevision: string;
}) =>
  mapHostError(
    Effect.flatMap(HostControlClient, (client) =>
      client.enableWorkflowSchedule(
        input.identity,
        input.scheduleKey,
        input.scheduleRevision,
        input.requestKey,
      ),
    ).pipe(Effect.map(Schema.decodeUnknownSync(WorkflowScheduleMutationResult))),
  );

export const disableWorkflowSchedule = (input: {
  readonly identity: ProjectIdentity;
  readonly requestKey: RequestKey;
  readonly scheduleKey: string;
}) =>
  mapHostError(
    Effect.flatMap(HostControlClient, (client) =>
      client.disableWorkflowSchedule(input.identity, input.scheduleKey, input.requestKey),
    ).pipe(Effect.map(Schema.decodeUnknownSync(WorkflowScheduleMutationResult))),
  );
