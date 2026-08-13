import { describe, expect, it } from "@effect/vitest";
import type { DurableDeferred } from "effect/unstable/workflow";
import { describeNotice, describeRunners } from "../../../src/cli/watchLine.ts";
import { AskedGate } from "../../../src/contexts/gate/models/AskedGate.ts";
import { GateRequest } from "../../../src/contexts/gate/models/GateRequest.ts";
import type { RunId } from "../../../src/contexts/shared/models/RunId.ts";
import { RunLocked } from "../../../src/contexts/workflow/models/RunLocked.ts";
import { RunnerRegistration } from "../../../src/contexts/workflow/models/RunnerRegistration.ts";

const hour = 3_600_000;
const now = 1_000 * hour;

const asking = (options: { readonly requestedAt: number; readonly deadlineAt: number }) =>
  new AskedGate({
    request: new GateRequest({
      runId: "run-1" as RunId,
      gate: "approve",
      asking: "gate/approve/1",
      description: "does this land?",
      actor: "engineer",
      choices: ["approve", "reject"],
      token: "token-1" as DurableDeferred.Token,
      requestedAt: options.requestedAt,
      deadlineAt: options.deadlineAt,
      onExpiry: "fail",
    }),
  });

describe("what a watcher says", () => {
  it("names the event and the run it became", () => {
    expect(
      describeNotice(
        { _tag: "started", runId: "run-1" as RunId, source: "inbox/a.json", key: "KOJO-1@1" },
        now,
      ),
    ).toBe("inbox/a.json KOJO-1@1 → run run-1");
  });

  it("says a waiting run in the same words `kojo run` uses, plus the run it is about", () => {
    const said = describeNotice(
      { _tag: "waiting", gate: asking({ requestedAt: now - hour, deadlineAt: now + 47 * hour }) },
      now,
    );

    expect(said).toContain('run run-1 suspended at gate "approve"');
    expect(said).toContain("waiting on engineer, 1d 23h left");
    // The token is printed in full because it is the argument to the next command.
    expect(said).toContain("kojo gate answer token-1 --choice approve");
  });

  it("says how far past its deadline an overdue run is, and how to answer it", () => {
    const said = describeNotice(
      {
        _tag: "overdue",
        gate: asking({ requestedAt: now - 80 * hour, deadlineAt: now - 6 * hour }),
      },
      now,
    );

    expect(said).toContain("OVERDUE run run-1");
    expect(said).toContain("has waited 3d 8h on engineer");
    expect(said).toContain("6h past its deadline");
    expect(said).toContain("kojo gate answer token-1 --choice approve");
  });

  it("says a refusal as a refusal rather than as a failure", () => {
    expect(
      describeNotice(
        {
          _tag: "refused",
          locked: new RunLocked({ runId: "run-1" as RunId, holder: "watch-42", since: now }),
        },
        now,
      ),
    ).toContain("already being driven by watch-42");
  });

  it("says where a run got to", () => {
    expect(describeNotice({ _tag: "ended", runId: "run-1" as RunId, status: "failed" }, now)).toBe(
      "run run-1 failed",
    );
  });
});

describe("who else is on this database", () => {
  it("calls an empty table a factory at rest, because that is what it is", () => {
    // Sharding unregisters on graceful shutdown, so a cleanly stopped watcher leaves no row.
    expect(describeRunners([])).toBe("no runner is registered on this database");
  });

  it("warns about a runner that is still answering", () => {
    const said = describeRunners([
      new RunnerRegistration({ address: "localhost:34431", heartbeatAgeMillis: 3_000 }),
    ]);

    expect(said).toContain("warning: a runner is already registered at localhost:34431");
    expect(said).toContain("heartbeat 3s ago");
    expect(said).toContain("contend for the same shard locks");
  });

  it("calls a registration nobody is refreshing stale, and says it clears itself", () => {
    const said = describeRunners([
      new RunnerRegistration({ address: "localhost:34431", heartbeatAgeMillis: 120_000 }),
    ]);

    expect(said).toContain("note: a runner at localhost:34431 stopped answering 2m ago");
    expect(said).toContain("ages out 35 seconds after its last heartbeat");
  });
});
