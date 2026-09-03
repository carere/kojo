import { Context, type Effect } from "effect";
import type { FactoryAssetError } from "../models/FactoryAssetError.ts";

/** Reads Factory-owned data from the exact root selected for this revision. */
export class FactoryAssetRepository extends Context.Service<
  FactoryAssetRepository,
  {
    readonly resolve: (authoredPath: string) => Effect.Effect<string, FactoryAssetError>;
    readonly readFileString: (authoredPath: string) => Effect.Effect<string, FactoryAssetError>;
  }
>()("kojo/workflow/FactoryAssetRepository") {}
