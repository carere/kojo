import { describe, expect, it } from "@effect/vitest";
import type { DurableDeferred } from "effect/unstable/workflow";
import {
  AskedGate,
  unsettled,
  waitingFirst,
} from "../../../../../src/contexts/gate/models/AskedGate.ts";
import { GateRequest } from "../../../../../src/contexts/gate/models/GateRequest.ts";
import { Verdict } from "../../../../../src/contexts/gate/models/Verdict.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";

const hour = 3_600_000;
const now = 100 * hour;

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

describe("one asking of a gate", () => {
  it("counts the wait from the request to now while nobody has answered", () => {
    const waiting = asking({ gate: "a", requestedAt: now - 3 * hour, deadlineAt: now + hour });

    expect(waiting.state(now)).toBe("waiting");
    expect(waiting.waitedMillis(now)).toBe(3 * hour);
    expect(waiting.remainingMillis(now)).toBe(hour);
  });

  it("counts it to the answer once there is one, not to now", () => {
    // Human latency is request-to-answer. Measured to `now` instead, every answered gate would keep
    // getting slower the longer the trace sat on disk.
    const answered = asking({
      gate: "b",
      requestedAt: now - 10 * hour,
      deadlineAt: now + hour,
      verdict: new Verdict({
        choice: "approve",
        reason: "reads fine",
        answerer: "kevin",
        answeredAt: now - 6 * hour,
      }),
    });

    expect(answered.state(now)).toBe("recorded");
    expect(answered.waitedMillis(now)).toBe(4 * hour);
  });

  it("is overdue once the deadline is behind it and nobody has answered", () => {
    const stale = asking({ gate: "c", requestedAt: now - 50 * hour, deadlineAt: now - hour });

    expect(stale.state(now)).toBe("overdue");
    expect(stale.remainingMillis(now)).toBe(-hour);
  });

  it("is expired once the run settled it without an answer, and never merely overdue", () => {
    // Overdue and expired must not read alike: overdue means an answer may still land, expired
    // means the run already took its expiry branch and no answer can reach it any more.
    const gone = asking({
      gate: "e",
      requestedAt: now - 50 * hour,
      deadlineAt: now - 2 * hour,
      expiredAt: now - 2 * hour,
    });

    expect(gone.state(now)).toBe("expired");
    // The wait stops accruing at the expiry: the question left everybody's desk there, and a wait
    // that kept growing would overstate what the gate cost.
    expect(gone.waitedMillis(now)).toBe(48 * hour);
  });

  it("stays expired when a verdict was recorded too late to ever apply", () => {
    // The race was settled by the clock; a verdict written afterwards is real and will never be
    // applied. Calling this asking `recorded` would promise the run might still take it.
    const late = asking({
      gate: "f",
      requestedAt: now - 10 * hour,
      deadlineAt: now - 2 * hour,
      expiredAt: now - 2 * hour,
      verdict: new Verdict({
        choice: "approve",
        reason: "too late",
        answerer: "kevin",
        answeredAt: now - hour,
      }),
    });

    expect(late.state(now)).toBe("expired");
  });

  it("is not overdue when the deadline passed after somebody answered", () => {
    const answered = asking({
      gate: "d",
      requestedAt: now - 50 * hour,
      deadlineAt: now - hour,
      verdict: new Verdict({
        choice: "reject",
        reason: "no",
        answerer: "dana",
        answeredAt: now - 40 * hour,
      }),
    });

    expect(answered.state(now)).toBe("recorded");
  });
});

describe("the askings, ordered", () => {
  const overdue = asking({ gate: "overdue", requestedAt: now - 50 * hour, deadlineAt: now - hour });
  const patient = asking({ gate: "patient", requestedAt: now - 20 * hour, deadlineAt: now + hour });
  const fresh = asking({ gate: "fresh", requestedAt: now - hour, deadlineAt: now + 40 * hour });

  it("puts what is past its deadline first, and the longest wait above the shortest", () => {
    // A list ordered by when each question was asked buries the run nobody looked at under
    // everything asked since — which is the opposite of what a latency metric is for.
    const ordered = waitingFirst([fresh, patient, overdue], now);
    expect(ordered.map((gate) => gate.request.gate)).toEqual(["overdue", "patient", "fresh"]);
  });

  it("leaves out what already settled — answered, and expired alike", () => {
    const answered = asking({
      gate: "done",
      requestedAt: now - 5 * hour,
      deadlineAt: now + hour,
      verdict: new Verdict({
        choice: "approve",
        reason: "",
        answerer: "kevin",
        answeredAt: now - 4 * hour,
      }),
    });
    // The half ticket 46 exists for: no verdict, and the run settled it anyway. Before the
    // settlement was written down this row sat in the waiting list forever, overdue without bound.
    const expired = asking({
      gate: "gone",
      requestedAt: now - 9 * hour,
      deadlineAt: now - 3 * hour,
      expiredAt: now - 3 * hour,
    });

    expect(unsettled([fresh, answered, expired, overdue]).map((gate) => gate.request.gate)).toEqual(
      ["fresh", "overdue"],
    );
  });
});
