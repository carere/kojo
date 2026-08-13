// This file is Kojo's own.
//
// What every lane of Kojo's factory shares: who is asked, who is called, what an agent may touch,
// how dependencies are restored, and how a set of commands becomes half of an acceptance.
//
// It is a module rather than a workflow, and it lives in `workflows/lane/` for that reason: only the
// *top level* of `.kojo/workflows/` is a `kojo run` name, so anything nested here is a module the
// workflow imports and never a name a person can type.

import { Effect } from "effect";
import * as SandcastleAgentInvoker from "kojo/contexts/agent/adapters/SandcastleAgentInvoker";
import type { SandboxHooks } from "kojo/contexts/sandbox/models/SandboxHooks";
import { WorkspaceError } from "kojo/contexts/sandbox/models/WorkspaceError";
import { Workspace } from "kojo/contexts/sandbox/ports/Workspace";
import { Judgement } from "kojo/contexts/workflow/models/Acceptance";
import type { PermissionPolicy } from "kojo/contexts/workflow/models/PermissionPolicy";
import { factoryOwnPaths } from "kojo/contexts/workflow/models/PermissionPolicy";
import { code } from "kojo/contexts/workflow/services/phase/code";
import { commands } from "../../commands.ts";

/**
 * Who is asked at every gate in this factory.
 *
 * One name, because Kojo has one maintainer and a gate that names somebody who does not exist is a
 * gate nobody answers. The name reaches the asking, the queue and the trace.
 */
export const actor = "maintainer";

/**
 * Who actually gets called, and where.
 *
 * Provided **inside** each lane's sandbox scope, never at the top, because an agent runs in the
 * container the phase is standing in and the invoker therefore has to hold that container. The
 * roster is `.kojo/kojo.config.yaml`; it is decoded and every agent's prompt files are read while
 * this layer is built, so a typo in it fails naming the file before anything spawns.
 */
export const agents = SandcastleAgentInvoker.fromConfig({ config: ".kojo/kojo.config.yaml" });

/**
 * The paths no agent of this factory may change, whatever it was asked to do.
 *
 * `factoryOwnPaths` is Kojo's own list — the roster, the workflows, the envelopes, the checks, the
 * commands and the prompts. An agent that can edit those can edit its own grader, and in this
 * factory the mechanical half of every acceptance is `commands.ts`, so an unguarded agent can make
 * its own suite pass.
 *
 * The skill directory is added because this repository has one and a stamped repository has one:
 * `.claude/skills/kojo/` is what tells the *next* agent how to drive the factory. An agent that
 * rewrites those instructions has changed the behaviour of every run after it, and no diff review of
 * a feature branch would think to look there.
 */
const barred: ReadonlyArray<string> = [...factoryOwnPaths, ".claude/skills/kojo/"];

/**
 * What an agent that writes code may leave behind: anything the barred paths do not cover.
 *
 * `Unrestricted` is the right setting for the fixer, the builder and the tidier. In this repository
 * the product *is* the engine, so an agent on a feature is legitimately editing
 * `packages/kojo/src/` — a write scope narrow enough to be interesting would be a scope that refuses
 * the work.
 */
export const mayWriteCode = (who: string): PermissionPolicy => ({
  agent: who,
  writes: { _tag: "Unrestricted" },
  protectedPaths: barred,
  alwaysWritable: [],
});

/**
 * What an agent that is told to change no code may leave behind: notes, and nothing else.
 *
 * This is the strict reading of "you do not write the feature", and it is the difference between an
 * instruction and a boundary. The planner's prompt says it in words; this says it in code — the
 * change-set is fingerprinted around the call, a write outside `.scratch/` is undone, and the run
 * fails with a `PermissionBreach` naming every path and what became of it.
 *
 * `LimitedTo` with a trailing slash is a directory prefix rather than a glob, which is how the
 * matcher spells "this tree and everything in it". A bare `*` would stop at the first separator.
 */
export const mayWriteNotesOnly = (who: string): PermissionPolicy => ({
  agent: who,
  writes: { _tag: "LimitedTo", patterns: [".scratch/"] },
  protectedPaths: barred,
  alwaysWritable: [],
});

/**
 * The router changes nothing at all, and this is what makes that true rather than requested.
 *
 * Read-only is `LimitedTo` with no patterns. It is worth spending on a phase whose answer is one
 * word: the router runs before any lane exists, so a router that edited the repository would put a
 * change into every lane's starting state and no lane's diff review would attribute it.
 */
export const mayWriteNothing = (who: string): PermissionPolicy => ({
  agent: who,
  writes: { _tag: "LimitedTo", patterns: [] },
  protectedPaths: barred,
  alwaysWritable: [],
});

/**
 * Restore this repository's dependencies inside the run's own worktree.
 *
 * **A sandbox hook, and it was a phase until a dogfood run proved it could not be.** This is the
 * third and largest thing dogfooding found, and only a lane with a *mid-lane* gate could find it.
 *
 * A run works in a linked worktree cut from its own branch, `node_modules` is ignored, so the
 * worktree starts with none — and every command in `commands.ts` needs them. As a `code` phase that
 * worked perfectly on the way in, and then:
 *
 *  - the hotfix lane suspended at its in-lane `approve` gate,
 *  - the scope tore the worktree down, because a run waiting for a human holds nothing,
 *  - the answer arrived, the body replayed, and the `install` phase **replayed its recorded result
 *    instead of running** — which is exactly what a phase is for,
 *  - `verify` then ran `bun tsc --build` in a freshly rebuilt worktree with no `node_modules`, and
 *    reported a red typecheck about a change that was perfectly good.
 *
 * **Durability replays results, not effects on the environment.** Installing dependencies is the
 * second kind. So it cannot be a phase, whatever it costs to say so: a phase that must run again
 * after every suspension is a contradiction in terms.
 *
 * A hook runs on **every acquisition**, which is the property wanted, and the price is honest: a
 * hook leaves no phase row, so the install is no longer a bar in the waterfall. What it does leave is
 * inside the acquisition's own row — the sandbox's `acquiredAt`/`releasedAt` bracket the hook — so
 * the cost is still visible, just attributed to the container rather than to the work.
 *
 * **`host.onWorktreeReady` and not `sandbox.onSandboxReady`, because this factory runs `none`.**
 * Sandcastle runs only the host slot for a no-sandbox provider in worktree mode; the sandbox slot is
 * the container path. Changing `provider` to `docker` therefore means moving this hook, and that is
 * a real edge rather than a footnote — see `.kojo/README.md`.
 *
 * `--frozen-lockfile` is in `commands.ts` for a reason this hook depends on: a rewritten `bun.lock`
 * is an unclaimed change in the working tree, and `diffMatchesClaims` would correctly read it as the
 * agent having touched a file it did not report.
 */
export const restore: SandboxHooks = {
  host: {
    // Four minutes. A cold `bun install` on this repository is seconds; the budget is for a machine
    // that is busy, and a hook that is abandoned fails the acquisition rather than failing quietly.
    onWorktreeReady: [{ command: commands.install, timeoutMs: 240_000 }],
  },
};

/**
 * A commit message **this** repository's `commit-msg` hook accepts.
 *
 * **The first thing dogfooding found, and it stopped the first run dead.** Kojo enforces Conventional
 * Commits with Cocogitto on `commit-msg` (see `lefthook.yml`), and the `commit` phase puts the agent's
 * own `summary` on the commit verbatim — *"Agents propose, code disposes"* means the message is the
 * agent's. So the very first run refused at `commit-tidy` with `cog verify`'s own complaint:
 * `Missing commit type separator ':'`.
 *
 * The fix belongs **here and not in a prompt.** A convention a repository enforces mechanically must
 * be satisfied mechanically: an agent asked in prose to write a conventional subject fails the run the
 * one time in ten that it forgets, and the failure lands after the work is already done. So the lane
 * names the type — which is a real difference between the lanes, not a formality — and the agent still
 * owns every word of what it says it did.
 *
 * Three details each earn their line:
 *
 *  - **A summary that already reads as conventional is left alone.** An agent that writes
 *    `fix: …` should not be given `chore: fix: …`.
 *  - **The subject is the first line, and the whole summary becomes the body** whenever the two are
 *    not the same string. Nothing an agent said is dropped to make a header fit.
 *  - **A trailing full stop goes.** It is the one habit that makes a good subject line read wrongly,
 *    and the agents' prompts ask for a paragraph rather than for a subject.
 */
export const conventional = (type: string, summary: string): string => {
  const whole = summary.trim();
  const first = (whole.split("\n")[0] ?? "").trim();
  const already = /^[a-z]+(\([^)]*\))?!?: \S/.test(first);
  const subject = already ? first : `${type}: ${first.replace(/[.\s]+$/, "")}`;
  const capped = subject.length <= 100 ? subject : `${subject.slice(0, 99)}…`;
  return capped === whole ? capped : `${capped}\n\n${whole}`;
};

/** One named command a lane grades a change with. The name is what a refusal is reported under. */
export type Stage = readonly [name: string, command: string];

/**
 * Run a lane's own commands over what the agent wrote, and report one `Judgement`.
 *
 * **It does not fail when a command is red**, and that is the design rather than an oversight: the
 * phase did its job, a red check is an answer, and failing here would hide the result from the human
 * who has to decide what to do about it. The refusal travels as the mechanical half of the
 * acceptance, which is the single condition the merge hangs on.
 *
 * Every command goes through the `Workspace` port, so it runs where the agent wrote — in the
 * container on a container provider, in the worktree on this machine. A shell called directly here
 * would grade the repository the *command* was launched in, which is a different tree with different
 * work in it.
 *
 * The stages are a parameter because **this is the main way Kojo's lanes differ.** Each lane passes
 * the set of commands that actually grades the kind of change it exists for; a shared list here
 * would make the taxonomy decorative.
 */
export const graded = (options: {
  readonly name: string;
  readonly description: string;
  readonly stages: ReadonlyArray<Stage>;
}) =>
  code(
    {
      name: options.name,
      description: options.description,
      success: Judgement,
      error: WorkspaceError,
    },
    Effect.gen(function* () {
      const workspace = yield* Workspace;
      const refused: Array<string> = [];

      // Serial, and every stage runs even after one refuses. A reviewer deciding what to do about a
      // red typecheck is better served knowing whether the tests are red too.
      for (const [what, command] of options.stages) {
        const ran = yield* workspace.exec(["sh", "-c", command]);
        if (!ran.succeeded) {
          refused.push(
            `${what} exited ${ran.exitCode}: ${(ran.stderr || ran.stdout).trim().slice(-300)}`,
          );
        }
      }

      const by = options.stages.map(([what]) => what).join(", ");
      return new Judgement({
        by,
        accepted: refused.length === 0,
        reason: refused.length === 0 ? `${by} all came back clean` : refused.join(" · "),
      });
    }),
  );

/**
 * What every lane hands back to the workflow that chose it.
 *
 * Three fields and no more, because the parent must not be able to tell the lanes apart: it asks one
 * human, builds one acceptance and performs one merge, whichever lane ran. Anything a lane knows
 * that the parent needs is on this record; anything else is the lane's own business.
 */
export interface Judged {
  /** Which lane ran. Carried so the review asking and the run's own answer can name it. */
  readonly lane: string;
  /** The last writing agent's own summary of the work. */
  readonly summary: string;
  /** What this lane's commands measured. Half of the acceptance the merge hangs on. */
  readonly mechanical: Judgement;
}
