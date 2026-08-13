/**
 * One package as it actually exists on this machine.
 *
 * Shared, because two contexts ask the same question of it from opposite ends: **scaffold** asks
 * what a repository must declare so its stamped files resolve the engine, and **workflow** asks
 * whether the file it is about to import resolves the same `effect` this process is running on.
 */
export interface ResolvedPackage {
  readonly name: string;
  readonly version: string;
  /**
   * The package directory, resolved through every symlink.
   *
   * **The realpath is the identity.** Two specifiers that lead here are one module instance; two
   * directories holding the same version are two — a package manager links its store into
   * `node_modules`, so equal versions prove nothing and equal paths prove everything.
   *
   * What the difference costs, measured on a real stamped factory rather than imagined: two copies
   * of `effect` are two `Schema` modules, so a workflow's payload struct and the engine's reading
   * of it are different types with different symbol keys, and the run dies with
   * `TypeError: Cannot convert a symbol to a string` inside the framework — pointing at a line of
   * the person's own workflow that has nothing wrong with it.
   */
  readonly directory: string;
}

/** `effect 4.0.0-beta.106 (…/node_modules/effect)` — the version *and* the path, always both. */
export const identify = (resolved: ResolvedPackage): string =>
  `${resolved.name} ${resolved.version} (${resolved.directory})`;

/** Two copies of one package, held by two people who have to agree about it. */
export interface Split {
  /** What this process loaded. */
  readonly mine: ResolvedPackage;
  /** What the factory resolves. */
  readonly theirs: ResolvedPackage;
}

/** The sentence both the loader and the doctor say about a split, so they cannot say it differently. */
export const describeSplit = (split: Split): string =>
  `two copies of ${split.mine.name}: this engine loaded ${identify(split.mine)}, and this ` +
  `factory resolves ${identify(split.theirs)}`;
