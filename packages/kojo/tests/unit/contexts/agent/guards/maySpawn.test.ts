import { describe, expect, it } from "@effect/vitest";
import type { SpawnRequest } from "../../../../../src/contexts/agent/guards/maySpawn.ts";
import { maySpawn } from "../../../../../src/contexts/agent/guards/maySpawn.ts";
import { spendFrom } from "../../../../../src/contexts/agent/models/AgentSpend.ts";

/**
 * The decision that stands between a workflow and a bill.
 *
 * Every case here is a table row over a pure function, and the resolver is an argument — so the one
 * case that actually cost money in this build (a `PATH` override that resolved somewhere else) is a
 * row rather than a story.
 */

const standIn = "/tmp/kojo-rehearsal/claude";

const request = (over: Partial<SpawnRequest>): SpawnRequest => ({
  spend: spendFrom({ declared: `stand-in:${standIn}`, attended: false }),
  agent: "drafter",
  provider: "claude-code",
  model: "haiku",
  run: "run-7f3a",
  binary: "claude",
  resolve: () => standIn,
  sandbox: "none",
  ...over,
});

const refusal = (over: Partial<SpawnRequest>): string => {
  const verdict = maySpawn(request(over));
  if (verdict._tag !== "Refused") throw new Error("expected a refusal, and it spawned");
  return verdict.reason;
};

describe("whether a call may spawn a process", () => {
  it("spawns when the switch says allow", () => {
    expect(maySpawn(request({ spend: spendFrom({ declared: "allow", attended: false }) }))).toEqual(
      {
        _tag: "Spawn",
      },
    );
  });

  it("spawns a stand-in that is really what the name resolves to", () => {
    expect(maySpawn(request({}))).toEqual({ _tag: "Spawn" });
  });

  /**
   * **The row this ticket exists for.**
   *
   * Both unauthorised calls in this build were a stand-in on `PATH` and a real binary at the other
   * end of the name. The author's intention was honest and the resolution was not, and no report
   * written from the intention could have caught it. This is that case, and it refuses.
   */
  it("refuses a stand-in that is not what the name really resolves to", () => {
    const reason = refusal({ resolve: () => "/usr/local/bin/claude" });
    expect(reason).toContain("/usr/local/bin/claude");
    expect(reason).toContain(standIn);
    expect(reason).toContain("PATH override is not a guarantee");
  });

  it("refuses a stand-in when the name resolves nowhere at all", () => {
    expect(refusal({ resolve: () => undefined })).toContain("is on this process's PATH at all");
  });

  /**
   * A container's `PATH` is not this machine's, so the stand-in cannot be checked from here — and a
   * check that cannot be made must not answer *fine*. This is the same rule the doctor follows: a
   * question nobody can answer is never a pass.
   */
  it.each(["bind-mount", "isolated"] as const)("refuses a stand-in on a %s sandbox", (kind) => {
    const reason = refusal({ sandbox: kind });
    expect(reason).toContain(kind);
    expect(reason).toContain("inside the image");
  });

  it("refuses when the switch says refuse, and says how to opt in", () => {
    const reason = refusal({ spend: spendFrom({ declared: "refuse", attended: false }) });
    expect(reason).toContain("before any process was started");
    expect(reason).toContain("KOJO_AGENT_SPEND=allow");
  });

  /**
   * **Every refusal names what would have been called** — criterion 3 of the ticket, as a property
   * over all four refusing rows rather than as one assertion on one of them.
   */
  it.each([
    ["refused outright", { spend: spendFrom({ declared: "refuse", attended: false }) }],
    ["the wrong binary", { resolve: () => "/usr/local/bin/claude" }],
    ["no binary at all", { resolve: () => undefined }],
    ["a container", { sandbox: "bind-mount" as const }],
  ])("names the agent, the provider, the model and the run when %s", (_case, over) => {
    const reason = refusal(over);
    expect(reason).toContain("drafter");
    expect(reason).toContain("claude-code");
    expect(reason).toContain("haiku");
    expect(reason).toContain("run-7f3a");
  });
});
