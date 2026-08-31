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

/** What the decoder writes in front of the type it wanted. Everything after it is that type. */
const expects = "Expected ";

/** One JSON string token, escapes and all, anchored at the start of what is left to read. */
const token = /^"(?:[^"\\]|\\.)*"/;

/**
 * The words a field accepts, when its type is a set of string literals and nothing else.
 *
 * Read back out of the message rather than off the schema, because the message is all a correction
 * has: `DecodeIssue` is what survives being persisted and read back, and it carries the rendered
 * type — `Expected "low" | "medium" | "high"` — and the path, never the AST.
 *
 * **Scanned rather than split.** `"a | b" | "c"` is a real pair of literals and splitting on the
 * separator would report three nonsense words, so tokens are read one at a time and the whole
 * message has to be tokens and separators from end to end. Anything else — `Expected string`,
 * `Expected 1 | 2`, `Missing key` — returns nothing and is reported exactly as the decoder wrote it.
 * Only quoted words are recognised: they are the ones that can be quoted back verbatim as the JSON
 * the agent has to write, and they are the shape the fault was measured on (ticket 48).
 */
const literalsIn = (message: string): ReadonlyArray<string> => {
  if (!message.startsWith(expects)) return [];
  const words: Array<string> = [];
  let rest = message.slice(expects.length);
  for (;;) {
    const [word] = token.exec(rest) ?? [];
    if (word === undefined) return [];
    words.push(word);
    rest = rest.slice(word.length);
    if (rest === "") return words;
    if (!rest.startsWith(" | ")) return [];
    rest = rest.slice(" | ".length);
  }
};

/** The listed words as an English list, so the sentence around them reads as one. */
const anyOf = (words: ReadonlyArray<string>): string =>
  words.length === 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1] ?? ""}`;

/**
 * **What "one of these words" means, spelled out — the one thing a rendered type never says.**
 *
 * Ticket 48 paid for this sentence. A real model was told `risk: Expected "low" | "medium" | "high"`
 * by the lines above, and was also standing under a factory rule that asked for a sentence. Its
 * repair was `"low — this is a one-line text addition to notes/hello.txt …"`: the right word, with
 * the sentence stapled to it. It missed valid by exactly the gap this fills, and it missed it while
 * *obeying* the correction — the type was reported and the rule that a literal is the **whole**
 * value was not, so the model satisfied both instructions the only way that looked open to it.
 *
 * So the clause says three things a type cannot: the value is exactly one of these words, nothing
 * may come before or after it, and the prose that does not fit has nowhere to go in this field. The
 * last one matters most, because a repair that has nowhere to put the sentence writes it here again.
 */
const mustEqualOne = (words: ReadonlyArray<string>): string =>
  [
    "  The whole value must be exactly one of those words, with nothing before it and nothing",
    "  after it — no dash, no sentence, no explanation wrapped around it. Write it as exactly",
    `  ${anyOf(words)}; anything you have to say beyond that has to go elsewhere.`,
  ].join("\n");

const fromDecodeIssue = (issue: DecodeIssue): string => {
  const words = literalsIn(issue.message);
  const reported = `${at(issue.path)}: ${issue.message}`;
  return words.length === 0 ? reported : `${reported}\n${mustEqualOne(words)}`;
};

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
 * 2. **The correction text itself was the untried lever, and it was a Kojo fault rather than a
 *    fixture one.** `forParseError` reported the expected *type* and never said the value must
 *    **equal** one of the listed words with nothing before or after it. Against a model already told
 *    to write a sentence, that gap is what the prefix answer walked into. It is closed now — see
 *    `mustEqualOne` above, which is what a literal field's refusal now carries.
 *
 * **What closing it has and has not been measured against.** It is graded by unit tests built from
 * real `SchemaError` trees, and `correctionLoop.test.ts` drives the whole stamped factory until the
 * repair prompt is handed to an agent process on a resumed turn, with the new clause in it. What no
 * run has produced is a *model* reading it: ticket 51 spent two calls on a small model and neither
 * first answer failed to decode at all — the rendered contract beat the factory's prose rule, twice.
 * So the sentence is proven to reach an agent and is not yet proven to repair one, and the honest
 * reading of that is in `realAgent.test.ts`'s header.
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
