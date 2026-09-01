import { Data } from "effect";

export class FactoryAssetError extends Data.TaggedError("FactoryAssetError")<{
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}
