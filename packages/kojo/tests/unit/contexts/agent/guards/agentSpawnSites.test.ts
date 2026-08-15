import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "@effect/vitest";

/**
 * **Every place in this repository that can start an agent binary, enumerated by a check rather
 * than by a comment** — ticket 55.
 *
 * Ticket 49 made an unauthorised agent call structurally impossible *through
 * `SandcastleAgentInvoker`*. It did nothing about code that builds a command and spawns it itself,
 * and one file did exactly that: `kojoPiRealSession.test.ts` handed `buildPrintCommand`'s output
 * straight to `node:child_process`, so `KOJO_AGENT_SPEND` never saw it. An agent working ticket 52
 * reached a real `pi` twice through that hole — once probing, once by mutating the gate, which the
 * verification ladder *requires* — and both were refused by Anthropic for want of credit rather
 * than by anything in this repository.
 *
 * A list in a docstring would have been true on the day it was written. This is the same claim as a
 * test that keeps being asked.
 *
 * **The invariant.** Building a command is free; *spawning* is what costs. So a file is a spawn site
 * when it does both — **calls** `buildPrintCommand` and uses a child-process primitive. A *call*
 * rather than a mention: three files in this repository explain `buildPrintCommand` in prose while
 * spawning something else entirely (a `kojo` child, a `printf`), and a guard that fired on those
 * would be turned off within the week. `SandcastleAgentInvoker` calls it and spawns nothing itself —
 * it hands that to Sandcastle — so it is not a site either, and it is where ticket 49's half of this
 * rule already lives.
 *
 * What is left is **one** file, which is the shape this ticket was asking for.
 *
 * **What it does not cover, said plainly.** A file that hard-codes `pi` or `claude` as a command
 * without going through a provider is not caught here — nothing in this repository does that today,
 * and a check broad enough to catch it would fire on every test that writes a shell script named
 * `claude` onto a `PATH`. Those scripts are the *stand-ins*, and the run that reaches them goes
 * through the invoker, which is guarded. If that ever changes, this is the docstring that lied.
 */

const repositoryRoot = new URL("../../../../../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** Where source lives. `node_modules`, build output and worktrees are not this repository's code. */
const searched = [
  "packages/kojo/src",
  "packages/kojo/tests",
  "apps/console/src",
  "apps/console/tests",
];

const skipped = new Set(["node_modules", "dist", ".moon", "console"]);

const filesUnder = (directory: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      if (skipped.has(entry)) continue;
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(path)) out.push(path);
    }
  };
  walk(directory);
  return out;
};

/**
 * How a process gets started, in every spelling this repository could use.
 *
 * `Bun.spawn` and `execFile` are here even though nothing uses them for an agent today: the point of
 * a guard is the case nobody has written yet.
 */
const spawnPrimitives =
  /\bspawnSync\s*\(|\bspawn\s*\(|\bexecFileSync\s*\(|\bexecFile\s*\(|\bexecSync\s*\(|Bun\.spawn/;

/** The only file allowed to build an agent command and start a process. It asks `maySpawn` first. */
const allowed = new Set(["packages/kojo/tests/support/spawnAgent.ts"]);

/** A call, not a mention. See the invariant above for why the difference is the whole guard. */
const buildsAnAgentCommand = /\.buildPrintCommand\s*\(/;

/** This file names both halves of the pattern in order to describe them. */
const thisGuard = "packages/kojo/tests/unit/contexts/agent/guards/agentSpawnSites.test.ts";

const spawnSites = (): ReadonlyArray<string> =>
  searched
    .flatMap((directory) => filesUnder(join(repositoryRoot, directory)))
    .map((path) => ({ path, at: relative(repositoryRoot, path) }))
    .filter(({ path, at }) => {
      if (at === thisGuard) return false;
      const source = readFileSync(path, "utf-8");
      return buildsAnAgentCommand.test(source) && spawnPrimitives.test(source);
    })
    .map(({ at }) => at)
    .sort();

describe("everywhere an agent binary can be started", () => {
  it("is the guarded helper, and nowhere else", () => {
    expect(spawnSites()).toEqual([...allowed].sort());
  });

  /**
   * The guard has to be able to fail, and the way this one could quietly stop working is by
   * searching nothing — a wrong root, a renamed directory, a walk that throws and is swallowed.
   * So the search itself is asserted: it finds files, it finds the one file it is about, and it
   * finds the file this ticket was opened over.
   */
  it("actually searched this repository, rather than an empty tree", () => {
    const all = searched.flatMap((directory) => filesUnder(join(repositoryRoot, directory)));
    expect(all.length).toBeGreaterThan(100);

    const names = all.map((path) => relative(repositoryRoot, path));
    for (const file of allowed) expect(names).toContain(file);

    // And the file this ticket is about is searched, still exists, and is no longer a spawn site.
    expect(names).toContain(
      "packages/kojo/tests/integration/contexts/agent/adapters/kojoPiRealSession.test.ts",
    );
  });

  it("tells a call apart from a mention, which is what keeps it usable", () => {
    // The three files that would otherwise be flagged: each explains `buildPrintCommand` in prose
    // and spawns something that is not an agent.
    for (const mention of [
      "// `run()` calls buildPrintCommand and pipes the prompt to stdin",
      "buildPrintCommand: () => ({ command: 'printf %s \"$KOJO_RUN_ID\"' }),",
    ]) {
      expect(buildsAnAgentCommand.test(mention), mention).toBe(false);
    }

    for (const call of [
      "provider.buildPrintCommand({ prompt })",
      "full.buildPrintCommand (call())",
    ]) {
      expect(buildsAnAgentCommand.test(call), call).toBe(true);
    }
  });

  it("recognises a spawn in every spelling it claims to", () => {
    for (const source of [
      'spawnSync("sh", [])',
      'spawn("sh", [])',
      'execFileSync("git", [])',
      "execFile('git', [])",
      'execSync("ls")',
      'Bun.spawn(["ls"])',
    ]) {
      expect(spawnPrimitives.test(source), source).toBe(true);
    }

    // And does not fire on prose or on a name that merely contains one.
    for (const source of ["// this spawns nothing", "const respawned = 1", "spawnedAt: 3"]) {
      expect(spawnPrimitives.test(source), source).toBe(false);
    }
  });
});
