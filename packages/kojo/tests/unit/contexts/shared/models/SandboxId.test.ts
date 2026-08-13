import { describe, expect, it } from "@effect/vitest";
import {
  makeSandboxId,
  nextAcquisition,
} from "../../../../../src/contexts/shared/models/SandboxId.ts";

/**
 * The id of one **acquisition**, and the collision ticket 17 left open.
 *
 * Ticket 17 wrote it down plainly: two acquisitions of one scope inside the same millisecond would
 * share an id, and nothing observed does that. **Ticket 19 did not change that finding** — an
 * earlier draft claimed the `misplaced` scope in `sandboxed.test.ts` reached it, and that claim is
 * false, because `retryOnInterrupt`'s schedule advances the test clock between attempts. Reverting
 * `makeSandboxId` to the clock alone leaves that suite green and fails only the file you are reading.
 *
 * So this file tests the property, not a regression: the id is distinct per acquisition **by
 * construction** rather than because the clock happened to move. That is the whole argument for the
 * change — it costs one integer and removes the need to keep being right about the clock.
 */
describe("what makes two acquisitions of one scope distinct", () => {
  it("keeps the shape a correlation reader parses", () => {
    // `runId/name/discriminator`, the same three parts as a phase id, because both travel in the
    // one `KOJO_PHASE_ID` variable and a reader must not need to know which it is holding.
    expect(makeSandboxId("run-1", "lane", 1_700_000_000_000, 7).split("/")).toEqual([
      "run-1",
      "lane",
      "1700000000000-7",
    ]);
  });

  it("tells two acquisitions apart when the clock cannot", () => {
    const frozen = 1_700_000_000_000;
    const ids = [1, 2, 3].map((sequence) => makeSandboxId("run-1", "lane", frozen, sequence));

    // One run, one scope, one millisecond, three containers. Every one of them is owed its own row.
    expect(new Set(ids).size).toBe(3);
  });

  it("hands out a sequence that never repeats inside a process", () => {
    const drawn = Array.from({ length: 50 }, () => nextAcquisition());

    expect(new Set(drawn).size).toBe(50);
    // Monotonic, so a reader sorting rows by id within one process gets acquisition order back even
    // when the clock is coarse.
    expect([...drawn].sort((a, b) => a - b)).toEqual(drawn);
  });

  it("still needs the clock, because a second process starts its sequence again", () => {
    // What a counter alone cannot do, stated as a test rather than as a paragraph: the process that
    // resumes a run is not the process that started it, so the first acquisition after a gate draws
    // sequence 1 exactly as the first acquisition of the run did. The moment is what separates them.
    const resumed = makeSandboxId("run-1", "lane", 1_700_000_090_000, 1);
    const original = makeSandboxId("run-1", "lane", 1_700_000_000_000, 1);

    expect(resumed).not.toBe(original);
  });
});
