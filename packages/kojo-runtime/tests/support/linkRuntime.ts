import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/** Link the runtime under test and its peer dependencies into a stamped fixture. */
export const linkRuntime = (options: {
  readonly root: string;
  readonly runtimeRoot: string;
}): void => {
  const link = (from: string, to: string) => {
    if (!existsSync(to)) symlinkSync(from, to);
  };
  const runtimeLink = join(options.root, "node_modules", "@carere", "kojo-runtime");
  mkdirSync(dirname(runtimeLink), { recursive: true });
  link(options.runtimeRoot, runtimeLink);
  for (const dependency of ["effect", "@ai-hero", "@effect", "@types"]) {
    link(
      join(options.runtimeRoot, "node_modules", dependency),
      join(options.root, "node_modules", dependency),
    );
  }
};
