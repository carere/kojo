/**
 * **The designed decode failure: a rule the rendered contract cannot show the model.**
 *
 * Third design, and the first two are why this one has the shape it has. Both earlier ones asked a
 * model to resolve a conflict between the factory's prose and the factory's envelope, and a model
 * that reads the rendered JSON Schema resolves it in the schema's favour — which is the right answer
 * and the wrong outcome for a test of the correction loop. See *What the first two designs measured*
 * below; nothing there is discarded, because each attempt cost real money and each measured
 * something true.
 *
 * **What is different here.** The constraint on `risk` is a **custom filter**, and Effect renders a
 * custom filter as nothing at all. Measured against `contractFor`, which is the exact text a cold
 * turn is handed:
 *
 *     Schema.Literals(["low","medium","high"])  →  {"type":"string","enum":["low","medium","high"]}
 *     Schema.check(Schema.isMaxLength(12))      →  {"type":"string","allOf":[{"maxLength":12}]}
 *     Schema.check(Schema.makeFilter(…))        →  {"type":"string"}
 *
 * So the model is told `risk` is a string, and nothing more. It cannot comply with a rule it has not
 * been shown, however carefully it reads — and `contractRevealsNothing` in
 * `tests/unit/contexts/agent/services/riskNoteDesign.test.ts` asserts that, so the premise cannot rot
 * quietly the way the last two did.
 *
 * The correction, on the other hand, carries the filter's own message word for word: `DecodeIssue`
 * flattens it to `{path: ["risk"], message: "must be one of …"}`, and `correctionFor` renders it
 * under the field's name. **That is the whole point — a failure a correction can undo that a prompt
 * could not have caused.** It is what ticket 48's audit asked the next design to be, in as many
 * words.
 *
 * **Is this fair to the model?** It is not about the model at all, which is the improvement. The rule
 * *is* expressible as a regular expression, and had the author written one, Effect would have
 * rendered it and the agent would have complied. What makes it invisible is that the author wrote a
 * **filter** — the ordinary way to express a house rule that is easier to say in code than in a
 * pattern. So the fault under test is now a property of Kojo and of Effect's JSON Schema rendering,
 * reproducible against any model: **every author-written `makeFilter` is invisible to the agent, and
 * the correction loop is the only thing that recovers it.**
 *
 * Nothing here tells a model to be wrong, nothing mentions the loop, and the contract is still
 * rendered last and still tells the truth about the field's type.
 *
 * ---
 *
 * ## What the first two designs measured, and why neither is the one to use
 *
 * **Design 1 — a narrow field and a prompt that asks for prose in it** (`risk` typed as three
 * literals, the template asking for one short sentence). Against `sonnet` on 2026-08-13 it worked on
 * the cold turn: the model wrote `"This is a low-risk one-line text addition … check
 * notes/hello.txt …"` and the decoder refused it. The **repair** then answered `"low — this is a
 * one-line text addition to notes/hello.txt …"` — the literal moved to the front, which is a prefix
 * and not the value — and the phase spent its single correction. The finding: *a correction turn
 * moves the answer; it does not fully escape the context that caused the fault.* The remedy that came
 * out of it is built and is now in `correctionFor`, which says a literal field's whole value must
 * equal one of the listed words.
 *
 * **Design 2 — the same, with the house form spelled out** (the rule stating `low — reason`). Against
 * `fable` on 2026-08-14, twice, it did not provoke a failure at all. The first answer decoded, and it
 * decoded because the model saw the conflict and said so *inside its own envelope*: *"(The answer
 * schema constrains the risk field to the enum low/medium/high, so the full sentence lives here.)"*
 * Sharpening the rule bought the same answer again with the reason simply dropped. The finding: **a
 * contract rendered into the prompt beats a rule written in prose**, which also settles why one
 * correction is a defensible bound — with the schema in front of a model, a decode failure is rare.
 *
 * Two designs, three calls, and both findings are about Kojo rather than about a model. What neither
 * bought is the criterion ticket 51 exists for: a repair that **decodes**, with `corrections: 1` read
 * off a succeeded phase.
 */

/** The three words the envelope grades risk with. The single source every half is built from. */
export const riskWords = ["low", "medium", "high"] as const;

/** How many characters of reason the house form insists on, past the grade and the dash. */
const reasonAtLeast = 8;

/**
 * The rule, as the filter states it and therefore as the correction quotes it.
 *
 * It is written as an instruction rather than as a complaint, because this string is the only place
 * the agent ever learns the rule — the rendered contract cannot carry it. A message that said
 * *"invalid risk"* would leave a repair guessing, and a repair that guesses is what design 1 measured.
 */
export const riskRule =
  `must be one of "${riskWords.join('", "')}", then a space, an em dash and a space, then the ` +
  `reason — at least ${reasonAtLeast} characters of it. For example: ` +
  "low — only appends a line to notes/hello.txt";

/** A value the filter accepts. Used by the rehearsal's repair and by the design's own tests. */
export const riskRepair = "low — only appends a line to notes/hello.txt";

/** A value the filter refuses: the sentence a model writes when it has been shown nothing. */
export const riskProse =
  "This change is low risk; it only appends one line to notes/hello.txt and touches no code.";

/**
 * The field added to the throwaway factory's own `Drafted`, as the TypeScript a target repository
 * holds.
 *
 * Added to the stamped envelope rather than replacing it, so `checks.ts`'s `diffMatchesClaims` on
 * `files` and the workflow's use of `summary` keep working — the run under test is the stamped
 * factory's real run, with one field more.
 *
 * The generated source uses `grade + " — "` rather than a template literal on purpose: this string is
 * injected into a file, and a nested template would have to survive two levels of escaping to say
 * one thing.
 */
export const riskField = [
  "  /**",
  "   * How much risk this change carries, in the form this repository writes a grade in.",
  "   *",
  "   * A filter rather than a pattern, which is how a house rule usually gets written: it is",
  "   * easier to say in code than in a regular expression. Note what that costs — Effect renders a",
  '   * custom filter as `{"type":"string"}`, so an agent handed this contract is told nothing',
  "   * about the form, and only a correction can teach it.",
  "   */",
  "  risk: Schema.String.pipe(",
  "    Schema.check(",
  "      Schema.makeFilter((value: string) => {",
  `        const grade = ${JSON.stringify([...riskWords])}.find((word) =>`,
  '          value.startsWith(word + " — "),',
  "        );",
  `        if (grade === undefined) return ${JSON.stringify(riskRule)};`,
  `        return value.slice(grade.length + 3).trim().length >= ${reasonAtLeast}`,
  "          ? undefined",
  `          : ${JSON.stringify(riskRule)};`,
  "      }),",
  "    ),",
  "  ),",
].join("\n");

/**
 * The rule appended to the drafter's own `prompts/drafter/user.md`, before the factory is committed.
 *
 * **It deliberately does not teach the house form.** That is the fault: an author wrote the form as
 * a filter and documented the *purpose* of the field rather than its shape — which is the ordinary
 * shape of this mistake, and far more common than a prompt and an envelope that contradict each
 * other. A model reading this writes a sentence, because a sentence is what it was asked for and
 * because the contract confirms a string is welcome.
 */
export const riskNoteRule = [
  "## The risk note this repository asks every change for",
  "",
  "Nothing is reviewed here without a risk note, and the review tool shows the `risk` field of your",
  "answer on its own, beside the diff. So the note has to be in `risk` itself: a note that ends up in",
  "`summary` instead is never read by the person who needed it.",
  "",
  "Write it for the colleague who reads the diff after you — say how much risk the change carries and",
  "name the path they should look at.",
  "",
  "`summary` is the title of the change and nothing else — one clause, a dozen words at most. It is",
  "not where the risk note goes, and a risk note put there is lost.",
].join("\n");

/**
 * What the run is about, as a person types it after `kojo run review`.
 *
 * Deliberately tiny — one line into one existing file — so `diffMatchesClaims` has nothing to argue
 * with and the only thing that can refuse the answer is the field this design is about. It says
 * nothing about the risk field's shape, for the same reason the rule above does not.
 */
export const riskSubject = "Add a second line saying goodbye to notes/hello.txt";
