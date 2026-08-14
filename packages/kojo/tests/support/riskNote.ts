/**
 * **The designed decode failure: a narrow field, and a prompt that asks for prose in it.**
 *
 * Ticket 48 has three real agent calls to prove that Kojo's correction loop works against a model,
 * and a corrected run costs two of them. So the failure cannot be *hoped for*; it has to be designed,
 * and the design has to be rehearsed against a scripted stand-in before a single call is spent. This
 * module is that design, held in one place so the rehearsal
 * (`tests/integration/cli/correctionLoop.test.ts`) and the real run
 * (`tests/integration/cli/realAgent.test.ts`) cannot drift apart — a rehearsal of a different
 * envelope would prove nothing about the run that is paid for.
 *
 * **Why this shape rather than "please answer wrongly".** An agent told to be wrong is being graded
 * on obedience, and it also learns that a correction is coming, which is exactly the thing under
 * test. So nothing here mentions the loop. Instead the factory asks for **something its own envelope
 * cannot accept**:
 *
 * - `risk` is `Schema.Literals(["low", "medium", "high"])` — three bare words and nothing else.
 * - The drafter's own task template asks for the risk note as *one short sentence*, and says a bare
 *   word is refused by review because it tells a reviewer nothing.
 *
 * The two instructions cannot both be satisfied. A model that answers the task faithfully writes a
 * sentence — `"low — it only appends a line to a notes file"` — and the decoder refuses it at
 * `risk`, naming the field and the three words it wanted. Nothing about that is the model being
 * bad at its job; it is the ordinary factory-authoring fault of a prompt and an envelope that
 * disagree, which is the fault the correction loop exists for. The repair then carries what the
 * contract could not: the decoder's own complaint, path-precise.
 *
 * **What the rendered contract says, measured rather than assumed.** `contractFor` emits
 * `{"type":"string","enum":["low","medium","high"]}` for this field, so the constraint *is* in front
 * of the model — the failure is a conflict the model has to resolve, not a rule hidden from it. That
 * is the honest version of the experiment, and it is why a reserve call exists: a model that resolves
 * the conflict the other way answers `"low"`, the run succeeds with `corrections: 0`, and the finding
 * is that a schema in the prompt beats a rule in the prose.
 *
 * **What pushes each way, written down before the money was spent.** Towards prose: the rule below
 * says the note goes in `risk` and not in `summary`, asks for a path inside the sentence, and the
 * subject repeats it after the task. Towards the enum: the contract is rendered *last*, and the
 * stamped drafter's own `system.md` already warns that an answer which does not decode is sent back
 * once and then the phase fails. Both were left as they are — weakening the template to make a model
 * fail would be grading a fixture.
 *
 * **What it did when it was paid for, on 2026-08-13 against `sonnet`.** Both turns, quoted from the
 * session transcript, because the difference between them is the whole finding:
 *
 * - **cold** — `risk: "This is a low-risk one-line text addition with no code or config impact;
 *   check notes/hello.txt to confirm only the new goodbye line was added."` (142 characters), refused
 *   at `risk`. **The design provoked the fault on the first turn, so no reserve call was needed for
 *   it.**
 * - **repair** — `risk: "low — this is a one-line text addition to notes/hello.txt with no code or
 *   config impact, so just confirm only the goodbye line was added there."` (143 characters), refused
 *   at `risk` again, and the phase had spent its single correction.
 *
 * **The repair was not a restatement.** The model rewrote the sentence and moved the literal `low`
 * to the front — the compromise a reader of `Expected "low" | "medium" | "high"` would attempt while
 * still obeying "write the sentence". It failed because a literal must be the *whole* value, not a
 * prefix of it. So the correction did work on the answer; it simply did not say the one thing that
 * would have settled it.
 *
 * **Which moves the unfinished half of this design off the fixture and onto Kojo.** The earlier
 * reading — that the clause *"a sentence that ends up in `summary` instead is never read"* leaves the
 * model nowhere to obey both — is still a live diagnosis, but it is no longer the first one to test:
 * `correctionFor` never told the model that `risk` must **equal** one of the three words with nothing
 * before or after it, and the answer it got back differs from a valid one by exactly that. The remedy
 * is built, and `realAgent.test.ts`'s header carries what it then bought.
 *
 * **What the design did against a *small* model, on 2026-08-14 (ticket 51, `fable`, one call).** It
 * did not provoke the fault at all. The cold answer decoded first time, and it decoded because the
 * model **saw the conflict and resolved it in the schema's favour, out loud, in the answer**:
 *
 *     {"_tag":"Drafted",
 *      "summary":"Added a second line reading \"goodbye\" to notes/hello.txt … Risk note: this
 *                 change carries low risk — it only appends one plain-text line, and the only path
 *                 to look at is notes/hello.txt. (The answer schema constrains the risk field to
 *                 the enum low/medium/high, so the full sentence lives here.)",
 *      "files":["notes/hello.txt"], "risk":"low"}
 *
 * That is the reserve case this file predicted in as many words — *a schema in the prompt beats a
 * rule in the prose* — now measured rather than imagined, and it is a finding about **Kojo** rather
 * than about the model: rendering the contract into the prompt is what makes a decode failure rare,
 * which is also why one correction is a defensible bound.
 *
 * **So the disagreement was sharpened, and only in the two places the measurement pointed at.** The
 * model escaped through `summary`, so the rule now says what `summary` is for; and the rule now
 * states the house **form** of a grade — `low — reason`, one string — instead of asking for "a
 * sentence", because a form that *begins* with a valid word is the shape a model reads as satisfying
 * both. Nothing here tells a model to be wrong, nothing mentions the correction loop, and the
 * contract is still rendered last and still says `enum`. What changed is only that the repository's
 * own convention is now unambiguous, which is the ordinary way a factory's prompt and its envelope
 * come to disagree.
 *
 * **The sharpened version was measured too, and it lost as well.** The second call answered
 * `risk: "low"` with a one-clause `summary`, dropping the reason the house form asks for rather than
 * writing it anywhere. So this design has now failed to provoke a decode failure against a small
 * model twice, at two strengths of rule, and the next attempt should not be a third strength: **the
 * refusal has to be one the rendered contract cannot show the model in advance.** Measure the next
 * design against `contractFor`'s output before spending anything on it.
 */

/** The three words the envelope grades risk with. The single source both halves are built from. */
export const riskWords = ["low", "medium", "high"] as const;

/**
 * The field added to the throwaway factory's own `Drafted`, as the TypeScript a target repository
 * holds.
 *
 * It is added to the stamped envelope rather than replacing it, so `checks.ts`'s
 * `diffMatchesClaims` on `files` and the workflow's use of `summary` keep working — the run under
 * test has to be the stamped factory's real run, with one field more.
 */
export const riskField = [
  "  /**",
  "   * How much risk this change carries, in the three words this repository grades risk with.",
  "   */",
  `  risk: Schema.Literals([${riskWords.map((word) => `"${word}"`).join(", ")}]),`,
].join("\n");

/**
 * The rule appended to the drafter's own `prompts/drafter/user.md`, before the factory is committed.
 *
 * It goes in the factory's prompt file because that is where a factory tells its agent how to work,
 * and because this is what the fault looks like in the wild: a rule written for a human reviewer,
 * and an envelope that never learned about it.
 */
export const riskNoteRule = [
  "## The risk note this repository asks every change for",
  "",
  "Nothing is reviewed here without a risk note, and the review tool shows the `risk` field of your",
  "answer on its own, beside the diff. So the note has to be in `risk` itself: a sentence that ends up",
  "in `summary` instead is never read by the person who needed it.",
  "",
  "Write it for the colleague who reads the diff after you — one short sentence saying how much risk",
  "the change carries and naming the path they should look at.",
  "",
  "A single bare word is not a risk note. A reviewer who reads `low` on its own learns nothing about",
  "what to look at, so write the sentence.",
  "",
  "### The form a risk grade is written in here",
  "",
  "A grade in this repository is the grade, an em dash, and the reason for it, in one string:",
  "",
  "    low — only appends a line to a notes file",
  "",
  "That is what the changelog quotes and what review reads, so `risk` is written that way.",
  "",
  "`summary` is the title of the change and nothing else — one clause, a dozen words at most. It is",
  "not where the risk note goes, and a risk note put there is lost.",
].join("\n");

/**
 * What the run is about, as a person types it after `kojo run review`.
 *
 * The reminder rides along here as well as in the prompt file, because the rendered contract is
 * appended *after* the subject and is therefore the last thing the model reads. The task itself is
 * deliberately tiny — one line into one existing file — so that `diffMatchesClaims` has nothing to
 * argue with and the only thing that can refuse the answer is the field this design is about.
 */
export const riskSubject =
  "Add a second line saying goodbye to notes/hello.txt, and write the risk grade in the form this " +
  "repository uses — the grade, an em dash, and the reason";
