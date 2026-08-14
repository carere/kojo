import { execFileSync } from "node:child_process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { decodeUnknown } from "../../../src/contexts/shared/lib/decode.ts";
import { EnvelopeBase } from "../../../src/contexts/workflow/models/Envelope.ts";
import { EnvelopeParseError } from "../../../src/contexts/workflow/models/EnvelopeParseError.ts";
import { correctionFor } from "../../../src/contexts/workflow/services/corrections.ts";
import { riskField, riskNoteRule, riskSubject, riskWords } from "../../support/riskNote.ts";
import { kojo, type Ran, throwawayRepo } from "../../support/throwawayRepo.ts";
import { phaseOf, runIdOf, tokenOf, traceOf } from "../../support/traceOf.ts";

/**
 * **The rehearsal for tickets 48 and 51, and the boundary it cannot cross.**
 *
 * Real money buys one thing here: a real model's answer failing to decode, and the repair that fixes
 * it. So everything about that run which a script can settle is settled first — the envelope, the
 * prompt, the check, the phase record, the trace, the correction the loop builds **and its delivery
 * into a second turn** — and the calls are spent only on the model's judgement. See
 * `tests/support/riskNote.ts` for the design and `tests/integration/cli/realAgent.test.ts` for what
 * the money bought.
 *
 * **Where the boundary really runs, corrected by ticket 51.** A repair re-enters the captured
 * provider session, and Sandcastle checks that session exists before it spawns anything: on a `none`
 * sandbox `assertResumeSessionExists` calls `findByIdOnHost`, which looks for `<id>.jsonl` under
 * `$HOME/.claude/projects` of the asking process, and throws `resumeSession "…" not found under …`
 * when nothing is there. Ticket 48 read that as *a stand-in can never move the `corrections`
 * counter*, and the second test below still pins it — for an agent that leaves no transcript, which
 * is every scripted agent that is not handed one.
 *
 * It is a precheck for a **file**, though, not for a conversation. The third test gives the child a
 * `HOME` of its own and lets the script write that one file into it, and the repair is then really
 * spawned and really handed Kojo's correction on stdin. So the line is one step further along than
 * ticket 48 thought: a script can be *given* a correction, and what it can never do is **read** one
 * — its repair is decided before the run starts. That last step is the only thing real money buys.
 */

/**
 * POSIX single-quoting, with the close-reopen trick.
 *
 * The script below is handed to `sh -c` by the fixture that writes it, and the envelope inside it is
 * JSON full of quotes. Quoting it by hand is how a fixture ends up asserting against a shell mistake.
 */
const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/** What the drafter claims, and — for `files` — what the script below really changes. */
const summary = "add a goodbye line to the notes";
const changed = "notes/hello.txt";

/**
 * The answer the design expects, and the shape the money was lost on.
 *
 * A sentence in the field that takes three words. It is the paid repair's shape as well as the paid
 * cold turn's — ticket 48's model answered the right word with an explanation stapled to it — so
 * every rehearsal below that wants a refusal uses this one string.
 */
const sentenceInRisk = "low — it only appends one line to a notes file";

/** One `result` line, carrying a whole `Drafted` whose `risk` is whatever the turn decided. */
const answers = (risk: string): string =>
  JSON.stringify({
    type: "result",
    result: JSON.stringify({ _tag: "Drafted", summary, files: [changed], risk }),
  });

/**
 * A `claude` that is a shell script, answering with the envelope its `risk` argument decides.
 *
 * The stamped `review` wires the stock Claude Code provider, so the binary the run reaches for is
 * `claude` on the child's `PATH`. A script there makes this the *whole* run at no cost:
 * `buildPrintCommand` is real, the prompt arrives on stdin, the process runs in the worktree the
 * sandbox scope cut, and `parseStreamJsonLine` reads these two lines exactly as it reads a model's.
 *
 * Both lines are load-bearing. The `system`/`init` line carries the session id — an answer with no
 * session is refused as `provider-failed`, because the transcript is named after the id and there is
 * no second chance to learn it. The `result` line carries the envelope, which `envelopeBlock` narrows
 * and the phase decodes.
 *
 * The prompt is appended to a log **file** rather than echoed, because the invoker narrows stdout to
 * the envelope: a prompt on stdout would be narrowed away and the JSON Schema inside it would come
 * back as the answer.
 */
const fakeClaude = (options: {
  readonly log: string;
  readonly risk: string;
  /**
   * What a **resumed** turn answers, and the transcript that lets one happen at all.
   *
   * Absent, the script answers the same thing every time and a repair never gets as far as a spawn
   * — which is the boundary the second test pins. Present, the script writes `transcript` on the
   * cold turn, so Sandcastle's resume precheck finds a session under the child's own `HOME` and the
   * correction is really handed to a process on stdin. What that buys is the *delivery* of the
   * correction, never a model's reading of it: the file is one line of JSON and nothing re-reads
   * the conversation, so the repair's answer is the script's, decided in advance.
   */
  readonly resumed?: { readonly risk: string; readonly transcript: string } | undefined;
}): string =>
  [
    "#!/bin/sh",
    // Drain stdin. A provider that leaves it unread gives the writer a broken pipe.
    "prompt=$(cat)",
    `printf '%s' "$prompt" >> ${quote(options.log)}`,
    `printf 'PROMPT-END\\n' >> ${quote(options.log)}`,
    // The work the envelope claims, because `diffMatchesClaims` goes and looks.
    `printf 'goodbye\\n' >> ${quote(changed)}`,
    `printf '%s\\n' ${quote(JSON.stringify({ type: "system", subtype: "init", session_id: "scripted-cold" }))}`,
    ...(options.resumed === undefined
      ? [`printf '%s\\n' ${quote(answers(options.risk))}`]
      : [
          // `--resume <id>` is what the stock Claude Code provider puts on the command line for a
          // second turn, so the argument list is what tells a cold call from a repair — the same
          // signal a real `claude` reads.
          `mkdir -p ${quote(pathOf(options.resumed.transcript))}`,
          `printf '%s\\n' ${quote(JSON.stringify({ sessionId: "scripted-cold" }))} > ${quote(options.resumed.transcript)}`,
          'case " $* " in',
          `  *" --resume "*) printf '%s\\n' ${quote(answers(options.resumed.risk))} ;;`,
          `  *) printf '%s\\n' ${quote(answers(options.risk))} ;;`,
          "esac",
        ]),
    "",
  ].join("\n");

/** The directory a path is in, for the `mkdir -p` above. */
const pathOf = (file: string): string => file.slice(0, file.lastIndexOf("/"));

interface Rehearsal {
  readonly root: string;
  /** The child's `PATH`, with the scripted `claude` in front of the operator's own. */
  readonly path: string;
  /**
   * What the child may spawn, declared as the **file** rather than as a `PATH`.
   *
   * A `PATH` in front of the operator's own binary is what this rehearsal has always used, and it is
   * not a guarantee: twice in this build a child resolved the real `claude` anyway and spent money
   * nobody authorised. `stand-in:<absolute path>` is checked by the invoker — it resolves `claude`
   * itself and refuses unless it opens this exact file — so the rehearsal now *proves* what it used
   * to assume. Ticket 49.
   */
  readonly spend: string;
  /**
   * A home of the child's own, so no rehearsal reads or writes the operator's `~/.claude`.
   *
   * Sandcastle resolves a `resumeSession` under `$HOME/.claude/projects` of the process that asks,
   * so this is both halves of one decision: a rehearsal that wants a repair delivered writes a
   * transcript in here, and a rehearsal that does not must not be able to find one the operator's
   * own machine happens to hold.
   */
  readonly home: string;
  /** Every prompt the scripted agent was handed, in order. */
  readonly prompts: Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem>;
}

/**
 * The throwaway factory of `realAgent.test.ts`, with a script where the model goes.
 *
 * The envelope and the prompt are the real design's, imported rather than restated: a rehearsal of a
 * different envelope would prove nothing about the run that is paid for.
 *
 * The scripted binary and the prompt log live **outside** the repository. Untracked files at the root
 * of a target repository are something the merge refuses by design, so a fixture that put its own
 * scratch there could manufacture the very fault this tier exists to find.
 */
const rehearsal = <A, E>(
  answer: {
    /** What the cold turn puts in the narrow field. */
    readonly risk: string;
    /** What a resumed turn puts there, when this rehearsal wants the repair delivered at all. */
    readonly repairsWith?: string | undefined;
  },
  use: (fixture: Rehearsal) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const repo = yield* throwawayRepo({
      model: "sonnet",
      insist: riskNoteRule,
      alsoInEnvelope: riskField,
    });

    const outside = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "kojo-scripted-agent-" })
      .pipe(Effect.orDie);
    const log = path.join(outside, "prompts.log");
    const binary = path.join(outside, "claude");
    const home = path.join(outside, "home");
    const transcript = path.join(home, ".claude", "projects", "scripted", "scripted-cold.jsonl");
    yield* fileSystem.makeDirectory(home, { recursive: true }).pipe(Effect.orDie);
    yield* fileSystem
      .writeFileString(
        binary,
        fakeClaude({
          log,
          risk: answer.risk,
          ...(answer.repairsWith === undefined
            ? {}
            : { resumed: { risk: answer.repairsWith, transcript } }),
        }),
      )
      .pipe(Effect.orDie);
    yield* Effect.sync(() => {
      execFileSync("chmod", ["+x", binary]);
    });

    return yield* use({
      root: repo.root,
      // `/usr/bin:/bin` still carries `git` and `sh`, which the sandbox scope needs.
      path: `${outside}:/usr/bin:/bin:/usr/sbin:/sbin`,
      spend: `stand-in:${binary}`,
      home,
      prompts: Effect.gen(function* () {
        const text = yield* fileSystem.readFileString(log).pipe(Effect.orElseSucceed(() => ""));
        return text.split("PROMPT-END\n").filter((entry) => entry.trim() !== "");
      }),
    });
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const succeeded = (ran: Ran): string => {
  if (ran.status !== 0) {
    throw new Error(`kojo exited ${ran.status}\nstdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`);
  }
  return ran.stdout;
};

/** A whole run, scripted or not, is minutes rather than the tier's thirty seconds. */
const budget = 5 * 60 * 1000;

describe("the correction loop, rehearsed against a scripted agent", () => {
  /**
   * **The pre-flight: the factory the real calls will run is sound before one is spent.**
   *
   * Same repository, same envelope with the narrow field, same prompt rule, same subject — and an
   * answer that fits the envelope. If this is green, then a real run that fails does so because of
   * the model's answer, which is the only thing the budget is for. `corrections: 0` is what an answer
   * that decoded first time reads, and it is the row the real run has to differ from.
   */
  it.live(
    "drives the stamped factory to its gate when the scripted answer fits the envelope",
    () =>
      rehearsal({ risk: riskWords[0] }, (fixture) =>
        Effect.gen(function* () {
          const started = succeeded(
            yield* kojo(fixture.root, ["run", "review", riskSubject], {
              path: fixture.path,
              spend: fixture.spend,
              home: fixture.home,
            }),
          );
          const runId = runIdOf(started);

          expect(started).toMatch(/^draft\s+(\S+\s+)?agent\s+ok\s/m);
          expect(started).toMatch(/^verify\s+(\S+\s+)?code\s+ok\s/m);
          expect(started).toContain('suspended at gate "approve"');

          // The design really reached the agent: the factory's rule, and the contract that
          // contradicts it, were both in the one prompt the process was handed.
          const [cold = ""] = yield* fixture.prompts;
          expect(cold).toContain("A single bare word is not a risk note.");
          expect(cold).toContain('"enum"');
          for (const word of riskWords) expect(cold).toContain(`"${word}"`);

          const document = yield* traceOf(fixture.root, runId);
          const draft = phaseOf(document, "draft");
          expect(draft?.outcome).toBe("succeeded");
          expect(draft?.verification?.envelope).toBe("Drafted");
          expect(draft?.verification?.ran).toContain("diffMatchesClaims");
          expect(draft?.verification?.failed).toEqual([]);
          // An answer that decoded first time. The real run's claim is this row reading 1.
          expect(draft?.verification?.corrections).toBe(0);
          expect(draft?.verification?.correctable).toBe(true);
          expect(draft?.agent?.resumed).toBe(false);

          /**
           * **And the half after the gate, which is the other way two calls can be wasted.**
           *
           * The real run asserts it lands. That half has never been seen with a real agent — ticket
           * 15's run died before it — and it depends on things that have nothing to do with a model:
           * the worktree surviving the suspension, the rebuild accepting it, and the trunk this
           * fixture's `git init` chose being the `main` the stamped workflow merges into. All three
           * are rehearsed here, for nothing, before a call is spent on them.
           */
          const listing = succeeded(
            yield* kojo(fixture.root, ["gate", "list"], {
              path: fixture.path,
              spend: fixture.spend,
              home: fixture.home,
            }),
          );
          const answered = succeeded(
            yield* kojo(
              fixture.root,
              [
                "gate",
                "answer",
                tokenOf(listing, runId),
                "--choice",
                "approve",
                "--as",
                "rehearsal",
              ],
              { path: fixture.path, spend: fixture.spend, home: fixture.home },
            ),
          );
          expect(answered).toContain(`recorded approve on run ${runId}`);
          expect(answered).toContain("run succeeded");
          // A resumed run prints only what it re-ran, and the agent phase is replayed from its record.
          expect(answered).not.toMatch(/^draft\s+(\S+\s+)?agent/m);
          expect(yield* fixture.prompts).toHaveLength(1);
        }),
      ),
    budget,
  );

  /**
   * **The boundary: a stand-in gets one turn, and the counter needs two.**
   *
   * The scripted answer is a sentence in `risk`, which is exactly what the design expects a real
   * model to write. Everything up to the repair is real and works: the answer is narrowed, the
   * decoder refuses it, `EnvelopeParseError` carries the issue tree, and `withCorrections` turns that
   * into the next prompt and asks the invoker to send it into the same session.
   *
   * And there it stops, because the session belongs to a script that wrote no transcript — under the
   * child's own `HOME`, so the operator's real `~/.claude/projects` cannot supply one by accident.
   * The failure is Sandcastle's resume precheck, by name.
   *
   * **What this pins is that a stand-in must be *given* a session before a repair can be delivered
   * to it**, which is why ticket 48 could buy nothing here. The test below it is the variant that
   * gives it one, and the two together say exactly what a script can and cannot stand in for: it can
   * receive a correction, and it can never *read* one.
   */
  it.live(
    "spends its correction on a sentence in the narrow field, and stops at the resume precheck",
    () =>
      rehearsal({ risk: sentenceInRisk }, (fixture) =>
        Effect.gen(function* () {
          const ran = yield* kojo(fixture.root, ["run", "review", riskSubject], {
            path: fixture.path,
            spend: fixture.spend,
            home: fixture.home,
          });

          expect(ran.status).not.toBe(0);
          // The repair was attempted, and it was attempted as a *resumed* turn.
          expect(ran.stderr).toContain("resumeSession");
          expect(ran.stderr).toContain("not found");

          // One prompt reached the process: the cold turn. The correction never got as far as a
          // spawn, so a stand-in cannot even be *shown* the repair, let alone answer it.
          expect(yield* fixture.prompts).toHaveLength(1);

          const document = yield* traceOf(fixture.root, runIdOf(ran.stdout));
          const draft = phaseOf(document, "draft");
          expect(draft?.outcome).toBe("failed");
          // The loop spent its turn — the row says so — and then the provider refused to re-enter.
          expect(draft?.verification?.corrections).toBe(1);
          expect(draft?.verification?.correctable).toBe(true);
          expect(draft?.errorTag).toBe("AgentInvocationError");
          // Nothing after `draft` ran.
          expect(document.phases.map((record) => record.name)).toEqual(["draft"]);
        }),
      ),
    budget,
  );

  /**
   * **The rehearsal ticket 51 exists for: the correction Kojo now writes, delivered to an agent.**
   *
   * Ticket 48 paid two calls and lost them to one sentence Kojo never said — `correctionFor`
   * reported the *type* of the narrow field and never said the whole value must **equal** one of the
   * three words. Before that remedy is bought with more money, the thing it must do has to be seen
   * happening for free: the repair prompt has to be **handed to a process**, with the new clause in
   * it, and the run has to finish on the repaired answer with `corrections: 1` on the phase row.
   *
   * **What makes it possible, and the honest size of it.** The stand-in writes the one thing
   * Sandcastle's resume precheck looks for — a `<session>.jsonl` under `$HOME/.claude/projects` —
   * into the temporary home this fixture gives the child. The precheck then passes and the second
   * turn really is spawned, with `--resume` on its command line and the correction on its stdin. So
   * what is graded here is **delivery**: the prompt Kojo builds, the session it re-enters, the
   * counter it writes, and the whole run around them. What no script can stand in for is the only
   * thing left — a model *reading* the correction and answering differently because of it. The
   * script's repair is decided in advance, and that is what `realAgent.test.ts` spends money on.
   */
  it.live(
    "hands the repair prompt to the agent, with the rule a literal field is refused for",
    () =>
      rehearsal({ risk: sentenceInRisk, repairsWith: riskWords[0] }, (fixture) =>
        Effect.gen(function* () {
          const started = succeeded(
            yield* kojo(fixture.root, ["run", "review", riskSubject], {
              path: fixture.path,
              spend: fixture.spend,
              home: fixture.home,
            }),
          );
          const runId = runIdOf(started);

          expect(started).toMatch(/^draft\s+(\S+\s+)?agent\s+ok\s/m);
          expect(started).toContain('suspended at gate "approve"');

          const [cold = "", repair = ""] = yield* fixture.prompts;
          // Two prompts, one conversation: the cold turn and the correction.
          expect(yield* fixture.prompts).toHaveLength(2);

          /**
           * **The correction reached the agent, and it carries the sentence ticket 51 added.**
           *
           * The field, the words, and — the new half — that the value must be exactly one of them
           * with nothing around it. Asserted on the text the *process* was handed rather than on
           * `correctionFor`'s return value, because the gap between those two is where a correction
           * can be built perfectly and sent nowhere.
           */
          expect(repair).toContain("was not a valid `Drafted`");
          expect(repair).toContain('risk: Expected "low" | "medium" | "high"');
          expect(repair).toContain("The whole value must be exactly one of those words");
          expect(repair).toContain("no dash, no sentence, no explanation wrapped around it");
          expect(repair).toContain('Write it as exactly\n  "low", "medium" or "high";');
          // A repair is one more message, not a cold start: the identity and the contract that
          // caused the disagreement are not re-sent.
          expect(cold).toContain("A single bare word is not a risk note.");
          expect(repair).not.toContain("A single bare word is not a risk note.");
          expect(repair).not.toContain('"enum"');

          const document = yield* traceOf(fixture.root, runId);
          const draft = phaseOf(document, "draft");
          expect(draft?.outcome).toBe("succeeded");
          expect(draft?.verification?.envelope).toBe("Drafted");
          // **The row the whole ticket is about**, moved by a delivered repair rather than by a
          // model's judgement — which is what makes a paid run that reads the same row a claim
          // about the model and about nothing else.
          expect(draft?.verification?.corrections).toBe(1);
          expect(draft?.verification?.correctable).toBe(true);
          expect(draft?.agent?.resumed).toBe(true);
          expect(draft?.verification?.failed).toEqual([]);

          // And the repaired run goes on to land, exactly as the paid one is asked to.
          const listing = succeeded(
            yield* kojo(fixture.root, ["gate", "list"], {
              path: fixture.path,
              spend: fixture.spend,
              home: fixture.home,
            }),
          );
          const answered = succeeded(
            yield* kojo(
              fixture.root,
              [
                "gate",
                "answer",
                tokenOf(listing, runId),
                "--choice",
                "approve",
                "--as",
                "rehearsal",
              ],
              { path: fixture.path, spend: fixture.spend, home: fixture.home },
            ),
          );
          expect(answered).toContain("run succeeded");
          // The replay called no agent: still two prompts, both from the first process.
          expect(yield* fixture.prompts).toHaveLength(2);
        }),
      ),
    budget,
  );
});

/**
 * The throwaway factory's envelope, declared here so the decode under test is the real one.
 *
 * Built from `riskWords`, which is also what `riskField` is built from, so the schema this asserts
 * against and the schema the target repository holds cannot say different things.
 */
class Drafted extends EnvelopeBase.extend<Drafted>("Drafted")({
  _tag: Schema.tag("Drafted"),
  summary: Schema.String,
  files: Schema.Array(Schema.String),
  risk: Schema.Literals(riskWords),
}) {}

/**
 * **The design proof, and it costs nothing.**
 *
 * It sits beside the rehearsal rather than in the unit tier because it is the first paragraph of the
 * same argument: *this* prose, in *this* field, fails to decode, and the correction the loop builds
 * from the failure names the field and the words it wanted. Everything the real calls are then asked
 * for is the model's willingness to write the sentence the factory asked for.
 */
describe("the designed decode failure", () => {
  const prose = JSON.stringify({
    _tag: "Drafted",
    summary,
    files: [changed],
    risk: sentenceInRisk,
  });

  it.effect("refuses a sentence in the narrow field, naming the field and its three words", () =>
    Effect.gen(function* () {
      const outcome = yield* decodeUnknown(Schema.fromJsonString(Drafted))(prose).pipe(
        Effect.flip,
        Effect.map((error) =>
          EnvelopeParseError.fromSchemaError(
            { agent: "drafter", expected: "Drafted", raw: prose },
            error,
          ),
        ),
      );

      expect(outcome.issues.map((issue) => issue.path)).toEqual([["risk"]]);
      expect(outcome.issues[0]?.message).toBe('Expected "low" | "medium" | "high"');
      // The rest of the answer was fine, which is what makes the field the whole of the complaint.
      expect(outcome.raw).toBe(prose);

      const correction = correctionFor(outcome);
      expect(correction).toContain("was not a valid `Drafted`");
      expect(correction).toContain('risk: Expected "low" | "medium" | "high"');
      expect(correction).toContain("Answer again with the whole `Drafted`");
      // And the sentence ticket 51 added, which is what the paid repair was never told: the answer
      // above misses valid by exactly this rule, and by nothing else in the envelope.
      expect(correction).toContain("The whole value must be exactly one of those words");
      expect(correction).toContain('Write it as exactly\n  "low", "medium" or "high";');

      // And the field the correction names is the field the target repository really holds.
      expect(riskField).toContain("risk: Schema.Literals(");
    }),
  );
});
