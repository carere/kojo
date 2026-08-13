import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  authoring,
  skill,
  skillsDirectory,
} from "../../../src/contexts/scaffold/templates/skills.ts";
import { loadWorkflow } from "../../../src/contexts/workflow/services/factoryWorkflows.ts";

/**
 * **Kojo's own factory, graded the way a stamped one is.**
 *
 * `stampedFactory.test.ts` asks whether what `kojo init` writes is a program. This asks the same of
 * what was written **by hand**, in this repository, and it exists because nothing else can: the
 * factory is not part of `bun tsc --build` — see the note in `.kojo/tsconfig.json` for why a
 * composite reference cannot express a directory that resolves the engine through `node_modules` —
 * and a factory nothing typechecks is a factory that breaks the day a signature moves.
 *
 * Three questions, and they fail for different reasons:
 *
 *  - **does it typecheck**, under the same strict options a target repository has. Catches a call
 *    that no longer types: an envelope in the wrong position, a check whose requirement the sandbox
 *    does not provide, an error union missing a member the body can raise.
 *  - **does it load**, under Bun, through the real loader. Catches what a typechecker cannot — a
 *    specifier that does not resolve at run time, a `workflow()` that throws while the module is
 *    being evaluated, a declared name that is not the file name.
 *  - **do the lanes actually differ.** That is ticket 36's second criterion, and sameness across
 *    lanes would mean the taxonomy was never needed.
 */

/** The repository root: five levels up from this file's own directory. */
const repositoryRoot = new URL("../../../../../", import.meta.url).pathname.replace(/\/$/, "");
const typescript = `${repositoryRoot}/node_modules/.bin/tsc`;

const laneSource = (lane: string): string =>
  readFileSync(`${repositoryRoot}/.kojo/workflows/lane/${lane}.ts`, "utf8");

/**
 * The taxonomy, read out of `.kojo/envelopes.ts` as text.
 *
 * **Read rather than imported, and the reason is a measurement.** `packages/kojo/tsconfig.json` is a
 * composite project rooted at this package, so a test that imported `../../../../../.kojo/` failed
 * `bun tsc --build` twice over — TS6059 for a file outside `rootDir`, TS6307 for a file in no
 * project's list. Nothing about that is fixable from here: the factory resolves the engine through
 * `node_modules`, which is precisely the resolution a project reference replaces. See the note in
 * `.kojo/tsconfig.json`.
 */
const lanes: ReadonlyArray<string> = (() => {
  const source = readFileSync(`${repositoryRoot}/.kojo/envelopes.ts`, "utf8");
  const declared = /export const lanes = \[([^\]]*)\] as const;/.exec(source);
  return [...(declared?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
})();

/**
 * The commands one lane grades a change with, read off its own `stages:` literal.
 *
 * A text read, and the right instrument rather than a weak one: what is being asserted *is* a
 * literal in the source. Nothing about a lane is introspectable at run time — a lane is a function
 * returning an `Effect`, and calling one needs an engine, a sandbox and an agent — so the honest
 * choice is to read the declaration, and to say so.
 */
const stagesIn = (source: string): ReadonlyArray<string> => {
  const opens = source.indexOf("[", source.indexOf("stages:"));
  if (opens < 0) return [];

  // Balanced, not a non-greedy regex. The list holds nested arrays — `[["typecheck", …], …]` — so a
  // `\[[\s\S]*?\]` stops at the first inner `]` and reports a one-stage lane for every lane. Which is
  // what it did: three lanes came back with two distinct fingerprints and the assertion below caught
  // the instrument rather than the code.
  let depth = 0;
  let closes = opens;
  for (; closes < source.length; closes += 1) {
    if (source[closes] === "[") depth += 1;
    if (source[closes] === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }

  return [...source.slice(opens, closes).matchAll(/\[\s*"([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );
};

describe("Kojo's own factory", () => {
  it("typechecks against the real engine, under strict TypeScript", () => {
    // The binary is the repository's own tsgo — the same one `bun tsc` runs. A missing one is a
    // failed test rather than a skipped one: this check is the point of the file.
    expect(existsSync(typescript), `no TypeScript at ${typescript}`).toBe(true);

    const reported = (() => {
      try {
        execFileSync(typescript, ["--project", ".kojo/tsconfig.json"], {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
        return "";
      } catch (cause) {
        const failure = cause as { stdout?: string; stderr?: string };
        return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      }
    })();

    expect(reported, `.kojo/ does not typecheck:\n${reported}`).toBe("");
  });

  it.effect("loads through the real loader, under the name a person types", () =>
    Effect.gen(function* () {
      const loaded = yield* loadWorkflow("factory", { root: repositoryRoot }).pipe(
        Effect.tapError((error) => Effect.logError(error.describe)),
      );

      expect(loaded.name).toBe("factory");
      expect(loaded.definition._tag).toBe("factory");

      // `kojo run factory "<request>"` fills exactly one field from the word a person types, so a
      // payload of any other width is a factory the command line cannot start.
      expect(Object.keys(loaded.definition.payloadSchema.fields)).toEqual(["request"]);
    }),
  );

  it("has a lane module for every lane its router may answer with", () => {
    expect([...lanes]).toEqual(["hotfix", "feature", "chore"]);

    for (const lane of lanes) {
      expect(
        existsSync(`${repositoryRoot}/.kojo/workflows/lane/${lane}.ts`),
        `the router may answer \`${lane}\` and no lane module answers to it`,
      ).toBe(true);
    }
  });

  it("grades each lane with a different set of commands", () => {
    const graded = new Map(lanes.map((lane) => [lane, stagesIn(laneSource(lane))]));

    // Every lane grades a change with something. A lane that measured nothing would leave the
    // mechanical half of the acceptance to a `Judgement` over an empty list, which reads as clean.
    for (const [lane, stages] of graded) {
      expect(stages.length, `${lane} grades a change with nothing`).toBeGreaterThan(0);
    }

    // And no two lanes grade it the same way. This is the criterion: a taxonomy whose branches run
    // the same commands is a taxonomy nobody needed.
    const fingerprints = [...graded.values()].map((stages) => [...stages].sort().join("+"));
    expect(
      new Set(fingerprints).size,
      `two lanes grade a change identically: ${fingerprints}`,
    ).toBe(lanes.length);

    // The specific differences the README and the design record both claim, asserted rather than
    // described: the hotfix lane is the cheapest, and the chore lane runs no test at all.
    expect(graded.get("hotfix")).toEqual(["typecheck"]);
    expect(graded.get("chore")).not.toContain("unit");
    expect(graded.get("feature")).toContain("unit");
  });

  it("asks a human inside exactly one lane, and it is the hotfix lane", () => {
    // `reviewed` is the only construct that may hold a gate inside a loop, and a gate inside a lane
    // is what "hotfix approves before it measures" means in code. If a second lane grows one, the
    // claim that the hotfix lane inverts the order of judgement stops being true.
    const asking = lanes.filter((lane) => laneSource(lane).includes("reviewed({"));
    expect(asking).toEqual(["hotfix"]);
  });

  it("plans in exactly one lane, and the planner may write nowhere but its notes", () => {
    const planning = lanes.filter((lane) => laneSource(lane).includes('agent: "planner"'));
    expect(planning).toEqual(["feature"]);

    // The prompt asks the planner to change no code. This is the half that is a boundary: the policy
    // it runs under is `LimitedTo [".scratch/"]`, so a write outside is undone and the run fails.
    expect(laneSource("feature")).toContain('mayWriteNotesOnly("planner")');
  });

  /**
   * **Every lane commits under a type this repository's own `commit-msg` hook accepts, and no two
   * lanes use the same one.**
   *
   * Both halves were bought by a run. Cocogitto runs on `commit-msg`, the `commit` phase puts the
   * agent's own summary on the commit — *agents propose, code disposes* — and the very first run of
   * this factory refused at `commit-tidy` with `Missing commit type separator ':'`. So a lane that
   * stopped naming a type would break at the one step that cannot be retried cheaply: after the agent
   * has already done the work.
   *
   * The types differing is the lane taxonomy reaching the history. A reader of `git log` can tell
   * which lane produced a commit without opening the trace.
   */
  it("commits under a conventional type, and a different one per lane", () => {
    const typesIn = (source: string): ReadonlyArray<string> =>
      [...source.matchAll(/conventional\("([^"]+)"/g)].map((match) => match[1] ?? "");

    const perLane = new Map(lanes.map((lane) => [lane, typesIn(laneSource(lane))]));

    for (const [lane, types] of perLane) {
      expect(types.length, `${lane} commits without naming a conventional type`).toBeGreaterThan(0);
      for (const type of types) {
        // Cocogitto's own set, plus the two `cog.toml` adds. A type outside it is refused by the
        // hook, which is the failure this test exists to move earlier.
        expect(
          ["feat", "fix", "docs", "test", "chore", "refactor", "build", "perf", "style", "revert"],
          `${lane} commits under \`${type}:\`, which \`cog verify\` refuses`,
        ).toContain(type);
      }
    }

    expect(perLane.get("hotfix")).toEqual(["fix", "fix"]);
    expect(perLane.get("feature")).toEqual(["docs", "feat"]);
    expect(perLane.get("chore")).toEqual(["chore"]);
  });

  /**
   * **Dependencies are restored by a sandbox hook, and by nothing else.**
   *
   * This is the assertion that keeps ticket 36's largest finding from being undone by somebody who
   * reads `install` in a phase table and misses why it is not there. It was a `code` phase; the
   * hotfix lane suspended at its in-lane gate, the scope tore the worktree down, the body replayed,
   * and the phase **returned its recorded result instead of running** — so `verify` typechecked a
   * worktree with no `node_modules`.
   *
   * Durability replays results, not effects on the environment. A hook runs on every acquisition.
   */
  it("restores dependencies from a hook on every lane, and never from a phase", () => {
    const shared = readFileSync(`${repositoryRoot}/.kojo/workflows/lane/common.ts`, "utf8");
    expect(shared).toContain("onWorktreeReady");
    // A `code(` phase named `install` is exactly the shape that broke. Named rather than counted, so
    // the failure says what to do.
    expect(shared, "`restore` is a phase again — see the note above it").not.toMatch(
      /name:\s*"install"/,
    );

    for (const lane of lanes) {
      expect(
        laneSource(lane),
        `${lane} does not pass \`restore\` as a hook, so its worktree has no dependencies`,
      ).toContain("hooks: restore");
      expect(
        laneSource(lane),
        `${lane} still yields \`restore\` as a phase, which does not survive a suspension`,
      ).not.toContain("yield* restore");
    }
  });

  /**
   * **The skill in this repository is the skill `kojo init` writes.**
   *
   * Ticket 36's fifth criterion is that an agent which has never seen a Kojo repository can drive
   * one, and the files that say so are stamped by `init` *and* committed here. Two copies of a
   * document drift, and the copy that would drift is this repository's — nothing in the build reads
   * it, so a template edit would leave the committed pair a version behind and the next agent working
   * on Kojo reading last month's instructions.
   *
   * Byte-identical rather than "similar": the template is the source, and this is the check that says
   * so. Regenerate with the two-line script in the ticket's comments if this fails.
   */
  it("carries exactly the skill a stamped repository gets", () => {
    for (const [name, rendered] of [
      ["SKILL.md", skill()],
      ["authoring.md", authoring()],
    ] as const) {
      const committed = readFileSync(`${repositoryRoot}/${skillsDirectory}/${name}`, "utf8");
      expect(
        committed,
        `${skillsDirectory}/${name} is not what \`kojo init\` writes — regenerate it`,
      ).toBe(rendered);
    }
  });
});
