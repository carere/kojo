import {
  type DaytonaOptions,
  daytona as daytonaProvider,
} from "@ai-hero/sandcastle/sandboxes/daytona";
import { type DockerOptions, docker as dockerProvider } from "@ai-hero/sandcastle/sandboxes/docker";
import {
  type NoSandboxOptions,
  noSandbox as noSandboxProvider,
} from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { type PodmanOptions, podman as podmanProvider } from "@ai-hero/sandcastle/sandboxes/podman";
import { type VercelOptions, vercel as vercelProvider } from "@ai-hero/sandcastle/sandboxes/vercel";
import { type SandboxProvider, tagged } from "../models/SandboxProvider.ts";

/**
 * The five providers, each carrying the kind Kojo knows it to be.
 *
 * Every one is a **factory**, and that is not decoration. `CreateSandboxOptions` has no `env` —
 * alone among Sandcastle's entry points — so the only way a run's own environment reaches its
 * sandbox is by building the provider that will create it. A provider held as a module constant
 * would pin one environment for the life of the process; built per run, it carries `KOJO_RUN_ID`
 * and whatever secrets that run is entitled to.
 *
 * The option types are Sandcastle's own, deliberately: they are where `imageName`, `mounts`,
 * `network` and the rest live, and restating them here would only add a place to drift. Two names
 * that surprise people: it is `imageName`, not `image`; and mounts are a provider option, not a
 * sandbox one.
 *
 * `vercel` and `daytona` load their SDKs at creation time rather than at import time, so naming
 * them here costs nothing to a factory that never uses them.
 */
export const docker = (options?: DockerOptions): SandboxProvider =>
  tagged("bind-mount", dockerProvider(options));

export const podman = (options?: PodmanOptions): SandboxProvider =>
  tagged("bind-mount", podmanProvider(options));

export const vercel = (options?: VercelOptions): SandboxProvider =>
  tagged("isolated", vercelProvider(options));

export const daytona = (options?: DaytonaOptions): SandboxProvider =>
  tagged("isolated", daytonaProvider(options));

/**
 * No container at all — the agent runs on the host.
 *
 * Named for what Sandcastle calls it rather than for its kind, because the two are not the same
 * fact: the kind is `"none"`, and a reader who sees only that would conclude the run cannot resume
 * a session. It can. See the matrix in `models/SandboxProvider.ts`.
 */
export const noSandbox = (options?: NoSandboxOptions): SandboxProvider =>
  tagged("none", noSandboxProvider(options));
