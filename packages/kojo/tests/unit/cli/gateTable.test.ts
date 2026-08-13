import { describe, expect, it } from "@effect/vitest";
import type { DurableDeferred } from "effect/unstable/workflow";
import { humanMillis, renderGateTable } from "../../../src/cli/gateTable.ts";
import { AskedGate } from "../../../src/contexts/gate/models/AskedGate.ts";
import { GateRequest } from "../../../src/contexts/gate/models/GateRequest.ts";
import { Verdict } from "../../../src/contexts/gate/models/Verdict.ts";
import type { RunId } from "../../../src/contexts/shared/models/RunId.ts";

const hour = 3_600_000;
const now = 1_000 * hour;

const asking = (options: {
  readonly gate: string;
  readonly requestedAt: number;
  readonly deadlineAt: number;
  readonly verdict?: Verdict;
  readonly expiredAt?: number;
}) =>
  new AskedGate({
    request: new GateRequest({
      runId: `run-${options.gate}` as RunId,
      gate: options.gate,
      asking: `gate/${options.gate}/1`,
      description: "does this land?",
      actor: "engineer",
      choices: ["approve", "reject"],
      token: `token-${options.gate}` as DurableDeferred.Token,
      requestedAt: options.requestedAt,
      deadlineAt: options.deadlineAt,
      onExpiry: "fail",
    }),
    ...(options.verdict === undefined ? {} : { verdict: options.verdict }),
    ...(options.expiredAt === undefined ? {} : { expiredAt: options.expiredAt }),
  });

describe("a span of time as a person reads it", () => {
  it.each([
    [0, "0s"],
    [45_000, "45s"],
    [90_000, "1m 30s"],
    [2 * hour, "2h"],
    [2 * hour + 30 * 60_000, "2h 30m"],
    [50 * hour, "2d 2h"],
    [48 * hour, "2d"],
  ])("renders %ims as %s", (millis, expected) => {
    expect(humanMillis(millis)).toBe(expected);
  });
});

describe("the gate table", () => {
  it("says so plainly when nothing waits on anybody", () => {
    expect(renderGateTable([], now)).toBe("no gate waits on anybody");
  });

  it("puts a run past its deadline at the top rather than in date order", () => {
    const overdue = asking({
      gate: "stale",
      requestedAt: now - 50 * hour,
      deadlineAt: now - 2 * hour,
    });
    const fresh = asking({ gate: "fresh", requestedAt: now - hour, deadlineAt: now + 47 * hour });

    const lines = renderGateTable([fresh, overdue], now).split("\n");

    expect(lines[0]).toContain("STATE");
    // Buried under everything asked since, the one nobody looked at is the one nobody sees.
    expect(lines[1]).toContain("overdue");
    expect(lines[1]).toContain("OVERDUE by 2h");
    expect(lines[2]).toContain("waiting");
    expect(lines[2]).toContain("in 1d 23h");
  });

  it("prints the whole token, because it is the argument to the next command", () => {
    const waiting = asking({ gate: "approve", requestedAt: now - hour, deadlineAt: now + hour });

    expect(renderGateTable([waiting], now)).toContain("token-approve");
  });

  it("says EXPIRED, never OVERDUE, on an asking the run settled without an answer", () => {
    // The two words are two different promises: OVERDUE means an answer may still land, EXPIRED
    // means the run already took its expiry branch and no answer can reach it any more.
    const gone = asking({
      gate: "deploy",
      requestedAt: now - 10 * hour,
      deadlineAt: now - 2 * hour,
      expiredAt: now - 2 * hour,
    });

    const rendered = renderGateTable([gone], now);
    expect(rendered).toContain("expired");
    expect(rendered).toContain("EXPIRED 2h ago");
    expect(rendered).not.toContain("OVERDUE");
    // The wait is request-to-expiry, not request-to-now: the question left every desk there.
    expect(rendered).toContain("8h");
  });

  it("names the choice and the answerer on an asking somebody answered", () => {
    const answered = asking({
      gate: "approve",
      requestedAt: now - 10 * hour,
      deadlineAt: now + hour,
      verdict: new Verdict({
        choice: "approve",
        reason: "ships",
        answerer: "kevin",
        answeredAt: now - 8 * hour,
      }),
    });

    const rendered = renderGateTable([answered], now);
    expect(rendered).toContain("recorded");
    expect(rendered).toContain("approve by kevin");
    // The wait is request-to-answer, not request-to-now.
    expect(rendered).toContain("2h");
  });
});
