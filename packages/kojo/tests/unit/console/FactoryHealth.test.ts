import { describe, expect, it } from "@effect/vitest";
import { healthOf, noticeFor, standingOf } from "../../../src/console/FactoryHealth.ts";
import { RunnerRegistration } from "../../../src/contexts/workflow/models/RunnerRegistration.ts";

/**
 * The rules the health document is built from, graded without a database, a socket or a clock.
 *
 * Two of them are asymmetric on purpose and the asymmetry is the whole design, so it is stated here
 * rather than left to be inferred from a route test: a file migrated **further** than this build is
 * silent, and a file migrated **less** far is loud.
 */

const site = {
  database: ".kojo/data/kojo.db",
  factory: "present" as const,
  version: "0.0.0",
  commit: "development",
  runners: [],
};

describe("where the file stands against this build", () => {
  it("calls an equal ledger current", () => {
    expect(standingOf(3, 3)).toBe("current");
  });

  it("calls a ledger this build has never heard of newer, and says nothing about it", () => {
    // The migrations are additive, so a column this build does not select cannot hurt it. This is
    // what an older Console reading a newer factory looks like, and it must keep working.
    expect(standingOf(4, 3)).toBe("newer");
    expect(
      noticeFor({ factory: "present", standing: "newer", applied: 4, expected: 3 }),
    ).toBeUndefined();
  });

  it("calls a ledger behind this build older, and warns loudly", () => {
    expect(standingOf(1, 3)).toBe("older");

    const notice = noticeFor({ factory: "present", standing: "older", applied: 1, expected: 3 });
    // Loud means specific: which migration the file has, which one this build wants, and what to run.
    expect(notice).toContain("older than the Console");
    expect(notice).toContain("migration 1");
    expect(notice).toContain("expects 3");
    expect(notice).toContain("kojo watch");
  });

  it("separates a file nothing has ever migrated from a file that is behind", () => {
    // Zero is not "one behind": it is a file no factory has written to, which is the ordinary state
    // of a fresh repository rather than a version mismatch.
    expect(standingOf(0, 3)).toBe("unwritten");
    expect(
      noticeFor({ factory: "present", standing: "unwritten", applied: 0, expected: 3 }),
    ).toBeUndefined();
  });
});

describe("a repository with no factory", () => {
  it("says what to run, and says it before anything about the schema", () => {
    const health = healthOf({ ...site, factory: "absent", applied: 0, expected: 3 });
    expect(health.factory).toBe("absent");
    expect(health.notice).toBe("No factory in this repo. Run `kojo init`.");
  });
});

describe("whether an answer given now would move a run", () => {
  it("reads no rows as nothing running rather than as a fault", () => {
    // Sharding unregisters on a graceful shutdown, so a cleanly stopped `kojo watch` leaves the
    // table empty. Empty is the normal idle state.
    expect(healthOf({ ...site, applied: 3, expected: 3 }).runner).toBe("none");
  });

  it("ages a killed runner's row out at the cluster's own thirty-five seconds", () => {
    const alive = healthOf({
      ...site,
      applied: 3,
      expected: 3,
      runners: [new RunnerRegistration({ address: "a", heartbeatAgeMillis: 34_999 })],
    });
    expect(alive.runner).toBe("live");

    const killed = healthOf({
      ...site,
      applied: 3,
      expected: 3,
      runners: [new RunnerRegistration({ address: "a", heartbeatAgeMillis: 35_001 })],
    });
    // A row left behind by a process that was killed. Reporting it live is the "approved ✓ that
    // means nothing" adr/gate/0001 exists to prevent.
    expect(killed.runner).toBe("none");
  });

  it("calls a factory live when any one registration is fresh", () => {
    const mixed = healthOf({
      ...site,
      applied: 3,
      expected: 3,
      runners: [
        new RunnerRegistration({ address: "stale", heartbeatAgeMillis: 90_000 }),
        new RunnerRegistration({ address: "fresh", heartbeatAgeMillis: 1_000 }),
      ],
    });
    expect(mixed.runner).toBe("live");
  });
});
