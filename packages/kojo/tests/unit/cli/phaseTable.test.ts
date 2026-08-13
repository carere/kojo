import { describe, expect, it } from "@effect/vitest";
import { renderPhaseTable } from "../../../src/cli/phaseTable.ts";
import type { PhaseId } from "../../../src/contexts/shared/models/PhaseId.ts";
import type { RunId } from "../../../src/contexts/shared/models/RunId.ts";
import type { SandboxId } from "../../../src/contexts/shared/models/SandboxId.ts";
import { PhaseRecord } from "../../../src/contexts/trace/models/PhaseRecord.ts";

const runId = "run-1" as RunId;

const phase = (options: {
  readonly name: string;
  readonly lane?: string;
  readonly startedAt: number;
}) =>
  new PhaseRecord({
    runId,
    phaseId: `${runId}/${options.name}/1` as PhaseId,
    name: options.name,
    description: `the ${options.name} phase`,
    kind: "code",
    outcome: "succeeded",
    attempt: 1,
    startedAt: options.startedAt,
    endedAt: options.startedAt + 5,
    ...(options.lane === undefined
      ? {}
      : { sandboxId: `${runId}/${options.lane}/1000-1` as SandboxId }),
  });

/** The column of the first row, split on runs of two or more spaces. */
const cells = (table: string, row: number): ReadonlyArray<string> =>
  (table.split("\n")[row] ?? "").trim().split(/\s{2,}/);

describe("the phase table", () => {
  it("names the lane each phase ran in, so two lanes do not have to be told apart by time", () => {
    const table = renderPhaseTable([
      phase({ name: "route", startedAt: 1 }),
      phase({ name: "fix", lane: "hotfix", startedAt: 2 }),
      phase({ name: "plan", lane: "feature", startedAt: 3 }),
    ]);

    expect(cells(table, 0)).toEqual([
      "PHASE",
      "LANE",
      "KIND",
      "OUTCOME",
      "DURATION",
      "DESCRIPTION",
    ]);
    // Each row carries its own lane, read from the phase's own `sandboxId`. Two concurrent lanes
    // interleave in this table, and the second column is the only thing that separates them.
    expect(cells(table, 2)[1]).toBe("hotfix");
    expect(cells(table, 3)[1]).toBe("feature");
    // A phase that never entered a scope ran on the host, and says so rather than being blank.
    expect(cells(table, 1)[1]).toBe("host");
  });

  it("leaves the column out of a run that used no container", () => {
    const table = renderPhaseTable([
      phase({ name: "route", startedAt: 1 }),
      phase({ name: "greet", startedAt: 2 }),
    ]);

    expect(cells(table, 0)).toEqual(["PHASE", "KIND", "OUTCOME", "DURATION", "DESCRIPTION"]);
    expect(table).not.toContain("host");
  });
});
