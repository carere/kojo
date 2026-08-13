import { execFileSync } from "node:child_process";

/**
 * The one image the container tests run in, built here rather than assumed.
 *
 * Sandcastle's Docker provider does two things before it starts anything: it resolves the image
 * name — `sandcastle:<repo-directory>` unless told otherwise — and it fails with *"Image not found
 * locally. Build it first"* when that image is absent. A suite that relied on the default would
 * pass on the machine of whoever last ran `sandcastle docker build-image` and fail everywhere else,
 * so the image is named explicitly and built from four lines.
 *
 * Three things the image must have, and it is a short list because Kojo asks a container for very
 * little: a shell, a long-running entrypoint (`docker run -d` with no command exits immediately on
 * an image whose CMD is an interactive shell), and a writable `/home/agent`, which is the `HOME` the
 * provider stamps on every container it starts.
 *
 * `git` is deliberately **not** installed. Kojo reads the worktree with *host* git — see
 * `SandcastleSandboxSource.worktree` — and a bind-mount workspace runs on the host too, so an image
 * that carried git would let a mistake about which side a command runs on pass unnoticed.
 */
export const testImage = "kojo-test:sandbox";

const dockerfile = [
  "FROM alpine:3.20",
  "RUN mkdir -p /home/agent && chmod 777 /home/agent",
  'CMD ["sleep", "infinity"]',
  "",
].join("\n");

/** Why the container tests cannot run here, or nothing when they can. */
export type ImageStatus = { readonly ok: true } | { readonly ok: false; readonly reason: string };

let decided: ImageStatus | undefined;

/**
 * Builds the image if it is not already there, once per process.
 *
 * Returns a reason rather than throwing, so a suite can say out loud that it is skipping and why.
 * A container test that vanishes silently is the failure this repository has written down twice.
 */
export const ensureImage = (): ImageStatus => {
  if (decided !== undefined) return decided;

  decided = ((): ImageStatus => {
    try {
      execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
    } catch (cause) {
      return { ok: false, reason: `no Docker daemon: ${(cause as Error).message.split("\n")[0]}` };
    }

    try {
      execFileSync("docker", ["image", "inspect", testImage], { stdio: "pipe" });
      return { ok: true };
    } catch {
      // Not built yet. `docker build -` reads the Dockerfile from stdin, so nothing is written to
      // the repository and nothing has to be cleaned up.
    }

    try {
      execFileSync("docker", ["build", "--quiet", "--tag", testImage, "-"], {
        input: dockerfile,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { ok: true };
    } catch (cause) {
      return {
        ok: false,
        reason: `could not build ${testImage}: ${(cause as Error).message.split("\n")[0]}`,
      };
    }
  })();

  return decided;
};

/** Every container Sandcastle has left behind. Empty is the assertion a suspension makes. */
export const sandcastleContainers = (): ReadonlyArray<string> =>
  execFileSync(
    "docker",
    ["ps", "--all", "--filter", "name=^sandcastle-", "--format", "{{.Names}}"],
    {
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter((name) => name.trim() !== "");
