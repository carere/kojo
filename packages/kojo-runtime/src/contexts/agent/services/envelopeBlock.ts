/**
 * The JSON object inside whatever an agent actually said.
 *
 * A scripted invoker answers with the envelope and nothing else. A real one does not: a model told
 * "answer with one JSON object and nothing else" still opens with a sentence often enough that a
 * decoder fed the raw transcript would spend the whole correction budget on punctuation. Worse,
 * Sandcastle's `stdout` is the *assembled text of the turn*, so anything the agent narrated on its
 * way to the answer is in front of it.
 *
 * So the invoker narrows, and the narrowing is here, pure, rather than inside the adapter — this is
 * the part worth grading, and grading it must not cost an agent call.
 *
 * **What it must never do is manufacture an envelope.** Text with no JSON object in it comes back
 * unchanged, which is what makes the deliberate decode failure a real one: the phase then fails to
 * decode, `EnvelopeParseError` carries the issues, and the correction loop sends them back. A
 * narrower that returned `{}` when it found nothing would turn every prose answer into a different
 * error further downstream and the loop would never see the fault it exists for.
 */

/** The fence, spelled once. Written as a value so this file can hold one in a doc comment. */
const fence = "```";

/**
 * The body of the last fenced block, when the answer is fenced at all.
 *
 * The **last**, because a model that shows its working writes the example first and the answer
 * last. The info string is dropped whatever it says — `json`, `JSON`, or nothing — since a block
 * that is not JSON fails the decode a line later anyway, and guessing from the label would reject
 * an answer that was correct and unlabelled.
 */
const lastFencedBlock = (text: string): string | undefined => {
  const opened = text.lastIndexOf(fence);
  if (opened < 0) return undefined;
  const closed = text.lastIndexOf(fence, opened - 1);
  if (closed < 0) return undefined;
  const body = text.slice(closed + fence.length, opened);
  const firstBreak = body.indexOf("\n");
  return firstBreak < 0 ? body : body.slice(firstBreak + 1);
};

/**
 * The largest balanced `{…}` in the text.
 *
 * Brace counting, string-aware, in one pass: every time the depth goes 0 → 1 a candidate opens, and
 * every time it returns to 0 that candidate closes. Nested objects are therefore never candidates of
 * their own, and the result is the list of top-level objects the text holds.
 *
 * **The largest wins, and ties go to the last.** Both halves were measured rather than chosen. A
 * naive `indexOf("{")` / `lastIndexOf("}")` pair splices the first brace of the prose onto the last
 * of the envelope; *first balanced* picks `${name}` out of a sentence about a template string and
 * returns it as the answer. The envelope is a whole object with every field in it, so it is the
 * longest thing in any answer that has one — and when a model shows a small example first, going to
 * the last breaks the tie the right way. It is a heuristic, and it is why `contractFor` tells the
 * agent to answer with the object and nothing else: this is the fallback, not the contract.
 */
const balancedObject = (text: string): string | undefined => {
  let best: string | undefined;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      // A quote outside every object is prose, and prose quotes come in pairs that a JSON scanner
      // would read as one enormous string. Only track strings once an object has opened.
      if (depth > 0) inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, index + 1);
        if (best === undefined || candidate.length >= best.length) best = candidate;
      }
    }
  }

  return best;
};

/**
 * The agent's answer, narrowed to the block a decoder can read.
 *
 * Fence first, braces second, the text itself last. Fence first because a fenced block is the
 * agent saying *this is the answer*, and honouring that is what makes an answer with a worked
 * example in front of it decode.
 */
export const envelopeBlock = (output: string): string => {
  const fenced = lastFencedBlock(output);
  const candidate = fenced === undefined ? undefined : balancedObject(fenced);
  return (candidate ?? balancedObject(output) ?? output).trim();
};
