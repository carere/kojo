import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option } from "effect";
import type { DurableDeferred } from "effect/unstable/workflow";
import { AskedGate } from "../../../../../src/contexts/gate/models/AskedGate.ts";
import { GateRequest } from "../../../../../src/contexts/gate/models/GateRequest.ts";
import { GateRepository } from "../../../../../src/contexts/gate/ports/GateRepository.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import type { RunStatus } from "../../../../../src/contexts/workflow/services/run.ts";
import { stopped } from "../../../../../src/contexts/workflow/services/stopped.ts";

const runId = "run-1" as RunId;

const asking = (gate: string, forRun: RunId = runId) =>
  new AskedGate({
    request: new GateRequest({
      runId: forRun,
      gate,
      asking: `gate/${gate}/1`,
      description: "does this land?",
      actor: "engineer",
      choices: ["approve", "reject"],
      token: `token-${gate}` as DurableDeferred.Token,
      requestedAt: 0,
      deadlineAt: 172_800_000,
      onExpiry: "fail",
    }),
  });

/** A store that already holds exactly these askings and is never written to. */
const holding = (askings: ReadonlyArray<AskedGate>) =>
  Layer.succeed(GateRepository, {
    asked: () => Effect.void,
    recorded: () => Effect.succeed(false),
    expired: () => Effect.succeed(false),
    byToken: () => Effect.succeed(Option.none()),
    all: Effect.succeed(askings),
  });

/**
 * Every case resolves on the first pass, so nothing here sleeps.
 *
 * `within: 0` is what makes that true: the watch reads the two signals, and gives up rather than
 * waiting. The loop that waits is exercised for real by the two-process CLI test, where a run
 * genuinely takes time to move.
 */
const watch = (options: {
  readonly status: RunStatus;
  readonly known: ReadonlyArray<string>;
  readonly askings: ReadonlyArray<AskedGate>;
}) =>
  stopped({
    runId,
    status: Effect.succeed<RunStatus>(options.status),
    known: new Set(options.known),
    within: Duration.zero,
  }).pipe(Effect.provide(holding(options.askings)));

describe("waiting for one execution of a body to stop", () => {
  it.effect("calls a gate it has not seen before the place the run stopped", () =>
    Effect.gen(function* () {
      const stop = yield* watch({ status: "suspended", known: [], askings: [asking("approve")] });

      expect(stop._tag).toBe("suspended");
      expect(stop._tag === "suspended" && stop.gate.request.gate).toBe("approve");
    }),
  );

  it.effect("does not mistake the suspension it already knew about for a new one", () =>
    Effect.gen(function* () {
      // This is the measured hazard the whole design of this function is about. The engine reads
      // `suspended` on both sides of a resume, so a watcher driven by status alone would answer
      // instantly with the *previous* stop, and every line printed after it would describe a run
      // that had not moved.
      const stop = yield* watch({
        status: "suspended",
        known: ["token-approve"],
        askings: [asking("approve")],
      });

      expect(stop._tag).toBe("unsettled");
      expect(stop._tag === "unsettled" && stop.status).toBe("suspended");
    }),
  );

  it.effect("sees the second asking of a run that has already stopped once", () =>
    Effect.gen(function* () {
      const stop = yield* watch({
        status: "suspended",
        known: ["token-first"],
        askings: [asking("first"), asking("second")],
      });

      expect(stop._tag === "suspended" && stop.gate.request.gate).toBe("second");
    }),
  );

  it.effect("ignores an asking that belongs to another run", () =>
    Effect.gen(function* () {
      const stop = yield* watch({
        status: "suspended",
        known: [],
        askings: [asking("elsewhere", "run-2" as RunId)],
      });

      expect(stop._tag).toBe("unsettled");
    }),
  );

  it.effect("lets a terminal status outrank a gate still sitting unanswered", () =>
    Effect.gen(function* () {
      // A gate whose deadline passed leaves its row unanswered forever, and the run carries on and
      // may fail. Reading the row first would report that run as waiting on a human who can no
      // longer affect it.
      const stop = yield* watch({ status: "failed", known: [], askings: [asking("expired")] });

      expect(stop._tag).toBe("finished");
      expect(stop._tag === "finished" && stop.status).toBe("failed");
    }),
  );

  it.effect("reports a finished run", () =>
    Effect.gen(function* () {
      const stop = yield* watch({ status: "succeeded", known: [], askings: [] });

      expect(stop).toEqual({ _tag: "finished", status: "succeeded" });
    }),
  );
});
