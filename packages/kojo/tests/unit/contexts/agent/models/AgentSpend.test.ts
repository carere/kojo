import { describe, expect, it } from "@effect/vitest";
import type { AgentSpend } from "../../../../../src/contexts/agent/models/AgentSpend.ts";
import {
  describeSpend,
  spendFrom,
  spendVariable,
} from "../../../../../src/contexts/agent/models/AgentSpend.ts";

/**
 * The switch, read as a table.
 *
 * The one property that matters is stated first and stated as a property rather than as a case:
 * **nothing a person can typo may decode to `Allow`.** Everything else here is the wording of a
 * mode; that is the guard.
 */

const modes = (declared: string | undefined, attended: boolean): AgentSpend["_tag"] =>
  spendFrom({ declared, attended })._tag;

describe("what the spend switch says", () => {
  it("names one variable, and it is the one the guard reads", () => {
    expect(spendVariable).toBe("KOJO_AGENT_SPEND");
  });

  it.each([
    ["allow", "Allow"],
    ["refuse", "Refuse"],
    ["stand-in:/tmp/fake/claude", "StandIn"],
    // Whitespace is a person's, not a value's. `KOJO_AGENT_SPEND="allow "` is a person saying allow.
    ["  allow  ", "Allow"],
  ] as const)("reads %s as %s", (declared, expected) => {
    expect(modes(declared, false)).toBe(expected);
  });

  it("carries the stand-in's path, so the guard has something to compare against", () => {
    const spend = spendFrom({ declared: "stand-in:/tmp/fake/claude", attended: false });
    expect(spend).toStrictEqual({
      _tag: "StandIn",
      binary: "/tmp/fake/claude",
      because: `${spendVariable}=stand-in:/tmp/fake/claude`,
    });
  });

  /**
   * **The property, not a case.**
   *
   * A switch that spends somebody's money must fail closed, and the way this one could fail open is
   * a value nobody anticipated decoding to `Allow` — a typo, an old spelling, a shell that expanded
   * to nothing but a space. Every one of these is refused, and the refusal says what the three
   * words are.
   */
  it.each([
    "yes",
    "true",
    "1",
    "ALLOW",
    "allow please",
    "spend",
    // The old convention, spelled the way the two lost walk-throughs would have spelled it.
    "KOJO_REAL_AGENT",
    // A stand-in that is not an absolute path: resolved against a directory the guard does not own.
    "stand-in:claude",
    "stand-in:./fake/claude",
    "stand-in:",
  ])("refuses %s rather than guessing what it meant", (declared) => {
    expect(modes(declared, false)).toBe("Refuse");
    // Even attended. An unreadable value is not a licence, whoever is watching.
    expect(modes(declared, true)).toBe("Refuse");
  });

  /**
   * The default rule, which is the whole reason this is not simply "off unless set".
   *
   * A person at a terminal typed `kojo run` and is watching it; an unattended process is where both
   * unauthorised calls in this build were spent, and where nobody would see the bill until later.
   */
  it("defaults to allow when a person is attached and to refuse when nobody is", () => {
    expect(modes(undefined, true)).toBe("Allow");
    expect(modes(undefined, false)).toBe("Refuse");
    expect(modes("", true)).toBe("Allow");
    expect(modes("", false)).toBe("Refuse");
  });

  it("says why, in words that name the variable, whatever the mode", () => {
    for (const declared of [undefined, "allow", "refuse", "stand-in:/tmp/x", "nonsense"]) {
      for (const attended of [true, false]) {
        expect(spendFrom({ declared, attended }).because).toContain(spendVariable);
      }
    }
  });

  it("describes each mode by what may happen, not by what was configured", () => {
    expect(describeSpend(spendFrom({ declared: "allow", attended: false }))).toContain(
      "real agent calls are allowed",
    );
    expect(describeSpend(spendFrom({ declared: "refuse", attended: false }))).toContain(
      "no agent may be spawned",
    );
    expect(describeSpend(spendFrom({ declared: "stand-in:/tmp/x", attended: false }))).toContain(
      "only /tmp/x may be spawned",
    );
  });
});
