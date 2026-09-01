/**
 * What a stamped factory has to declare before a single one of its files resolves.
 *
 * Every file `kojo init` writes imports `kojo` and `effect`. Until this ticket, initialisation
 * declared neither and wrote no manifest at all, so a freshly stamped factory could not load one
 * line of itself — and the stamped README asserted the engine was "a versioned dependency in your
 * package.json", a file initialisation never created.
 *
 * The sharper half is `effect`, and it is why this is a model rather than two strings written
 * inline. **Two copies of `effect` in one process are two `Schema` modules**, so the payload struct
 * a workflow declares and the payload struct the engine reads are different types with different
 * symbol keys. What that costs, measured on a real stamped factory rather than imagined:
 *
 * ```
 * TypeError: Cannot convert a symbol to a string
 *     at idempotencyKey (.kojo/workflows/review.ts:122:44)
 * ```
 *
 * — a framework error, at a line that is innocent, with no Kojo diagnosis anywhere near it.
 */

import type { ResolvedPackage } from "../../shared/models/ResolvedPackage.ts";

/** One dependency a stamped repository declares, and what it was decided from. */
export interface Declared {
  readonly name: string;
  /** What goes in `dependencies` — a version, or a `file:` path to somewhere on this machine. */
  readonly specifier: string;
  /** The version behind that specifier, which is what a diagnosis names when two of them differ. */
  readonly version: string;
  /** Where that version is, resolved. What a diagnosis names *beside* the version — see above. */
  readonly directory: string;
}

/**
 * How the engine doing the stamping was reached.
 *
 * `published` is the ordinary case: this `kojo` was installed, so the target may install the same
 * version by name and the package manager hoists one `effect` for both. `linked` is a checkout —
 * `kojo` run from a clone or a global link — where there is no published version to name, and where
 * the target's own `effect` would resolve to a *second* directory even at an identical version.
 * Both specifiers then point at this machine's own copies, which is what makes the realpaths equal
 * and the module instances one.
 */
export type Reach = "published" | "linked";

/** The two dependencies, decided together, because the pin only works if both agree. */
export interface EngineDependency {
  readonly reach: Reach;
  readonly runtime: Declared;
  readonly effect: Declared;
  /** A checkout-only override for the runtime's internal workspace dependency. */
  readonly runnerContracts?: Declared | undefined;
}

/**
 * What a stamped repository must declare, given the engine that is stamping it.
 *
 * **The pin is derived, never typed twice.** Both versions are read off the packages this process
 * actually loaded, so there is no second place for the `effect` version to be written and therefore
 * no second place for it to drift from the one the engine was built against.
 */
export const dependencyFor = (options: {
  readonly runtime: ResolvedPackage;
  readonly effect: ResolvedPackage;
  readonly reach: Reach;
  readonly runnerContracts?: ResolvedPackage | undefined;
}): EngineDependency => {
  const reach = options.reach;
  const specifier = (resolved: ResolvedPackage) =>
    reach === "published" ? resolved.version : `file:${resolved.directory}`;

  const declare = (resolved: ResolvedPackage): Declared => ({
    name: resolved.name,
    specifier: specifier(resolved),
    version: resolved.version,
    directory: resolved.directory,
  });

  return {
    reach,
    runtime: declare(options.runtime),
    effect: declare(options.effect),
    ...(options.runnerContracts === undefined
      ? {}
      : { runnerContracts: declare(options.runnerContracts) }),
  };
};

/** The two entries in the order they are declared and reported. */
export const declarations = (engine: EngineDependency): ReadonlyArray<Declared> => [
  engine.runtime,
  engine.effect,
];
