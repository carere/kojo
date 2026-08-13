import { describe, expect, it } from "@effect/vitest";
import { Duration } from "effect";
import {
  live,
  RunnerRegistration,
  staleAfter,
} from "../../../../../src/contexts/workflow/models/RunnerRegistration.ts";

const registered = (address: string, heartbeatAgeMillis: number) =>
  new RunnerRegistration({ address, heartbeatAgeMillis });

describe("who is actually running", () => {
  it("holds the window the cluster itself applies", () => {
    // Not a number Kojo chose. `getRunners` filters the same column with the same window, so a
    // different one here would make Kojo disagree with the framework about who is running.
    expect(Duration.toSeconds(staleAfter)).toBe(35);
  });

  it("counts a runner whose heartbeat is inside the window", () => {
    expect(registered("localhost:34431", 12_000).isLive()).toBe(true);
    expect(registered("localhost:34431", 34_999).isLive()).toBe(true);
  });

  it("stops counting one whose heartbeat has aged past it", () => {
    // The crashed runner. Its row survives, and for thirty-five seconds it claims a runner nobody
    // can talk to — which is exactly why the filter is mandatory rather than an optimisation.
    expect(registered("localhost:34431", 36_000).isLive()).toBe(false);
  });

  it("filters a list, keeping the stale rows out of the answer and not out of the table", () => {
    const rows = [registered("localhost:1", 1_000), registered("localhost:2", 90_000)];

    expect(live(rows).map((row) => row.address)).toEqual(["localhost:1"]);
    // The stale row is still readable: the difference between *stopped* and *died* is what a person
    // asking this question wants, and a port that dropped it could not say which.
    expect(rows).toHaveLength(2);
  });

  it("takes a narrower window, because a test cannot wait thirty-five seconds", () => {
    expect(live([registered("localhost:1", 11_000)], Duration.seconds(10))).toHaveLength(0);
  });
});
