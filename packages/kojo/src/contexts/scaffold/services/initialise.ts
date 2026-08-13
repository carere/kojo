import { Effect, type FileSystem, Option, Path } from "effect";
import type { EngineDependency } from "../models/EngineDependency.ts";
import {
  type AgentName,
  buildsAnImage,
  type FactoryChoices,
  type SandboxChoice,
  type TemplateName,
} from "../models/FactoryChoices.ts";
import type { Stamped } from "../models/FactoryPlan.ts";
import type { PackageManager } from "../models/PackageManager.ts";
import { toolchainFor } from "../models/PackageManager.ts";
import type { ScaffoldError } from "../models/ScaffoldError.ts";
import { ImageBuilder } from "../ports/ImageBuilder.ts";
import { detectPackageManager } from "./detectPackageManager.ts";
import { type IgnoreReport, ignoreInstall } from "./ignoreInstall.ts";
import { declareEngine, type ManifestReport } from "./manifest.ts";
import { defaultImageName, imagePaths, plan } from "./plan.ts";
import { stamp } from "./stamp.ts";

/** The four answers a person gives, plus the three things they may override. */
export interface InitialiseRequest {
  /** The repository to stamp a factory into. */
  readonly root: string;
  readonly agent: AgentName;
  readonly model: string;
  readonly sandbox: SandboxChoice;
  readonly template: TemplateName;
  /**
   * What the stamped repository must declare to resolve `kojo` and `effect`.
   *
   * An argument rather than something read here, because it is a fact about the **process doing the
   * stamping** and not about the repository being stamped. Passing it in is also what keeps this
   * effect gradable over a filesystem that lives in a `Map`.
   */
  readonly engine: EngineDependency;
  /** Overrides detection. For a repository whose lockfile is not the truth about it. */
  readonly packageManager?: PackageManager | undefined;
  /** Overrides the name derived from the repository directory. */
  readonly imageName?: string | undefined;
  /** Stamp the files and stop. The image is what makes initialisation slow and needs a daemon. */
  readonly skipImage?: boolean | undefined;
  /** The uid and gid the image's `agent` user is built with. See `ImageRequest`. */
  readonly uid: number;
  readonly gid: number;
}

/** What a factory came out as: the answers it was built from, and what happened to each file. */
export interface Initialised {
  readonly choices: FactoryChoices;
  readonly stamped: ReadonlyArray<Stamped>;
  /** The image that was built, or nothing when none was asked for. */
  readonly image: Option.Option<string>;
  /** What became of the repository's own `package.json`, which is what makes the rest resolve. */
  readonly manifest: ManifestReport;
  /** What became of the repository's own `.gitignore` — the install this asks for must be ignored. */
  readonly ignore: IgnoreReport;
}

/**
 * Stamp a factory into a repository, and build the image its phases run in.
 *
 * Four steps, in the only order they work in: look at the repository, decide, write, build.
 *
 * **The image is built from the stamped Dockerfile, not from a copy of it**, and that is what keeps
 * edge 7 closed after the first run. The Dockerfile that carries the package manager is the file
 * that is built, so a person who edits the toolchain block and rebuilds gets the image their edit
 * describes — rather than an image built from whatever the scaffolder remembered.
 *
 * Nothing here copies engine source into the target. Every stamped file either declares something
 * (the roster, the envelopes, the checks, the commands) or is a program the target owns that
 * *imports* Kojo. Upgrading Kojo is a version bump; it is never a re-stamp.
 *
 * **Which is why the manifest is written first.** "Imports Kojo" is only half a design until
 * something declares Kojo, and for four tickets it was the missing half: eleven files that each
 * imported `kojo` and `effect`, into a repository that declared neither.
 */
export const initialise = (
  request: InitialiseRequest,
): Effect.Effect<Initialised, ScaffoldError, FileSystem.FileSystem | Path.Path | ImageBuilder> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const builder = yield* ImageBuilder;

    const root = path.resolve(request.root);
    const toolchain =
      request.packageManager === undefined
        ? yield* detectPackageManager(root)
        : toolchainFor(request.packageManager, "the --package-manager flag");

    const choices: FactoryChoices = {
      agent: request.agent,
      model: request.model,
      sandbox: request.sandbox,
      template: request.template,
      toolchain,
      imageName: request.imageName ?? defaultImageName(path.basename(root)),
      engine: request.engine,
    };

    const manifest = yield* declareEngine({ root, engine: request.engine });
    // Beside the manifest, because the two are the whole of what init touches outside `.kojo/`:
    // the manifest is what makes the instructed install necessary, and this is what keeps the
    // install's product off the trunk the first merge will refuse over.
    const ignore = yield* ignoreInstall({ root });
    const stamped = yield* stamp(root, plan(choices));

    // Skipped for `none`, `vercel` and `daytona` because there is nothing on this machine to build
    // — an isolated provider builds its own environment, and `none` has no container at all. The
    // Dockerfile is still stamped: it is the written record of what the phases assume.
    if (request.skipImage === true || !buildsAnImage(choices.sandbox)) {
      return { choices, stamped, manifest, ignore, image: Option.none() };
    }

    yield* builder.build({
      imageName: choices.imageName,
      dockerfile: path.join(root, imagePaths.dockerfile),
      context: path.join(root, imagePaths.context),
      uid: request.uid,
      gid: request.gid,
    });

    return { choices, stamped, manifest, ignore, image: Option.some(choices.imageName) };
  });
