import { Context, type Effect } from "effect";
import type { ScaffoldError } from "../models/ScaffoldError.ts";

/** One image to build, named the way the sandbox provider will ask for it. */
export interface ImageRequest {
  /** The tag. The stamped workflow names the same string, so a run finds what init built. */
  readonly imageName: string;
  /** The Dockerfile to build, as a path on the host. */
  readonly dockerfile: string;
  /** The build context directory. */
  readonly context: string;
  /**
   * The uid and gid the image's `agent` user is given.
   *
   * Sandcastle's Docker provider defaults `--user` to the **host** uid and gid, and fails its
   * pre-flight when the image disagrees. So these are not cosmetic: an image built with the
   * default 1000 on a machine whose user is 501 produces containers that cannot write the
   * bind-mounted worktree.
   */
  readonly uid: number;
  readonly gid: number;
}

/**
 * Builds the container image a factory's phases run in.
 *
 * A port rather than a call to `docker` for the ordinary reason: initialisation is a use case, and
 * a use case that shelled out directly could only be tested by a test that has a container runtime.
 * The in-memory adapter records what was asked for, so "did init ask for the image the workflow
 * names" is a unit test, and "does that image actually build" is an integration test.
 */
export class ImageBuilder extends Context.Service<
  ImageBuilder,
  {
    readonly build: (request: ImageRequest) => Effect.Effect<void, ScaffoldError>;
  }
>()("kojo/scaffold/ImageBuilder") {}
