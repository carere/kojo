import { describe, expect, it } from "@effect/vitest";
import { manifestFor } from "../../../../../src/contexts/scaffold/services/manifest.ts";
import { runtimePackage } from "../../../../../src/contexts/shared/models/FactoryLayout.ts";
import { someEngine } from "../../../../support/engineDependency.ts";

const decide = (existing?: string) =>
  manifestFor({ existing, directory: "My Repo", engine: someEngine });

const parsed = (content: string | undefined) =>
  JSON.parse(content ?? "{}") as Record<string, unknown>;

describe("the manifest a repository needs before one stamped file resolves", () => {
  it("creates one when there is none, declaring both packages every stamped file imports", () => {
    const decision = decide();
    const manifest = parsed(decision.content);

    expect(decision.outcome).toBe("created");
    expect(manifest.dependencies).toEqual({ [runtimePackage]: "9.9.9", effect: "4.0.0-test" });
    // A name a registry would accept, out of a directory name a person chose.
    expect(manifest.name).toBe("my-repo");
    expect(manifest.private).toBe(true);
  });

  it("adds only what is missing, and keeps every other field a person wrote", () => {
    const decision = decide(
      `${JSON.stringify(
        {
          name: "acme",
          version: "2.1.0",
          scripts: { build: "tsc" },
          dependencies: { zod: "3.0.0" },
        },
        undefined,
        2,
      )}\n`,
    );
    const manifest = parsed(decision.content);

    expect(decision.outcome).toBe("updated");
    expect(manifest.name).toBe("acme");
    expect(manifest.version).toBe("2.1.0");
    expect(manifest.scripts).toEqual({ build: "tsc" });
    expect(manifest.dependencies).toEqual({
      zod: "3.0.0",
      [runtimePackage]: "9.9.9",
      effect: "4.0.0-test",
    });
    expect(decision.added.map((entry) => entry.name)).toEqual([runtimePackage, "effect"]);
  });

  it("never re-pins what the repository already declares — it reports the disagreement instead", () => {
    const decision = decide(JSON.stringify({ dependencies: { effect: "3.11.0" } }));

    // The rule `stamp` keeps for files, kept here for values: a scaffolder that silently re-pinned
    // somebody's `effect` is the same class of defect as one that silently replaced their workflow.
    expect(decision.outcome).toBe("updated");
    expect(parsed(decision.content).dependencies).toMatchObject({ effect: "3.11.0" });
    expect(decision.mismatched).toEqual([
      { name: "effect", wanted: "4.0.0-test", declared: "3.11.0" },
    ]);
    expect(decision.added.map((entry) => entry.name)).toEqual([runtimePackage]);
  });

  it("counts a dependency declared in any of the four blocks as declared", () => {
    const decision = decide(
      JSON.stringify({ devDependencies: { effect: "4.0.0-test" }, dependencies: {} }),
    );

    expect(decision.mismatched).toEqual([]);
    expect(decision.added.map((entry) => entry.name)).toEqual([runtimePackage]);
    expect(parsed(decision.content).dependencies).toEqual({ [runtimePackage]: "9.9.9" });
  });

  it("keeps a manifest it cannot read rather than replacing it", () => {
    const decision = decide("{ this is not json");

    expect(decision.outcome).toBe("unreadable");
    expect(decision.content).toBeUndefined();
    expect(decision.mismatched.map((entry) => entry.name)).toEqual([runtimePackage, "effect"]);
  });

  it("is exactly idempotent: run over its own output it changes nothing and says so", () => {
    const first = decide();
    const second = decide(first.content);

    expect(second.outcome).toBe("kept");
    expect(second.content).toBeUndefined();
    expect(second.added).toEqual([]);
    expect(second.mismatched).toEqual([]);
  });
});
