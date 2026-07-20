import { Effect } from "effect";
import { runProcess, runRequired, runText } from "../../shared/process";
import { WorkflowError } from "../../types/errors";
import type { DockerRunInput } from "../../types/preview";
import {
  BRANCH_LABEL,
  CONTAINER_PATH,
  CONTAINER_PORT,
  CONTAINER_WORKSPACE,
  HOSTNAME_LABEL,
  PREVIEW_LABEL,
  PREVIEW_LOG,
  REPOSITORY_LABEL,
  WORKTREE_LABEL,
} from "./constants";

export const buildDockerRunArguments = (input: DockerRunInput) => [
  "run",
  "--detach",
  "--init",
  "--name",
  input.identity.containerName,
  "--label",
  `${PREVIEW_LABEL}=true`,
  "--label",
  `${REPOSITORY_LABEL}=${input.identity.repositoryId}`,
  "--label",
  `${BRANCH_LABEL}=${input.identity.branch}`,
  "--label",
  `${HOSTNAME_LABEL}=${input.identity.hostname}`,
  "--label",
  `${WORKTREE_LABEL}=${input.worktreePath}`,
  "--env",
  "HOME=/home/agent",
  "--env",
  `PATH=${CONTAINER_PATH}`,
  "--user",
  `${input.uid}:${input.gid}`,
  "--workdir",
  CONTAINER_WORKSPACE,
  "--volume",
  `${input.worktreePath}:${CONTAINER_WORKSPACE}`,
  "--volume",
  `${input.envExamplePath}:${CONTAINER_WORKSPACE}/.sandcastle/.env:ro`,
  "--volume",
  `${input.gitCommonDirectory}:${input.gitCommonDirectory}:ro`,
  "--publish",
  `127.0.0.1::${CONTAINER_PORT}`,
  input.image,
];

export const parsePublishedPort = Effect.fn("parsePublishedPort")(function* (output: string) {
  const match = output.trim().match(/:(\d+)$/m);
  const port = match?.[1];
  if (!port) {
    return yield* new WorkflowError({
      message: `Docker returned an invalid port mapping: ${output.trim()}`,
      operation: "preview.parsePublishedPort",
    });
  }
  return Number(port);
});

export const assertDockerIsReady = Effect.fn("assertDockerIsReady")(function* () {
  const result = yield* runProcess(["docker", "info", "--format", "{{.ServerVersion}}"]);
  if (result.exitCode !== 0) {
    return yield* new WorkflowError({
      message: `Docker is unavailable: ${result.stderr.trim() || result.stdout.trim()}`,
      operation: "preview.assertDockerIsReady",
    });
  }
});

export const resolvePreviewImage = Effect.fn("resolvePreviewImage")(function* (
  image: string,
  expectedUid: number,
) {
  const listed = yield* runProcess([
    "docker",
    "image",
    "ls",
    "--quiet",
    "--no-trunc",
    "--filter",
    `reference=${image}`,
  ]);
  const imageId = listed.stdout.trim().split("\n")[0];
  if (listed.exitCode !== 0 || !imageId) {
    return yield* new WorkflowError({
      message: `Preview image '${image}' is missing. Build it with 'moon run sandcastle:build-image'.`,
      operation: "preview.resolvePreviewImage",
    });
  }

  const inspected = yield* runText([
    "docker",
    "image",
    "inspect",
    imageId,
    "--format",
    "{{.Config.User}}",
  ]);
  const imageUid = Number.parseInt(inspected.split(":")[0] ?? "", 10);
  if (Number.isFinite(imageUid) && imageUid !== expectedUid) {
    return yield* new WorkflowError({
      message: `Preview image '${image}' was built for UID ${imageUid}, but this user is UID ${expectedUid}. Rebuild it with 'moon run sandcastle:build-image'.`,
      operation: "preview.resolvePreviewImage",
    });
  }

  return imageId;
});

export const inspectContainer = Effect.fn("inspectContainer")(function* (containerName: string) {
  const inspected = yield* runProcess([
    "docker",
    "container",
    "inspect",
    "--format",
    "{{.State.Running}}",
    containerName,
  ]);
  if (inspected.exitCode !== 0) return undefined;
  return inspected.stdout.trim() === "true";
});

export const removeContainer = Effect.fn("removeContainer")(function* (containerName: string) {
  const removed = yield* runProcess(["docker", "container", "rm", "--force", containerName]);
  if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) {
    return yield* new WorkflowError({
      message: `Failed to remove preview container: ${removed.stderr.trim()}`,
      operation: "preview.removeContainer",
    });
  }
});

export const previewPort = Effect.fn("previewPort")(function* (containerName: string) {
  const output = yield* runText(["docker", "port", containerName, `${CONTAINER_PORT}/tcp`]);
  return yield* parsePublishedPort(output);
});

export const mountedPreviewWorktree = Effect.fn("mountedPreviewWorktree")(function* (
  containerName: string,
) {
  return yield* runText([
    "docker",
    "container",
    "inspect",
    "--format",
    `{{range .Mounts}}{{if eq .Destination "${CONTAINER_WORKSPACE}"}}{{.Source}}{{end}}{{end}}`,
    containerName,
  ]);
});

export const previewRevision = Effect.fn("previewRevision")(function* (containerName: string) {
  return yield* runText([
    "docker",
    "exec",
    "--workdir",
    CONTAINER_WORKSPACE,
    containerName,
    "/usr/bin/git",
    "rev-parse",
    "HEAD",
  ]);
});

export const findMoonExecutable = Effect.fn("findMoonExecutable")(function* (
  containerName: string,
) {
  const executable = yield* runText([
    "docker",
    "exec",
    containerName,
    "sh",
    "-c",
    "find /home/agent/.proto/tools/moon -mindepth 2 -maxdepth 2 -type f -name moon -print -quit",
  ]);
  if (!executable) {
    return yield* new WorkflowError({
      message: "Moon is not installed in the Sandcastle image. Rebuild the image.",
      operation: "preview.findMoonExecutable",
    });
  }
  return executable;
});

export const readPreviewLogs = Effect.fn("readPreviewLogs")(function* (containerName: string) {
  const result = yield* runProcess([
    "docker",
    "exec",
    containerName,
    "sh",
    "-c",
    `if [ -f ${PREVIEW_LOG} ]; then tail -n 80 ${PREVIEW_LOG}; fi`,
  ]);
  return result.stdout.trim() || result.stderr.trim();
});

export const runDocker = (args: ReadonlyArray<string>, inheritOutput = false) =>
  runRequired(["docker", ...args], undefined, inheritOutput);
