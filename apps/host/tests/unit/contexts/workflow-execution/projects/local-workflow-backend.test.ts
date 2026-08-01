import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { EntityAddress, EntityId, EntityType, ShardId } from "effect/unstable/cluster";
import type { MessageStorage } from "effect/unstable/cluster/MessageStorage";
import { clearWorkflowAndClockAddresses } from "../../../../../src/contexts/workflow-execution/projects/services/local-workflow-backend";

it.effect("clears a known workflow and clock pair inside one MessageStorage transaction", () => {
  const entityId = EntityId.make("known-execution");
  const shardId = ShardId.make("default", 1);
  const workflowAddress = EntityAddress.make({
    entityId,
    entityType: EntityType.make("Workflow/Kojo/example/1"),
    shardId,
  });
  const cleared: Array<string> = [];
  let transactionCount = 0;
  const storage = {
    clearAddress: (address: typeof workflowAddress) =>
      Effect.sync(() => {
        cleared.push(address.entityType);
      }),
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        transactionCount += 1;
        return yield* effect;
      }),
  } as unknown as MessageStorage["Service"];

  return Effect.gen(function* () {
    yield* clearWorkflowAndClockAddresses(storage, workflowAddress);
    expect(transactionCount).toBe(1);
    expect(cleared).toEqual(["Workflow/Kojo/example/1", "Workflow/-/DurableClock"]);
  });
});
