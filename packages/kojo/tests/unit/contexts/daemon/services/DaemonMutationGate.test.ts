import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { DaemonMutationGate } from "../../../../../src/contexts/daemon/services/DaemonMutationGate.ts";

describe("DaemonMutationGate", () => {
  it("waits for an accepted background writer and refuses a new writer while held", async () => {
    const gate = new DaemonMutationGate();
    const leave = gate.enter();
    expect(leave).toBeTypeOf("function");
    let held = false;
    const hold = Effect.runPromise(gate.hold("upgrade-one")).then(() => {
      held = true;
    });
    await Promise.resolve();
    expect(held).toBe(false);
    expect(gate.enter()).toBeUndefined();
    leave?.();
    await hold;
    expect(held).toBe(true);
    expect(gate.enter()).toBeUndefined();
    await Effect.runPromise(gate.release("upgrade-one"));
    expect(gate.enter()).toBeTypeOf("function");
  });
});
