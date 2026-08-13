// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every `${…}` below belongs to the
// TypeScript this file *writes into a target repository*, not to the TypeScript it is. Making these
// template literals would interpolate this test's variables into a workflow that has its own.

import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { git, kojo, type Ran, throwawayRepo } from "../../support/throwawayRepo.ts";
import { runIdOf, tokenOf, traceOf } from "../../support/traceOf.ts";

/**
 * **Criterion 2 of ticket 15, and it costs nothing.**
 *
 * *The factory's test, lint and build commands are its own, invoked through the workspace.*
 *
 * Nothing about that claim needs a model, so nothing here spends one. What it needs is a repository
 * with a **finished** `.kojo/commands.ts` — three commands the target owns rather than the
 * placeholders `kojo init` stamps — and a phase that runs them where the work is rather than where
 * the process is. Both are here: the commands are shell scripts committed in the repository, and the
 * phase runs them through the `Workspace` port inside a `sandboxed` scope, which is a worktree on
 * another branch and not the directory the command was launched from.
 *
 * The `verify` body below is the one `templates/review.ts` stamps, kept in step by hand. The
 * division of labour across this ticket's tests: `stampedFactory.test.ts` proves the stamped file
 * compiles and loads, this proves the shape of the claim — three commands, the factory's own,
 * through the port, red when one of them is red, refusing while one is still a placeholder — and
 * `realAgent.test.ts` is where a model was actually paid for.
 *
 * **The judgement travels on the gate's question.** `kojo run` prints where a run stopped, never
 * what it returned, so the one channel a phase's decision survives on is the trace — and the gate
 * record keeps its description verbatim. That is also how the real run graded the same thing.
 */

const succeeded = (ran: Ran): string => {
  if (ran.status !== 0) {
    throw new Error(`kojo exited ${ran.status}\nstdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`);
  }
  return ran.stdout;
};

const measureWorkflow = [
  'import { Duration, Effect, Schema } from "effect";',
  'import { GateExpired } from "kojo/contexts/gate/models/GateExpired";',
  'import { GateUnreachable } from "kojo/contexts/gate/models/GateUnreachable";',
  'import * as OnExpiry from "kojo/contexts/gate/models/OnExpiry";',
  'import { noSandbox } from "kojo/contexts/sandbox/adapters/providers";',
  'import { SandboxError } from "kojo/contexts/sandbox/models/SandboxError";',
  'import { WorkspaceError } from "kojo/contexts/sandbox/models/WorkspaceError";',
  'import { WorkspaceUnreachable } from "kojo/contexts/sandbox/models/WorkspaceUnreachable";',
  'import { WorktreeUnusable } from "kojo/contexts/sandbox/models/WorktreeUnusable";',
  'import { Workspace } from "kojo/contexts/sandbox/ports/Workspace";',
  'import { Judgement } from "kojo/contexts/workflow/models/Acceptance";',
  'import { code } from "kojo/contexts/workflow/services/phase/code";',
  'import { gate } from "kojo/contexts/workflow/services/phase/gate";',
  'import { sandboxed } from "kojo/contexts/workflow/services/sandboxed";',
  'import { workflow } from "kojo/contexts/workflow/services/workflow";',
  'import { commands } from "../commands.ts";',
  "",
  "export const measure = workflow(",
  "  {",
  '    name: "measure",',
  "    payload: { subject: Schema.String },",
  "    success: Schema.String,",
  "    error: Schema.Union([",
  "      GateExpired,",
  "      GateUnreachable,",
  "      SandboxError,",
  "      WorkspaceError,",
  "      WorkspaceUnreachable,",
  "      WorktreeUnusable,",
  "    ]),",
  "    idempotencyKey: (payload) => `measure/${payload.subject}`,",
  "  },",
  "  (payload) =>",
  "    sandboxed(",
  '      { name: "measure", branch: `kojo/measure/${payload.subject}`, provider: noSandbox() },',
  "      Effect.gen(function* () {",
  "        const judged = yield* code(",
  "          {",
  '            name: "verify",',
  '            description: "Run this factory\'s own test, lint and build",',
  "            success: Judgement,",
  "            error: WorkspaceError,",
  "          },",
  "          Effect.gen(function* () {",
  "            const workspace = yield* Workspace;",
  "            const stages = [",
  '              ["test", commands.test],',
  '              ["lint", commands.lint],',
  '              ["build", commands.build],',
  "            ] as const;",
  "",
  "            const refused: Array<string> = [];",
  "            const said: Array<string> = [];",
  "            for (const [what, command] of stages) {",
  '              const result = yield* workspace.exec(["sh", "-c", command]);',
  "              said.push(`${what}=${result.stdout.trim()}`);",
  "              if (!result.succeeded) {",
  "                refused.push(",
  "                  `${what} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(-300)}`,",
  "                );",
  "              }",
  "            }",
  "",
  "            return new Judgement({",
  '              by: "test, lint and build",',
  "              accepted: refused.length === 0,",
  "              reason:",
  "                refused.length === 0",
  '                  ? `test, lint and build all came back clean [${said.join(" ")}]`',
  '                  : refused.join(" · "),',
  "            });",
  "          }),",
  "        );",
  "",
  "        // The judgement and the tree it was measured in, on the one channel a later process can",
  "        // read back: the gate's own question, which the trace keeps verbatim.",
  "        const workspace = yield* Workspace;",
  "        yield* gate({",
  '          name: "sign",',
  '          description: `${judged.accepted ? "green" : "red"} | ${judged.reason} | in ${workspace.root}`,',
  '          actor: "engineer",',
  '          choices: ["approve"],',
  "          deadline: Duration.days(1),",
  "          onExpiry: OnExpiry.fail(),",
  "        });",
  "",
  "        return judged.reason;",
  "      }),",
  "    ),",
  ");",
  "",
].join("\n");

const inThrowaway = <A, E>(
  use: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* throwawayRepo({ model: "sonnet" });
    yield* fileSystem
      .writeFileString(path.join(repo.root, ".kojo", "workflows", "measure.ts"), measureWorkflow)
      .pipe(Effect.orDie);
    return yield* use(repo.root);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/** Run `measure`, answer its gate, and give back the question it asked. */
const measured = (
  root: string,
  subject: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const started = succeeded(yield* kojo(root, ["run", "measure", subject]));
    const runId = runIdOf(started);
    // `verify  measure  code  ok  …`. The optional group is the LANE column ticket 35 added between
    // PHASE and KIND, printed only when a phase of the run ran in a container — which this one did,
    // so it is present here. Written to read both shapes for the same reason
    // `stampedRun.test.ts`'s `agentPhaseRow` is: what this grades is that the factory's own commands
    // ran as a `code` phase and came back `ok`, not how many columns sit between the two words.
    expect(started).toMatch(/^verify\s+(\S+\s+)?code\s+ok\s/m);
    expect(started).toContain('suspended at gate "sign"');

    const listing = succeeded(yield* kojo(root, ["gate", "list"]));
    succeeded(
      yield* kojo(root, [
        "gate",
        "answer",
        tokenOf(listing, runId),
        "--choice",
        "approve",
        "--as",
        "tester",
      ]),
    );

    const document = yield* traceOf(root, runId);
    return document.gates[0]?.description ?? "";
  });

describe("a factory's own test, lint and build", () => {
  it.live("runs all three, through the workspace, in the worktree the scope cut", () =>
    inThrowaway((root) =>
      Effect.gen(function* () {
        const question = yield* measured(root, "green");

        // **All three ran, and each one said its own thing.** The three markers come out of the
        // three scripts committed in this repository, so a phase that ran only `test` — or that ran
        // a plausible guess like `npm test` — cannot produce this line.
        expect(question).toContain("test=notes ok");
        expect(question).toContain("lint=lint ok");
        expect(question).toContain("build=build ok");
        expect(question).toContain("green | test, lint and build all came back clean");

        // **Through the workspace, which is the worktree the sandbox scope cut** — not the directory
        // `kojo run` was launched in. Reading the host tree instead would grade a tree nobody
        // touched the moment a container is involved.
        expect(question).toContain(".sandcastle/worktrees/kojo-measure-green");
      }),
    ),
  );

  /**
   * The judgement can go **red**, and it names which command did.
   *
   * A mechanical half of an acceptance that cannot fail is not a measurement. The tab below breaks
   * the repository's own linter's own rule, on a commit the run's branch forks from.
   */
  it.live("goes red and names the command, when one of the factory's commands fails", () =>
    inThrowaway((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem
          .writeFileString(path.join(root, "notes", "tabbed.txt"), "a\tb\n")
          .pipe(Effect.orDie);
        yield* Effect.sync(() => {
          git(root, ["add", "--all"]);
          git(root, ["commit", "--quiet", "--message", "a note with a tab in it"]);
        });

        const question = yield* measured(root, "red");

        expect(question).toContain("red | lint exited 1");
        expect(question).toContain("tabs are not allowed in notes");
        expect(question).not.toContain("all came back clean");
      }),
    ),
  );

  /**
   * **And a factory whose commands are still placeholders refuses, loudly.**
   *
   * This is the other half of edge 6, and the reason `throwawayRepo` finishes `commands.ts` before
   * it commits: a freshly stamped factory cannot produce an accepted run, on purpose. The
   * placeholder prints its own marker and exits 78, so the mechanical half of every acceptance says
   * no — and says which file to edit.
   */
  it.live("refuses, by marker, while a command is still the placeholder kojo init stamped", () =>
    inThrowaway((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const commands = path.join(root, ".kojo", "commands.ts");
        const finished = yield* fileSystem.readFileString(commands).pipe(Effect.orDie);
        yield* fileSystem
          .writeFileString(
            commands,
            finished.replace(
              '"sh scripts/lint.sh"',
              JSON.stringify(
                "sh -c 'echo \"KOJO-PLACEHOLDER: no lint command yet - write the real one in " +
                  ".kojo/commands.ts\" >&2; exit 78'",
              ),
            ),
          )
          .pipe(Effect.orDie);
        yield* Effect.sync(() => {
          git(root, ["add", "--all"]);
          git(root, ["commit", "--quiet", "--message", "put the lint placeholder back"]);
        });

        const question = yield* measured(root, "unfinished");

        expect(question).toContain("red | lint exited 78");
        expect(question).toContain("KOJO-PLACEHOLDER");
        expect(question).toContain(".kojo/commands.ts");
        expect(question).not.toContain("all came back clean");
      }),
    ),
  );
});
