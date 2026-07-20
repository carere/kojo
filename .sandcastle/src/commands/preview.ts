import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { decodeUnknown } from "../shared/decoding";
import { PreviewBranch, PreviewOptions } from "../types/preview";
import { runPreviewWorkflow } from "../workflows/preview/index";
import { previewServicesLive } from "../workflows/preview/services-live";

const branch = Flag.string("branch").pipe(
  Flag.withSchema(PreviewBranch),
  Flag.withDescription("Branch to preview (local or origin)"),
);

const start = Command.make("start", { branch }, ({ branch }) =>
  decodeUnknown(PreviewOptions, "preview start options", { action: "start", branch }).pipe(
    Effect.flatMap(runPreviewWorkflow),
    Effect.provide(previewServicesLive),
  ),
).pipe(
  Command.withDescription("Start a browser preview for a branch available locally or on origin"),
);

const stop = Command.make("stop", { branch }, ({ branch }) =>
  decodeUnknown(PreviewOptions, "preview stop options", { action: "stop", branch }).pipe(
    Effect.flatMap(runPreviewWorkflow),
    Effect.provide(previewServicesLive),
  ),
).pipe(Command.withDescription("Stop a branch preview and retain its worktree"));

export const previewCommand = Command.make("preview").pipe(
  Command.withDescription("Manage browser previews for delivery branches"),
  Command.withSubcommands([start, stop]),
);
