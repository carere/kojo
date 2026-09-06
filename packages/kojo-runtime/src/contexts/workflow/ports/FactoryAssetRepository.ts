import { Context, type Effect } from "effect";
import type { FactoryAssetError } from "../models/FactoryAssetError.ts";

interface FactoryAssetRepositoryService {
  readonly resolve: (authoredPath: string) => Effect.Effect<string, FactoryAssetError>;
  readonly readFileString: (authoredPath: string) => Effect.Effect<string, FactoryAssetError>;
}

const FactoryAssetRepositoryBase: Context.ServiceClass<
  FactoryAssetRepository,
  "kojo/workflow/FactoryAssetRepository",
  FactoryAssetRepositoryService
> = Context.Service<FactoryAssetRepository, FactoryAssetRepositoryService>()(
  "kojo/workflow/FactoryAssetRepository",
);

/** Reads Factory-owned data from the exact root selected for this revision. */
export class FactoryAssetRepository extends FactoryAssetRepositoryBase {}
