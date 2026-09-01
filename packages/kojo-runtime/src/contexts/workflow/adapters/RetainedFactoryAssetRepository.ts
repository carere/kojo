import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect, Layer } from "effect";
import { FactoryAssetError } from "../models/FactoryAssetError.ts";
import { FactoryAssetRepository } from "../ports/FactoryAssetRepository.ts";

const inside = (root: string, target: string): boolean => {
  const child = relative(root, target);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

/** Map authored `.kojo` paths to the retained Factory root selected by the Daemon. */
export const layer = (options?: {
  readonly authoredRoot?: string;
  readonly retainedRoot?: string;
}): Layer.Layer<FactoryAssetRepository> =>
  Layer.sync(FactoryAssetRepository, () => {
    const authoredRoot = resolve(options?.authoredRoot ?? join(process.cwd(), ".kojo"));
    const retainedRoot = resolve(
      options?.retainedRoot ?? process.env.KOJO_FACTORY_ASSET_ROOT ?? authoredRoot,
    );
    const selected = (authoredPath: string): string => {
      const absolute = resolve(authoredPath);
      if (inside(retainedRoot, absolute)) return absolute;
      if (!inside(authoredRoot, absolute)) {
        throw new FactoryAssetError({
          path: authoredPath,
          message: "the Factory asset path leaves the selected Factory root",
        });
      }
      return join(retainedRoot, relative(authoredRoot, absolute));
    };
    return {
      resolve: (authoredPath) =>
        Effect.try({
          try: () => selected(authoredPath),
          catch: (cause) =>
            cause instanceof FactoryAssetError
              ? cause
              : new FactoryAssetError({
                  path: authoredPath,
                  message: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
        }),
      readFileString: (authoredPath) =>
        Effect.try({
          try: () => readFileSync(selected(authoredPath), "utf8"),
          catch: (cause) =>
            cause instanceof FactoryAssetError
              ? cause
              : new FactoryAssetError({
                  path: authoredPath,
                  message: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
        }),
    };
  });
