import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { installedPackage } from "../../shared/services/resolvePackage.ts";

/** Point a development Project at the source Runtime and its one Effect instance. */
export const linkDevelopmentRuntime = (
  project: string,
  sourcePackage: string,
): ReadonlyArray<string> => {
  const root = realpathSync(resolve(project));
  JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const runtime = installedPackage(sourcePackage, "@carere/kojo-runtime");
  if (runtime === undefined) throw new Error("Run bun install in the Kojo source checkout first.");
  const effect = installedPackage(runtime.directory, "effect");
  if (effect === undefined)
    throw new Error("The source Runtime has no installed Effect dependency.");
  const priorEffect = installedPackage(root, "effect");
  if (priorEffect !== undefined && priorEffect.version !== effect.version)
    throw new Error(
      `The Project uses Effect ${priorEffect.version}; this Runtime needs ${effect.version}. Update the Project dependency before linking.`,
    );
  const modules = join(root, "node_modules");
  const node = lstatSync(modules, { throwIfNoEntry: false });
  if (node !== undefined && !node.isDirectory())
    throw new Error("The Project node_modules must be a directory, not a shared symlink.");
  mkdirSync(modules, { recursive: true });
  const backup = join(modules, ".kojo-link-backups", crypto.randomUUID());
  const linked: Array<string> = [];
  for (const [name, source] of [
    ["@carere/kojo-runtime", runtime.directory],
    ["effect", effect.directory],
  ] as const) {
    const destination = join(modules, name);
    const existing = lstatSync(destination, { throwIfNoEntry: false });
    if (existing !== undefined) {
      try {
        if (realpathSync(destination) === realpathSync(source)) {
          linked.push(`${name}: already linked to ${source}`);
          continue;
        }
      } catch {
        /* Replace a broken dependency link, preserving it below. */
      }
      const saved = join(backup, name);
      mkdirSync(dirname(saved), { recursive: true });
      renameSync(destination, saved);
    }
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(source, destination, "dir");
    linked.push(`${name}: linked to ${source}`);
  }
  return linked;
};
