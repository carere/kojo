import { describe, expect, it } from "@effect/vitest";
import {
  declarations,
  dependencyFor,
} from "../../../../../src/contexts/scaffold/models/EngineDependency.ts";
import type { ResolvedPackage } from "../../../../../src/contexts/shared/models/ResolvedPackage.ts";

const installedEngine: ResolvedPackage = {
  name: "@carere/kojo-runtime",
  version: "1.4.0",
  directory: "/repo/node_modules/@carere/kojo-runtime",
};
const installedEffect: ResolvedPackage = {
  name: "effect",
  version: "4.0.0-beta.106",
  directory: "/repo/node_modules/effect",
};

const checkedOutEngine: ResolvedPackage = {
  name: "@carere/kojo-runtime",
  version: "0.0.0",
  directory: "/home/somebody/kojo/packages/kojo-runtime",
};
const checkedOutEffect: ResolvedPackage = {
  name: "effect",
  version: "4.0.0-beta.106",
  directory: "/home/somebody/kojo/node_modules/effect",
};

describe("what a stamped repository has to declare", () => {
  it("names the version, when the engine doing the stamping was installed", () => {
    const declared = dependencyFor({
      runtime: installedEngine,
      effect: installedEffect,
      reach: "published",
    });

    expect(declared.reach).toBe("published");
    expect(declared.runtime.specifier).toBe("1.4.0");
    expect(declared.effect.specifier).toBe("4.0.0-beta.106");
  });

  it("pins `effect` to the version the engine actually loaded, never to one written twice", () => {
    // The criterion: the pin is *derived*. A second place to write the version is a second place
    // for it to drift, so moving the resolved version has to move the specifier with it.
    const declared = dependencyFor({
      runtime: installedEngine,
      effect: { ...installedEffect, version: "4.0.0-beta.999" },
      reach: "published",
    });

    expect(declared.effect.specifier).toBe("4.0.0-beta.999");
    expect(declared.effect.version).toBe("4.0.0-beta.999");
  });

  it("points both entries at this machine, when the engine is a checkout with no version to name", () => {
    const declared = dependencyFor({
      runtime: checkedOutEngine,
      effect: checkedOutEffect,
      reach: "linked",
    });

    expect(declared.reach).toBe("linked");
    expect(declared.runtime.specifier).toBe("file:/home/somebody/kojo/packages/kojo-runtime");
    // **The half that is easy to leave out and fatal to leave out.** Pointing `kojo` at a checkout
    // and `effect` at a version resolves a *second* `effect` for the target — same version,
    // different directory, two `Schema` modules — which is the failure this whole model exists to
    // prevent. Both must point at the copies this engine itself loaded.
    expect(declared.effect.specifier).toBe("file:/home/somebody/kojo/node_modules/effect");
  });

  it("keeps the version beside the specifier, because a diagnosis names versions", () => {
    const declared = dependencyFor({
      runtime: checkedOutEngine,
      effect: checkedOutEffect,
      reach: "linked",
    });

    expect(declared.effect.version).toBe("4.0.0-beta.106");
    expect(declared.runtime.version).toBe("0.0.0");
    expect(declarations(declared).map((entry) => entry.name)).toEqual([
      "@carere/kojo-runtime",
      "effect",
    ]);
  });
});
