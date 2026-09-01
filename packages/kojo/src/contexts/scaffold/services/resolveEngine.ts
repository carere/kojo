import { runnerContractsPackage, runtimePackage } from "../../shared/models/FactoryLayout.ts";
import { installedPackage, thisEngine } from "../../shared/services/resolvePackage.ts";
import { dependencyFor, type EngineDependency } from "../models/EngineDependency.ts";

/**
 * What a stamped repository has to declare so that its files resolve to **these** modules.
 *
 * `undefined` when this process cannot say where it is — which no ordinary install produces, and
 * which the callers treat as "declare nothing" rather than "declare a guess". A scaffolder that
 * guessed a version here would be edge 6 wearing a different hat: a plausible pin that resolves a
 * second `effect` is worse than no pin at all, because it fails later and further away.
 */
export const engineDependency = (): EngineDependency | undefined => {
  const engine = thisEngine();
  if (engine === undefined) return undefined;
  const effect = installedPackage(engine.directory, "effect");
  if (effect === undefined) return undefined;

  const installed = engine.directory.split("/").includes("node_modules");
  const runtime = installed
    ? { name: runtimePackage, version: engine.version, directory: engine.directory }
    : installedPackage(engine.directory, runtimePackage);
  const runnerContracts = installed
    ? undefined
    : installedPackage(engine.directory, runnerContractsPackage);

  return runtime === undefined || (!installed && runnerContracts === undefined)
    ? undefined
    : dependencyFor({
        runtime,
        effect,
        reach: installed ? "published" : "linked",
        runnerContracts,
      });
};
