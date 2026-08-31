/**
 * Whether this process may spawn an agent at all — the switch, and how it is read.
 *
 * **This exists because a convention failed and cost the owner two calls nobody authorised.**
 * `KOJO_REAL_AGENT` gated the real-agent *test*; it appears nowhere in `src/` and never gated the
 * CLI. So two walk-throughs put a shell script named `claude` in front of the child's `PATH`,
 * intended a stand-in, resolved the real binary, and reported honestly that the flag was never set.
 * Both halves of that report were true and the conclusion drawn from them was false. See ticket 49
 * and `build-record.md` §9.
 *
 * Every other invariant in this build that mattered was made structural — a `PermissionBreach` the
 * correction loop cannot catch because the compiler refuses the handler, a record constructor that
 * cannot build an invalid envelope. This one was left to a convention. So it is a value the
 * **invoker** reads, and the refusal happens before a process exists.
 *
 * Not a `Schema`, deliberately. A schema is for something that crosses a boundary and comes back;
 * this crosses one way only, from one environment variable into one decision, and
 * {@link spendFrom} is its decoder. What a bad value must never do is decode to *allow*, and that
 * is a property of the function rather than of a wire contract.
 */

/** The one variable. Named once, because a guard nobody can spell is a guard nobody sets. */
export const spendVariable = "KOJO_AGENT_SPEND";

/** The prefix of the one mode that takes an argument. */
const standInPrefix = "stand-in:";

/**
 * What this process is allowed to spawn.
 *
 * Three modes, because two would not have caught the calls that were actually spent. *Refuse* and
 * *allow* alone force every test that needs a scripted binary to declare *allow* — which is exactly
 * the sentence the two lost walk-throughs would have written, and it would have bought them
 * nothing. **StandIn** is the third: it says *a process may run, and here is the only file it may
 * be*, which is a claim the invoker can check instead of believe.
 */
export type AgentSpend =
  /** No agent process may be spawned. `because` is quoted back in the refusal. */
  | { readonly _tag: "Refuse"; readonly because: string }
  /**
   * A process may be spawned only if the provider's binary resolves to exactly this file.
   *
   * An absolute path, because a relative one is resolved against a working directory the invoker
   * does not own — and the fault this mode exists to catch *is* a path resolving somewhere else.
   */
  | { readonly _tag: "StandIn"; readonly binary: string; readonly because: string }
  /** Real calls may be made, and they cost money. */
  | { readonly _tag: "Allow"; readonly because: string };

/**
 * Read the switch, and decide what an unset one means.
 *
 * **Unset is not one answer.** A person who types `kojo run` in their own terminal wants their
 * factory to run, and a Kojo that refused by default everywhere would be a Kojo nobody could use
 * without an incantation. An unattended process is the opposite case: nobody is watching, the spend
 * is discovered on the bill, and this is where both unauthorised calls happened. So attendance
 * decides the default, and *attendance* means a terminal on stdin — which no Vitest worker, no
 * Playwright fixture, no CI step and no agent-driven shell has.
 *
 * `attended` is an argument rather than a read of `process.stdin`, so the whole rule is graded by a
 * table with no terminal in sight.
 */
export const spendFrom = (input: {
  /** The raw value of {@link spendVariable}, exactly as the environment holds it. */
  readonly declared: string | undefined;
  /** Whether a person is at the other end of this process. */
  readonly attended: boolean;
}): AgentSpend => {
  const declared = (input.declared ?? "").trim();

  if (declared === "") {
    return input.attended
      ? {
          _tag: "Allow",
          because: `${spendVariable} is not set and a terminal is attached, so this run is attended`,
        }
      : {
          _tag: "Refuse",
          because:
            `${spendVariable} is not set and no terminal is attached, so this process is ` +
            "unattended and nobody would see what it spent",
        };
  }

  if (declared === "allow") {
    return { _tag: "Allow", because: `${spendVariable}=allow` };
  }

  if (declared === "refuse") {
    return { _tag: "Refuse", because: `${spendVariable}=refuse` };
  }

  if (declared.startsWith(standInPrefix)) {
    const binary = declared.slice(standInPrefix.length).trim();
    // Refused rather than resolved. A relative path is resolved against whatever directory the
    // process happens to be in, and "somewhere other than where you thought" is the entire fault
    // this mode exists to catch — reproducing it inside the guard would be a joke at the reader's
    // expense.
    return binary.startsWith("/")
      ? { _tag: "StandIn", binary, because: `${spendVariable}=${standInPrefix}${binary}` }
      : {
          _tag: "Refuse",
          because:
            `${spendVariable} names a stand-in that is not an absolute path (${binary || "nothing at all"}), ` +
            "and a relative one would be resolved against a directory this guard does not own",
        };
  }

  // The one case a switch must never get wrong. An unreadable value is a person who meant to say
  // something, and the safe reading of a sentence nobody understood is *do not spend*.
  return {
    _tag: "Refuse",
    because: `${spendVariable}=${declared} was not understood — it is \`allow\`, \`refuse\`, or \`${standInPrefix}<absolute path>\``,
  };
};

/** The mode in one line, for `kojo doctor`. Says what may happen, never what was configured. */
/** @public */
export const describeSpend = (spend: AgentSpend): string => {
  switch (spend._tag) {
    case "Allow":
      return `real agent calls are allowed — ${spend.because}`;
    case "StandIn":
      return `only ${spend.binary} may be spawned — ${spend.because}`;
    case "Refuse":
      return `no agent may be spawned — ${spend.because}`;
  }
};
