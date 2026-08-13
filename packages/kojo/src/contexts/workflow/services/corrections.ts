import { Effect, Option } from "effect";
import type { DecodeIssue } from "../../shared/models/DecodeIssue.ts";
import type { ClaimFault } from "../models/CheckReport.ts";
import { CheckViolation } from "../models/CheckViolation.ts";
import { EnvelopeParseError } from "../models/EnvelopeParseError.ts";

/** The whole answer, when a fault has no path to point at. Rendering `""` would point nowhere. */
const wholeAnswer = "the answer as a whole";

const at = (path: ReadonlyArray<string>): string =>
  path.length === 0 ? wholeAnswer : path.join(".");

const listing = (lines: ReadonlyArray<string>): string =>
  lines.map((line) => `- ${line}`).join("\n");

const fromDecodeIssue = (issue: DecodeIssue): string => `${at(issue.path)}: ${issue.message}`;

const fromClaimFault = (fault: ClaimFault): string =>
  `${at(fault.claim)} — "${fault.subject}": ${fault.detail}`;

/**
 * Why a shape was refused, field by field.
 *
 * Written from the `SchemaIssue.Issue` tree the decode carried, never from a rendered string. The
 * tree is what names `changedFiles.0`; a message loses the path, and an agent told only "invalid
 * input" spends the next turn guessing which field to change.
 */
const forParseError = (failure: EnvelopeParseError): string =>
  [
    `Your last answer was not a valid \`${failure.expected}\`, so none of it was accepted.`,
    "",
    "These fields are wrong:",
    listing(failure.issues.map(fromDecodeIssue)),
    "",
    `Answer again with the whole \`${failure.expected}\`, with those fields corrected. Send the`,
    "envelope on its own — nothing before it and nothing after it.",
  ].join("\n");

/**
 * Which claims did not hold, and what the repository holds instead.
 *
 * Every failing check, not the first: the loop is bounded, so an answer told one fault per turn can
 * exhaust the bound without ever hearing the third thing that was wrong.
 */
const forCheckViolation = (failure: CheckViolation): string => {
  const failed = failure.report.failed;
  const graded = failure.report.results.length;
  return [
    `Your last answer had the right shape, and ${failed.length} of the ${graded} checks that`,
    "graded it against the repository did not hold.",
    "",
    ...failed.flatMap((result) => [
      `${result.check} — ${result.description}`,
      listing(result.faults.map(fromClaimFault)),
      "",
    ]),
    "Answer again with the whole envelope. Change the repository where the answer was right and",
    "change the answer where the repository was right — do not simply restate what was refused.",
  ].join("\n");
};

/**
 * The next prompt, built from the failure that earned it.
 *
 * Exported because the text is the whole value of the loop and a test has to be able to read it:
 * the assertion worth making is that the correction *names the fields*, and that assertion needs
 * the string.
 */
export const correctionFor = (failure: EnvelopeParseError | CheckViolation): string =>
  failure._tag === "EnvelopeParseError" ? forParseError(failure) : forCheckViolation(failure);

/** How many correction turns a phase spends before it gives up, when it does not say. */
export const defaultCorrections = 2;

/**
 * The only two failures a correction turn can answer.
 *
 * Kept as a value rather than written at the catch site so there is exactly one place the list
 * exists, and so the thing D8 is about — what is **not** in it — is one line to read. `catchTag`
 * constrains this list to tags the effect can actually raise, which is what makes a `PermissionBreach`
 * here a compile error rather than a review comment.
 */
const refusable = ["EnvelopeParseError", "CheckViolation"] as const;

/**
 * Attempt, and on a refusable failure attempt again with the failure turned into the next prompt.
 *
 * Not a retry. `Effect.retry` re-runs the same effect and learns nothing between goes; here the
 * error *is* the next input, and the caller is expected to send it into the same agent session so
 * the correction costs one message rather than a cold start.
 *
 * **Exactly two tags are handled, and `PermissionBreach` is deliberately not one of them.** Every
 * other error the attempt can raise stays in the residual channel `E` and travels straight out — a
 * breach cannot be corrected by re-prompting, because the write already happened and has already
 * been undone. The tag list is what makes that structural rather than a docstring: naming a tag the
 * effect cannot raise is a hard type error, so a breach cannot be retried by accident and a handler
 * cannot be written for an error that does not exist. See architecture.md D8, and the assertion in
 * the test beside this file, which `bun tsc` is what runs.
 *
 * **Exhausting the bound fails with the original error, never a wrapper.** A phase that ran out of
 * corrections failed for the reason its last answer was refused, and a `CorrectionsExhausted`
 * around it would bury that reason one level down in every trace row and every catch site.
 *
 * **A correction turn moves the answer, but it does not fully escape the context that caused the
 * fault — and that is what bounds how much this can repair.** Measured against a real model on
 * ticket 48, quoted from the session transcript rather than summarised:
 *
 * - the factory's task template asked for a risk note as *one short sentence*, in a field the
 *   envelope typed as three literals, and said a bare word is not a risk note;
 * - the cold answer put a sentence there — `"This is a low-risk one-line text addition with no code
 *   or config impact; check notes/hello.txt to confirm only the new goodbye line was added."`;
 * - the correction named the field and the words it wanted (`risk: Expected "low" | "medium" |
 *   "high"`);
 * - the repair answered `"low — this is a one-line text addition to notes/hello.txt with no code or
 *   config impact, so just confirm only the goodbye line was added there."`
 *
 * The repair **did** change the answer, and changed it towards valid: it moved the expected literal
 * to the front. It still failed, because a literal must be the *whole* value and this one was a
 * prefix. So the useful reading is not "a model ignores the correction" — it plainly did not — but
 * that the standing instruction is still in the conversation the repair re-enters, and the model
 * tried to satisfy both at once. It failed by a hair, in the one way the correction had not ruled
 * out.
 *
 * Two consequences for whoever writes the next phase:
 *
 * 1. The number a phase passes here is a claim about *how badly its own prompt and envelope might
 *    disagree*, not only about how careless a model might be. An author who finds one repair is
 *    never enough should suspect the disagreement before raising the bound.
 * 2. **The correction text itself is the untried lever, and it is a Kojo fault rather than a fixture
 *    one.** `forParseError` reports the expected *type* and never says the value must **equal** one
 *    of the listed words with nothing before or after it. Against a model already told to write a
 *    sentence, that gap is what the prefix answer walked into. A correction that closed it would
 *    very likely have decoded. That is a hypothesis, not a measurement — it is what the next real
 *    call should buy, ahead of any change to the bound.
 */
export const withCorrections = <A, E, R>(
  attempt: (
    correction: Option.Option<string>,
  ) => Effect.Effect<A, EnvelopeParseError | CheckViolation | E, R>,
  limit: number,
): Effect.Effect<A, EnvelopeParseError | CheckViolation | E, R> => {
  const go = (
    spent: number,
    correction: Option.Option<string>,
  ): Effect.Effect<A, EnvelopeParseError | CheckViolation | E, R> => {
    // Widened on purpose. The tag list above is what selects a failure; this is what refuses to
    // *correct* one that only shares a name — a residual error of the caller's that calls itself
    // `CheckViolation` is somebody else's error, and inventing a prompt from it would be worse
    // than letting it out.
    const again = (
      failure: EnvelopeParseError | CheckViolation | E,
    ): Effect.Effect<A, EnvelopeParseError | CheckViolation | E, R> => {
      const ours = failure instanceof EnvelopeParseError || failure instanceof CheckViolation;
      return !ours || spent >= limit
        ? Effect.fail(failure)
        : go(spent + 1, Option.some(correctionFor(failure)));
    };

    return attempt(correction).pipe(Effect.catchTag(refusable, again));
  };

  return go(0, Option.none());
};
