import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { decodeUnknown } from "../shared/decoding";
import { DeliveryBranch, DeliveryOptions, PositiveInteger } from "../types/delivery";
import { runDelivery } from "../workflows/delivery/index";
import { deliveryServicesLive } from "../workflows/delivery/services-live";

export const deliveryCommand = Command.make(
  "delivery",
  {
    root: Flag.integer("root").pipe(
      Flag.withSchema(PositiveInteger),
      Flag.withDefault(undefined),
      Flag.withDescription("Limit delivery to a workstream root issue number"),
    ),
    target: Flag.string("target").pipe(
      Flag.withSchema(DeliveryBranch),
      Flag.withDefault(undefined),
      Flag.withDescription("Limit delivery to a target branch"),
    ),
    concurrency: Flag.integer("concurrency").pipe(
      Flag.withSchema(PositiveInteger),
      Flag.withDefault(undefined),
      Flag.withDescription("Maximum number of issue agents to run concurrently"),
    ),
    maxIterations: Flag.integer("max-iterations").pipe(
      Flag.withSchema(PositiveInteger),
      Flag.withDefault(undefined),
      Flag.withDescription("Maximum delivery iterations per workstream"),
    ),
  },
  (options) =>
    decodeUnknown(DeliveryOptions, "delivery command options", options).pipe(
      Effect.flatMap(runDelivery),
      Effect.provide(deliveryServicesLive),
    ),
).pipe(
  Command.withDescription("Discover, implement, review, and integrate ready delivery workstreams"),
);
