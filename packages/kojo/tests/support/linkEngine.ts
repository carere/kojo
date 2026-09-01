import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { enginePackage, runtimePackage } from "../../src/contexts/shared/models/FactoryLayout.ts";

/**
 * What `bun install` leaves a target repository holding, made by hand and with nothing copied.
 *
 * Every integration fixture that stamps a factory needs the same three things in `node_modules`:
 * the engine under test, the `effect` it was built against, and the scopes the two of them reach
 * through. A stamped file's `@carere/kojo/…` import resolves through this and nothing else.
 *
 * **It is one function because the engine's name is scoped, and a scope is two levels.** Six
 * fixtures each wrote `link(packageRoot, join(root, "node_modules", "kojo"))` inline, and when the
 * package was renamed every one of them silently kept linking a path no import would ever look at:
 * `doctor` then reports *`.kojo/` cannot resolve @carere/kojo* about a repository that plainly has
 * it, which reads as a bug in the resolver rather than a stale fixture. Six call sites are six
 * chances to forget — the same argument `defaultTrunk` settled for the branch a fixture starts on.
 *
 * The path is built from `enginePackage`, so the link and the import are one string.
 */
export const linkEngine = (options: {
  /** The throwaway repository a factory was stamped into. */
  readonly root: string;
  /** This package's own directory — what a target resolves `@carere/kojo` to. */
  readonly packageRoot: string;
  /**
   * What else to link beside the engine. The default is what a stamped factory needs to load.
   *
   * `duplicateEffect.test.ts` passes a list without `effect` in it, because its whole subject is a
   * target holding a *second* copy — and a link would realpath back onto the first, which is the
   * arrangement that works rather than the one under test.
   */
  readonly dependencies?: ReadonlyArray<string>;
}): void => {
  const { root, packageRoot } = options;
  const dependencies = options.dependencies ?? ["effect", "@ai-hero", "@effect", "@types"];

  const link = (from: string, to: string) => {
    if (!existsSync(to)) symlinkSync(from, to);
  };

  const engineLink = join(root, "node_modules", enginePackage);
  // `node_modules/@carere` has to exist before `node_modules/@carere/kojo` can be made inside it.
  // Unscoped names make `dirname` the `node_modules` directory itself, which is already there, so
  // this line is correct either way and does not assume the engine stays scoped.
  mkdirSync(dirname(engineLink), { recursive: true });
  link(packageRoot, engineLink);

  const runtimeLink = join(root, "node_modules", runtimePackage);
  mkdirSync(dirname(runtimeLink), { recursive: true });
  link(join(dirname(packageRoot), "kojo-runtime"), runtimeLink);

  for (const dependency of dependencies) {
    link(join(packageRoot, "node_modules", dependency), join(root, "node_modules", dependency));
  }
};
