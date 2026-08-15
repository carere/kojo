import type { Schema } from "effect";
import { contractSchema } from "../services/renderPrompt.ts";

/**
 * Which of an envelope's own rules the rendered contract cannot show the agent — ticket 58.
 *
 * **`contractFor` is the whole of what a cold turn is told about the answer's shape**, and it is a
 * JSON Schema. Effect renders the checks it has keywords for and drops the ones it has not:
 *
 *     Schema.Literals(["low","medium","high"])  →  {"type":"string","enum":["low","medium","high"]}
 *     Schema.check(Schema.isMaxLength(12))      →  {"type":"string","allOf":[{"maxLength":12}]}
 *     Schema.check(Schema.isTrimmed())          →  {"type":"string","allOf":[{"pattern":"…"}]}
 *     Schema.check(Schema.makeFilter(…))        →  {"type":"string"}
 *
 * So an author who writes a house rule the natural way — as code, because it is easier to say in
 * code than in a pattern — has written a constraint their agent is never shown and cannot satisfy on
 * a first turn. Ticket 51 measured what that costs and what it buys: the correction loop **does**
 * recover it, because `DecodeIssue` carries the filter's own message and `correctionFor` renders it
 * under the field's name. That is a real argument that the loop earns its keep, and it is also one
 * wasted turn on every run for ever, against a `corrections` bound that is finite.
 *
 * Nothing told the author. The run succeeds, slowly, and the trace shows `corrections: 1` on a phase
 * nobody thought was hard. This is what `kojo doctor` exists for — a factory that runs and is quietly
 * wrong — so this is the decision half of that check, pure and beside the renderer it is about.
 *
 * **It reads the contract the prompt actually carries.** `contractSchema` is the function
 * `contractFor` renders from — top-level `$ref` resolved, definitions carried along — so this asks
 * about the very object the agent is handed rather than about a second rendering that might one day
 * differ. An envelope built on `EnvelopeBase` is a `Schema.Class`, whose AST is a `Declaration` with
 * no properties on it and whose JSON Schema is a `$ref` into `definitions`; both halves of that are
 * why neither side of the comparison can be read naively.
 *
 * **How it counts, and why the arithmetic rather than a list of known-good checks.** Every check that
 * renders becomes one entry in the field's `allOf`; every check that does not renders as nothing. So
 * *declared minus shown* is the number of rules the agent cannot see, and it stays right when Effect
 * teaches an existing check to render or adds a new one. A list of "checks that render" would have to
 * be maintained against a library nobody here controls, and would be wrong silently.
 *
 * **Why this tells the author rather than telling the agent.** The other option was to append each
 * filter's message to the rendered contract, so the rule reaches the agent on the cold turn and no
 * correction is needed. It is refused for now, and the reasons are in ticket 58: a filter's message
 * is written for a **decoder** — ticket 51 measured that `correctionFor`'s wording had to be
 * rewritten before a model could act on it — and pasting that register into every cold prompt ships
 * it to every agent on every turn, for a fault most factories do not have. It would also make the
 * contract and the schema two statements of one rule, which is the drift D5 exists to prevent.
 * Telling the author costs no prompt and lets them say the rule where a human reads it too.
 *
 * **What it does not cover, said plainly.** Only the envelope's own top level: its root and its
 * immediate properties. A check inside an array's element, or inside a nested struct, is not counted
 * — the walk would have to mirror Effect's whole AST and would rot against it. Nothing stamped by
 * `kojo init` nests that way today, and `invisibleChecks` is honest about the answer being a lower
 * bound rather than a total.
 */

/** One place an envelope constrains something the contract does not mention. */
export interface InvisibleCheck {
  /** The property's name, or `undefined` when the rule is on the object as a whole. */
  readonly field: string | undefined;
  /** How many rules the schema enforces here. */
  readonly declared: number;
  /** How many of them the rendered contract shows. */
  readonly shown: number;
}

/** How many rules this many are, in words a report can print. */
export const describeInvisible = (check: InvisibleCheck): string => {
  const hidden = check.declared - check.shown;
  const where = check.field === undefined ? "the answer as a whole" : `\`${check.field}\``;
  return `${where} — ${hidden} of ${check.declared} rule${check.declared === 1 ? "" : "s"} not shown`;
};

interface CheckedNode {
  readonly checks?: ReadonlyArray<unknown>;
}

/** A schema's own fields, present on both `Schema.Struct` and a `Schema.Class`. */
interface WithFields {
  readonly fields?: Record<string, { readonly ast?: CheckedNode }>;
  readonly ast?: CheckedNode;
}

interface RenderedField {
  readonly allOf?: ReadonlyArray<unknown>;
}

interface RenderedObject extends RenderedField {
  readonly properties?: Record<string, RenderedField>;
}

/** How many of a node's checks the rendered half shows. Absent `allOf` means none of them. */
const shownIn = (rendered: RenderedField | undefined): number => rendered?.allOf?.length ?? 0;

const declaredOn = (node: CheckedNode | undefined): number => node?.checks?.length ?? 0;

/**
 * The rules this envelope enforces and does not show, outermost first.
 *
 * An empty array is the answer for a well-rendered envelope, which is what almost every stamped
 * factory has. Anything that cannot be read — a schema that will not render at all — comes back empty
 * rather than throwing: this is a diagnostic, and a diagnostic that dies on a factory is worse than
 * one that says nothing about it. The caller reports what it could not look at; see
 * `envelopeContractFinding`.
 */
export const invisibleChecks = (envelope: Schema.Top): ReadonlyArray<InvisibleCheck> => {
  let rendered: RenderedObject;
  try {
    rendered = contractSchema(envelope as never) as unknown as RenderedObject;
  } catch {
    return [];
  }

  const schema = envelope as unknown as WithFields;
  const found: Array<InvisibleCheck> = [];

  const root = { declared: declaredOn(schema.ast), shown: shownIn(rendered) };
  if (root.declared > root.shown) found.push({ field: undefined, ...root });

  for (const [name, field] of Object.entries(schema.fields ?? {})) {
    const declared = declaredOn(field.ast);
    const shown = shownIn(rendered.properties?.[name]);
    if (declared > shown) found.push({ field: name, declared, shown });
  }

  return found;
};
