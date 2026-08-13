import { Cause } from "effect";

/**
 * How much of one field is printed before it is cut.
 *
 * Generous rather than tidy, because the field this exists for is `EnvelopeParseError.raw` — what
 * the agent actually said — and that is the first thing a person wants when a correction loop ran
 * out of retries. A cut says how much it cut, so nobody reads a truncated answer as a short one.
 */
const longestField = 2000;

/** How far into an error's own fields the renderer walks. Deeper than any error model goes. */
const deepestField = 6;

const indent = (depth: number): string => "  ".repeat(depth);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const shortened = (text: string): string =>
  text.length <= longestField
    ? text
    : `${text.slice(0, longestField)}… (${text.length - longestField} more characters)`;

/**
 * What one value is called when it has to fit on the end of `key: `.
 *
 * A tagged value collapses to its tag, so `outcome: Restored` reads as the one word it is rather
 * than as a nested block holding a single `_tag`.
 */
const scalar = (value: unknown): string | undefined => {
  if (typeof value === "string") return shortened(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) return shortened(value.message === "" ? value.name : value.message);
  if (isRecord(value) && typeof value._tag === "string" && Object.keys(value).length === 1) {
    return value._tag;
  }
  return undefined;
};

/**
 * One field, as the lines it needs.
 *
 * Written as a walk over the value rather than as a case per error tag, and the difference is what
 * it costs to add an error. A table of tags is a table that goes stale: the tag added next release
 * renders as nothing, silently, and the silence looks exactly like an error with no fields. Every
 * typed error in this build is a `Schema.TaggedError`, so its fields are its own enumerable
 * properties — walking them says everything the error knows and cannot fall behind the models.
 */
const field = (key: string, value: unknown, depth: number): ReadonlyArray<string> => {
  // `null` as well as `undefined`, because the two are the same fact after a round trip through the
  // engine's storage: `AgentInvocationError.cause` is a `Schema.Defect()` that was given nothing,
  // and it reads back as `null`. A line saying `cause: null` is a line that says nothing.
  if (value === undefined || value === null) return [];

  const flat = scalar(value);
  if (flat !== undefined) {
    const [head, ...rest] = flat.split("\n");
    return [
      `${indent(depth)}${key}: ${head ?? ""}`,
      ...rest.map((line) => `${indent(depth + 1)}${line}`),
    ];
  }

  if (depth >= deepestField) return [`${indent(depth)}${key}: …`];

  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return [
      `${indent(depth)}${key}:`,
      ...value.flatMap((element, at) => field(`${at + 1}`, element, depth + 1)),
    ];
  }

  if (isRecord(value)) {
    const inner = Object.entries(value).flatMap(([name, held]) =>
      name === "_tag" ? [] : field(name, held, depth + 1),
    );
    const tag = typeof value._tag === "string" ? ` ${value._tag}` : "";
    return inner.length === 0
      ? [`${indent(depth)}${key}:${tag === "" ? " —" : tag}`]
      : [`${indent(depth)}${key}:${tag}`, ...inner];
  }

  return [`${indent(depth)}${key}: ${String(value)}`];
};

/** What names the error at the head of the block: its tag, then its class, then whatever it is. */
const named = (error: unknown): string => {
  if (isRecord(error) && typeof error._tag === "string") return error._tag;
  if (error instanceof Error) return error.name;
  return String(error);
};

/** The fields of a typed error, indented under its name. */
const carried = (error: unknown): ReadonlyArray<string> =>
  isRecord(error)
    ? Object.entries(error).flatMap(([name, held]) => (name === "_tag" ? [] : field(name, held, 1)))
    : [];

/**
 * A defect is a bug rather than an outcome, so it is said differently and it keeps its stack.
 *
 * The stack is the answer here in a way it never is for a typed error: nobody declared this, so the
 * line that threw is the only thing that says where to look. Nothing else prints it — `RunFailed`
 * sets `Runtime.errorReported` false, so this rendering is the whole report.
 */
const died = (defect: unknown): ReadonlyArray<string> => {
  const head = `died: ${named(defect)}`;
  if (defect instanceof Error) {
    const message = defect.message === "" ? [] : [`${indent(1)}${shortened(defect.message)}`];
    const stack = defect.stack === undefined ? [] : [shortened(defect.stack)];
    return [head, ...message, ...stack.flatMap((text) => text.split("\n").slice(1))];
  }
  return [head, ...carried(defect)];
};

const reason = (held: Cause.Reason<unknown>): ReadonlyArray<string> => {
  if (Cause.isFailReason(held)) return [named(held.error), ...carried(held.error)];
  if (Cause.isDieReason(held)) return died(held.defect);
  return ["interrupted"];
};

/**
 * Why a run failed, in the words the error itself carries.
 *
 * **The typed error channel is what this design spent its whole error story on, and until this it
 * reached no surface a person reads.** A run that died printed the two words `run failed`, which is
 * the same sentence for an agent that was never called, an answer that would not decode, a check
 * that did not hold, a path an agent had no business writing, and a change nobody accepted. Each of
 * those errors already knows the one fact its reader needs; this prints it.
 *
 * Every reason is rendered, not only the first. A cause with two failures in it is a run where two
 * things went wrong, and choosing one of them for the reader is choosing which half they debug.
 */
export const describeFailure = (cause: Cause.Cause<unknown>): string => {
  const lines = cause.reasons.flatMap(reason);
  return lines.length === 0 ? "the run failed and recorded nothing about why" : lines.join("\n");
};
