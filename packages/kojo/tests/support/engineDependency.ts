import type { EngineDependency } from "../../src/contexts/scaffold/models/EngineDependency.ts";
import { engineDependency } from "../../src/contexts/scaffold/services/resolveEngine.ts";
import { runtimePackage } from "../../src/contexts/shared/models/FactoryLayout.ts";

/**
 * The two entries a stamped repository must declare, as the two tiers each need them.
 *
 * The unit tier gets a made-up pair, because a plan is a pure function of its answers and a unit
 * test that read this machine would be grading this machine. The integration tier gets the real
 * one — the same value `kojo init` computes — because what it is grading is a repository that has
 * to resolve the engine the suite is running out of.
 */

/** A published pair, invented. Nothing resolves it; it is only ever written into a file. */
export const someEngine: EngineDependency = {
  reach: "published",
  runtime: {
    name: runtimePackage,
    specifier: "9.9.9",
    version: "9.9.9",
    directory: "/somewhere/kojo-runtime",
  },
  effect: {
    name: "effect",
    specifier: "4.0.0-test",
    version: "4.0.0-test",
    directory: "/somewhere/effect",
  },
};

/** What this suite's own `kojo` and `effect` are — measured, exactly as `kojo init` measures it. */
export const thisEngine = (): EngineDependency => {
  const found = engineDependency();
  if (found === undefined) {
    throw new Error("this suite cannot resolve its own `kojo` or `effect`, so it cannot stamp one");
  }
  return found;
};
