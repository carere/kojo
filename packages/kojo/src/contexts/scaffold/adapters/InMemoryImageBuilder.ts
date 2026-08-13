import { Context, Effect, Layer } from "effect";
import type { ScaffoldError } from "../models/ScaffoldError.ts";
import { ImageBuilder, type ImageRequest } from "../ports/ImageBuilder.ts";

/**
 * What was asked to be built, readable from a test without a container runtime.
 *
 * A second service rather than a method on the builder, for the reason `AcknowledgedEvents` gives:
 * nothing that builds images should be able to read back every image anybody asked for.
 */
export class BuiltImages extends Context.Service<
  BuiltImages,
  { readonly built: Effect.Effect<ReadonlyArray<ImageRequest>> }
>()("kojo/scaffold/BuiltImages") {}

/**
 * A builder that records instead of building.
 *
 * This is what makes "the image init builds is the image the stamped workflow asks for" a unit
 * test. The claim is about two strings agreeing, and proving it by building a real container would
 * be paying several minutes for an answer that has nothing to do with containers.
 *
 * Both services come out of one `Layer.effectContext` because they are two views of one array.
 */
export const layer: Layer.Layer<ImageBuilder | BuiltImages> = Layer.effectContext(
  Effect.sync(() => {
    const requests: Array<ImageRequest> = [];

    return Context.make(ImageBuilder, {
      build: (request: ImageRequest): Effect.Effect<void, ScaffoldError> =>
        Effect.sync(() => void requests.push(request)),
    }).pipe(Context.add(BuiltImages, { built: Effect.sync(() => [...requests]) }));
  }),
);
