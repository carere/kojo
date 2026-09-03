// Sandcastle publishes one entry point for its core types, so this is the barrel or nothing. It is
// also the only import in Kojo that may be one: the deep-path rule exists because a barrel can drag
// a runtime the importer never asked for, and `@ai-hero/sandcastle` re-exports nothing heavier than
// the module Kojo already calls. The provider factories go through `./sandboxes/*` subpaths.
import type { SandboxProvider as SandcastleProvider } from "@ai-hero/sandcastle";
import { Schema } from "effect";

/**
 * Where the work runs, as Kojo classifies it.
 *
 * This tag is Kojo's own, and it has to be. Sandcastle dispatches internally on the same three
 * values, but `tag` is stripped from the published types: `IsolatedSandboxProvider` and
 * `NoSandboxProvider` are structurally identical, and `docker()` is typed as the whole union. A
 * provider value therefore carries no capability a type can read, so Kojo attaches the tag at the
 * point the provider is constructed and never tries to recover it afterwards.
 */
export const SandboxKind = Schema.Literals(["bind-mount", "isolated", "none"]);
export type SandboxKind = typeof SandboxKind.Type;

/**
 * What a provider can do for an agent's session — two capabilities, not one.
 *
 * Capture and resume come apart, and the matrix below is why the `AgentInvoker` port must ask
 * rather than assume.
 */
export class SandboxCapabilities extends Schema.Class<SandboxCapabilities>("SandboxCapabilities")({
  kind: SandboxKind,
  /** Whether the agent's session file is pulled back to the host after an iteration. */
  capturesSessions: Schema.Boolean,
  /** Whether a later iteration can continue that session instead of starting cold. */
  resumesSessions: Schema.Boolean,
}) {}

/**
 * Three rows, not two.
 *
 * - **bind-mount** (Docker, Podman) captures and resumes: the worktree is on the host, so the
 *   session file can be moved both ways.
 * - **none** resumes without capturing: the agent runs on the host and writes its session in place,
 *   so there is nothing to move. Capture is skipped because it is unnecessary, not because it is
 *   impossible — reading it as "cannot resume" is the mistake this row exists to prevent.
 * - **isolated** (Vercel, Daytona) does neither: no host filesystem, no transfer.
 *
 * Capture is further limited by the agent provider — only `claudeCode`, `codex`, and `pi` carry a
 * `sessionStorage`. That is the agent context's half of the question; this is the sandbox's.
 */
const matrix: Record<
  SandboxKind,
  { readonly capturesSessions: boolean; readonly resumesSessions: boolean }
> = {
  "bind-mount": { capturesSessions: true, resumesSessions: true },
  none: { capturesSessions: false, resumesSessions: true },
  isolated: { capturesSessions: false, resumesSessions: false },
};

export const capabilitiesOf = (kind: SandboxKind): SandboxCapabilities =>
  new SandboxCapabilities({ kind, ...matrix[kind] });

/**
 * A Sandcastle provider with the tag Kojo needs and the published types do not carry.
 *
 * Built by the factories in `adapters/providers.ts`, one per run: `CreateSandboxOptions` has no
 * `env`, unlike every other Sandcastle entry point, so per-run environment reaches a sandbox only
 * by constructing the provider that will make it.
 */
export interface SandboxProvider {
  /** The provider's own name — `"docker"`, `"vercel"`, `"no-sandbox"`. Recorded on the trace. */
  readonly name: string;
  readonly capabilities: SandboxCapabilities;
  /** The Sandcastle value. Only the boundary reads it. */
  readonly sandcastle: SandcastleProvider;
}

/** Pair a Sandcastle provider with the kind Kojo knows it to be. */
export const tagged = (kind: SandboxKind, sandcastle: SandcastleProvider): SandboxProvider => ({
  name: sandcastle.name,
  capabilities: capabilitiesOf(kind),
  sandcastle,
});

/**
 * The same provider, carrying extra environment into whatever it builds next.
 *
 * `CreateSandboxOptions` has **no `env`** — alone among Sandcastle's entry points — so a run's own
 * correlation and secrets reach a container only through the provider that makes it. A copy rather
 * than a mutation, because the author's provider value may be reused by another lane and a
 * per-acquisition environment must not leak sideways into it.
 *
 * The spread carries the fields the published types do not admit to: Sandcastle's providers are
 * plain object literals holding an internal `tag` and a `create` function, and both survive it. That
 * is also why Kojo keeps its own `capabilities` rather than reading the tag back — see above.
 */
/** @public */
export const withEnvironment = (
  provider: SandboxProvider,
  environment: Record<string, string>,
): SandboxProvider => ({
  ...provider,
  sandcastle: { ...provider.sandcastle, env: { ...provider.sandcastle.env, ...environment } },
});
