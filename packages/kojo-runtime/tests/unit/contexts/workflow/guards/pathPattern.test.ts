import { matchesGlob } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { matchesPattern } from "../../../../../src/contexts/workflow/guards/pathPattern.ts";

/**
 * The table is the specification. Every row is one pattern, one path, and the answer the permission
 * boundary depends on — ported from the upstream matcher, where the rule was arrived at the hard
 * way after an agent handed a shell reverted the very files it was about to be graded by.
 */
const cases: ReadonlyArray<readonly [pattern: string, path: string, matches: boolean]> = [
  // `*` names one segment, and stops at the separator. These four rows are the whole ticket.
  [".kojo/workflows/*.ts", ".kojo/workflows/factory.ts", true],
  [".kojo/workflows/*.ts", "reports/sessions/x/y.ts", false],
  [".kojo/workflows/*.ts", ".kojo/workflows/lane/hotfix.ts", false],
  ["adws/adw_*.py", "adws/adw_data/sessions/x/y.py", false],

  // `**` is how a pattern asks to cross directories, and saying it is the point.
  [".kojo/**/*.ts", ".kojo/workflows/lane/hotfix.ts", true],
  [".kojo/**", ".kojo/kojo.config.yaml", true],

  // `?` is one character, and it stops at the separator too.
  ["src/file?.ts", "src/file1.ts", true],
  ["src/file?.ts", "src/file10.ts", false],
  ["src/a?c.ts", "src/a/c.ts", false],

  // A trailing slash is a directory prefix. An operator writes it to mean "this tree, all of it",
  // and it must not depend on remembering `**`.
  [".kojo/workflows/", ".kojo/workflows/factory.ts", true],
  [".kojo/workflows/", ".kojo/workflows/lane/hotfix.ts", true],
  [".kojo/workflows/", ".kojo/workflows.ts", false],
  ["reports/", "reports/runs/run_1/envelope.json", true],

  // No wildcard is equality, so a path is compared as a path.
  [".kojo/kojo.config.yaml", ".kojo/kojo.config.yaml", true],
  [".kojo/kojo.config.yaml", "x/.kojo/kojo.config.yaml", false],
  [".kojo/kojo.config.yaml", ".kojo/kojo.config.yaml.bak", false],

  // A regular-expression metacharacter in a path is a character, not syntax.
  ["src/a.ts", "src/axts", false],
  ["src/[id].ts", "src/[id].ts", true],

  // Anchored at both ends: a pattern names a whole path, never a piece of one.
  ["*.ts", "src/health.ts", false],
  ["src/*", "src/health.ts", true],
];

describe("a permission path pattern", () => {
  for (const [pattern, path, matches] of cases) {
    it(`${matches ? "matches" : "does not match"} ${path} against ${pattern}`, () => {
      expect(matchesPattern(path, pattern)).toBe(matches);
    });
  }

  /**
   * The matcher everybody writes by hand, and the reason this module exists.
   *
   * Translating `*` to `.*` is one character away from correct and quietly widens every pattern it
   * is given. The upstream case is the first pair below: a pattern meant to name the ADW scripts
   * also claims every session file beneath them. In an agent's own list that hands it a whole
   * store nobody named; in the protected list it bars work an agent was meant to do, and somebody
   * loosens the list to get past it. Both directions end with the boundary not saying what its
   * author read.
   */
  const naive = (path: string, pattern: string): boolean =>
    new RegExp(`^${pattern.replaceAll(".", "\\.").replaceAll("*", ".*")}$`).test(path);

  it("does not widen a pattern the way a naive matcher does", () => {
    expect(naive("adws/adw_data/sessions/x/y.py", "adws/adw_*.py")).toBe(true);
    expect(matchesPattern("adws/adw_data/sessions/x/y.py", "adws/adw_*.py")).toBe(false);

    expect(naive(".kojo/workflows/lane/hotfix.ts", ".kojo/workflows/*.ts")).toBe(true);
    expect(matchesPattern(".kojo/workflows/lane/hotfix.ts", ".kojo/workflows/*.ts")).toBe(false);
  });

  /**
   * A stock glob matcher, measured rather than assumed about.
   *
   * `node:path`'s `matchesGlob` keeps `*` inside one segment, so it is right about the separator —
   * and still wrong for this job, in the other direction. A trailing-slash pattern matches nothing
   * at all, so `.kojo/workflows/` protects none of the workflows and an agent edits its own grader
   * with the protected list looking correct in the config file.
   */
  it("protects a directory that a stock glob matcher leaves open", () => {
    expect(matchesGlob(".kojo/workflows/factory.ts", ".kojo/workflows/")).toBe(false);
    expect(matchesPattern(".kojo/workflows/factory.ts", ".kojo/workflows/")).toBe(true);
  });
});
