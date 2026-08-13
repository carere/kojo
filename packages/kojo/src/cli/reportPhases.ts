import { Console, Effect } from "effect";
import * as InMemoryTracer from "../contexts/trace/adapters/InMemoryTracer.ts";
import { renderPhaseTable } from "./phaseTable.ts";

/**
 * What **this process** executed.
 *
 * The trace is still the in-memory one — the durable trace is its own ticket — so the table holds
 * the phases this invocation ran and nothing else. That limitation is also the cheapest replay
 * witness there is: a resumed run prints only the phases that came after the gate, because
 * everything before it came back as a recorded activity result without its body running again. A
 * phase from before the gate appearing in this table would mean work was repeated, which is the one
 * thing the whole durability design exists to prevent.
 */
export const reportPhases: Effect.Effect<void, never, InMemoryTracer.RecordedTrace> = Effect.gen(
  function* () {
    const trace = yield* InMemoryTracer.RecordedTrace;
    const phases = yield* trace.phases;
    yield* Console.log(`\nphases this process ran:\n${renderPhaseTable(phases)}`);
  },
);
