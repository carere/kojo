import { JsonPointer, JsonSchema, Option, Schema } from "effect";
import type { AgentDefinition } from "../models/AgentDefinition.ts";

/**
 * Every `$ref` string anywhere below a JSON value, in the order they are met.
 *
 * A hand walk rather than a schema traversal, because what is being walked is already plain JSON —
 * the emitted document — and the only question asked of it is which pointers it still holds.
 */
/** A plain JSON object, or nothing. The emitted schema is `unknown` below its own top level. */
const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const referencesIn = (node: unknown, into: Array<string>): void => {
  if (Array.isArray(node)) {
    for (const item of node) referencesIn(item, into);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") into.push(value);
    else referencesIn(value, into);
  }
};

/** `#/$defs/Finding` names `Finding`. Pointer tokens are escaped, so they are unescaped here. */
const definitionName = (reference: string): string => {
  const tokens = reference.split("/");
  return JsonPointer.unescapeToken(tokens[tokens.length - 1] ?? "");
};

/**
 * Only the definitions the emitted schema can still reach, followed transitively.
 *
 * The root definition is nearly always the only one there is, and after the top-level `$ref` is
 * resolved nothing points at it any more — so pruning turns the ordinary envelope into a single
 * self-contained object rather than an object printed twice.
 */
const reachedDefinitions = (
  document: JsonSchema.Document<"draft-2020-12">,
): JsonSchema.Definitions => {
  const reached: Record<string, JsonSchema.JsonSchema> = {};
  const pending: Array<string> = [];
  referencesIn(document.schema, pending);

  for (let reference = pending.pop(); reference !== undefined; reference = pending.pop()) {
    // `#` is the emitted object itself, which is exactly what a recursive envelope means by it.
    if (reference === "#") continue;
    const name = definitionName(reference);
    if (Object.hasOwn(reached, name)) continue;
    const definition = JsonSchema.resolve$ref(reference, document.definitions);
    if (definition === undefined) continue;
    reached[name] = definition;
    referencesIn(definition, pending);
  }
  return reached;
};

/**
 * The envelope as one JSON Schema an agent can read top to bottom.
 *
 * `Schema.toJsonSchemaDocument` returns a **document** — `{ dialect, schema: { $ref }, definitions }`
 * — so pasting it into a prompt hands the agent a pointer into a document it was never given. The
 * top-level `$ref` is resolved, and whatever the result still points at is carried along as `$defs`
 * inside the same object. What the agent reads therefore resolves against itself.
 */
export const contractSchema = (envelope: Schema.Constraint): JsonSchema.JsonSchema => {
  const document = JsonSchema.resolveTopLevel$ref(Schema.toJsonSchemaDocument(envelope));
  const reached = reachedDefinitions(document);
  return Object.keys(reached).length === 0
    ? document.schema
    : { ...document.schema, $defs: reached };
};

/**
 * The tag the answer must carry, read out of the envelope's own JSON Schema.
 *
 * Derived, never passed in. The tag in the prompt and the tag the decoder enforces are then the
 * same string by construction, which is the whole of D5 in one line: drift is not expressible.
 *
 * `None` for a schema that declares no tag. An envelope built on `EnvelopeBase` always declares
 * one; a prompt that asserted a tag anyway would be inventing a contract.
 */
export const outputTag = (envelope: Schema.Constraint): Option.Option<string> => {
  const tag = asObject(asObject(contractSchema(envelope).properties)?._tag);
  const values = tag?.enum;
  const only = Array.isArray(values) && values.length === 1 ? values[0] : undefined;
  return typeof only === "string" ? Option.some(only) : Option.none();
};

const fence = "```";

/** The half of the prompt that is Kojo's rather than the author's: what to answer, and in what shape. */
export const contractFor = (envelope: Schema.Constraint): string => {
  const tag = outputTag(envelope);
  const lines = [
    "## The answer",
    "",
    "Answer with one JSON object and nothing else. No prose before it, no prose after it.",
  ];
  if (Option.isSome(tag)) lines.push("", `Set \`_tag\` to exactly \`"${tag.value}"\`.`);
  lines.push(
    "",
    "The object must satisfy this JSON Schema (draft 2020-12):",
    "",
    `${fence}json`,
    JSON.stringify(contractSchema(envelope), undefined, 2),
    fence,
  );
  return lines.join("\n");
};

/**
 * The prompt a **cold** turn carries: who the agent is, what it is for, and what it was asked.
 *
 * The contract is not here. It is appended by the agent *phase*, which is the only place that holds
 * the envelope — see `contractFor` and `services/phase/agent.ts`. The split is what keeps the schema
 * on Kojo's side of the `AgentInvoker` port, so `EnvelopeParseError` belongs to the phase and the
 * correction loop can act on it.
 *
 * **`system` is in the prompt, and that is a compromise the provider forces.** An agent is a system
 * prompt, a tool allowlist and a model, and Sandcastle's `claudeCode()` — used as it ships, on
 * purpose — builds `claude --print --output-format stream-json --model X -p -` and has no
 * `--system-prompt` and no `--tools`. So a roster's identity travels in the text of the turn or it
 * does not travel at all, and an identity that silently did not travel is a *different agent* rather
 * than a crash. `kojoPi` exists because pi *does* have the flags; this is the other half of that
 * same finding.
 *
 * **A correction turn does not go through here.** It is one more message in a conversation that
 * already carries all of this, and re-sending the identity would make the cheap retry the design
 * rests on cost as much as a cold start.
 */
export const renderPrompt = (options: {
  readonly agent: AgentDefinition;
  /** What this call is about — the task, and the contract the phase already appended to it. */
  readonly task: string;
}): string =>
  [options.agent.system.trim(), options.agent.user.trim(), options.task.trim()]
    .filter((section) => section.length > 0)
    .join("\n\n");
