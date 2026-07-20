import { Schema } from "effect";

const PreviewAction = Schema.Literals(["start", "stop"]);
export const PreviewBranch = Schema.NonEmptyString;

export class PreviewOptions extends Schema.Class<PreviewOptions>("PreviewOptions")({
  action: PreviewAction,
  branch: PreviewBranch,
}) {}

export class PreviewIdentity extends Schema.Class<PreviewIdentity>("PreviewIdentity")({
  branch: PreviewBranch,
  containerName: Schema.String,
  hostname: Schema.String,
  repositoryId: Schema.String,
}) {}

export class DockerRunInput extends Schema.Class<DockerRunInput>("DockerRunInput")({
  identity: PreviewIdentity,
  envExamplePath: Schema.String,
  gitCommonDirectory: Schema.String,
  image: Schema.String,
  worktreePath: Schema.String,
  uid: Schema.Int,
  gid: Schema.Int,
}) {}
