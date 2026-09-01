import { describe, expect, it } from "@effect/vitest";
import {
  type FactoryChoices,
  type TemplateName,
  templateNames,
} from "../../../../../src/contexts/scaffold/models/FactoryChoices.ts";
import { toolchainFor } from "../../../../../src/contexts/scaffold/models/PackageManager.ts";
import { plan } from "../../../../../src/contexts/scaffold/services/plan.ts";
import { runtimePackage } from "../../../../../src/contexts/shared/models/FactoryLayout.ts";
import { someEngine } from "../../../../support/engineDependency.ts";

/**
 * The engine's registry name reaches a stamped factory through two paths that must agree.
 *
 * `kojo init` **declares** the dependency in the target's `package.json`, and every file it stamps
 * **imports** the engine by that same name. The declaration is derived — `EngineDependency` reads
 * the name off the package this process resolved — but the imports are literals inside the template
 * modules, one per line, sixty-odd of them across the two starters. Nothing made the two agree.
 *
 * That mattered the moment the package was renamed. A template still saying `from "kojo/..."` after
 * the manifest says `@carere/kojo` stamps a factory that installs cleanly and then fails at the
 * first line of the first file it loads, with `Cannot find module` — and `doctor` would call it
 * ready, because `doctor` checks that the *declared* dependency resolves, which it does.
 *
 * So the rule is checked rather than remembered: every bare specifier a stamped file imports is
 * either `effect`, or it begins with `runtimePackage`. Relative paths are the factory's own files
 * and are not this test's business.
 */
const choicesFor = (template: TemplateName): FactoryChoices => ({
  agent: "pi",
  model: "claude-sonnet-4-6",
  sandbox: "docker",
  template,
  toolchain: toolchainFor("bun", "bun.lock"),
  imageName: "kojo-demo:latest",
  engine: someEngine,
});

/** Every `from "…"` in a stamped file, whatever quotes the template wrote it with. */
const specifiersIn = (content: string): ReadonlyArray<string> =>
  [...content.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");

/** A path the factory resolves itself. Everything else is a package a manager has to install. */
const isRelative = (specifier: string): boolean => specifier.startsWith(".");

describe("what a stamped factory imports the engine as", () => {
  it.each(templateNames)("%s imports the engine only by its declared name", (template) => {
    const stamped = plan(choicesFor(template));

    const bare = stamped.files
      .flatMap((file) => specifiersIn(file.content).map((specifier) => ({ file, specifier })))
      .filter(({ specifier }) => !isRelative(specifier));

    // A template that stopped importing the engine would pass every assertion below by having
    // nothing to check. The starters both import it many times over; one is the floor that says
    // this test still has a subject.
    expect(bare.length).toBeGreaterThan(0);

    for (const { file, specifier } of bare) {
      const allowed = specifier === "effect" || specifier.startsWith(`${runtimePackage}/`);
      expect(
        allowed,
        `${file.path} imports "${specifier}", which is neither effect nor the engine`,
      ).toBe(true);
    }
  });

  it.each(templateNames)("%s imports the engine at all, by the constant", (template) => {
    const stamped = plan(choicesFor(template));

    const importers = stamped.files.filter((file) =>
      specifiersIn(file.content).some((specifier) => specifier.startsWith(`${runtimePackage}/`)),
    );

    // Envelopes, checks and the workflow all import the engine. If a rename ever leaves the
    // templates behind, this is the assertion that reddens first and names the constant.
    expect(importers.length).toBeGreaterThan(2);
  });

  it("declares the engine under the same name it imports it by", () => {
    // The two ends of the seam, compared directly: what `init` writes into `dependencies`, and what
    // the stamped files ask a resolver for.
    expect(someEngine.runtime.name).toBe(runtimePackage);
  });
});
