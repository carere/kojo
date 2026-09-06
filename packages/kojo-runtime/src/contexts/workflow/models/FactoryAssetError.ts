import { Data } from "effect";
import type { YieldableError } from "effect/Cause";

interface FactoryAssetErrorFields {
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}

const FactoryAssetErrorBase: new (
  args: FactoryAssetErrorFields,
) => YieldableError & { readonly _tag: "FactoryAssetError" } & FactoryAssetErrorFields =
  Data.TaggedError("FactoryAssetError");

export class FactoryAssetError extends FactoryAssetErrorBase {}
