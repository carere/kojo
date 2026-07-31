import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { preservesStoppedOutcome } from "../../../../../../src/contexts/workflow-execution/runs/models/workflow-run-stop";

it.effect("makes accepted stop intent win deterministic completion races", () =>
  Effect.sync(() => {
    expect(preservesStoppedOutcome("stopping")).toBe(true);
    expect(preservesStoppedOutcome("stopped")).toBe(true);
    expect(preservesStoppedOutcome("running")).toBe(false);
    expect(preservesStoppedOutcome("suspended")).toBe(false);
  }),
);
