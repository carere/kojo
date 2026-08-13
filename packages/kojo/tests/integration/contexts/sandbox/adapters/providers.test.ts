import { describe, expect, it } from "@effect/vitest";
import * as providers from "../../../../../src/contexts/sandbox/adapters/providers.ts";
import type {
  SandboxKind,
  SandboxProvider,
} from "../../../../../src/contexts/sandbox/models/SandboxProvider.ts";

/**
 * Sandcastle's own dispatch tag, which its published types do not carry.
 *
 * Reading it needs a cast, and that cast is the point of this test rather than a shortcut around
 * the types: the value is there at runtime and every internal gate in Sandcastle switches on it, so
 * the one thing Kojo can do is check that its own declaration agrees. If a future release renames a
 * tag, this fails here instead of failing as a session that silently never resumes.
 */
const sandcastleTag = (provider: SandboxProvider): string | undefined =>
  (provider.sandcastle as { readonly tag?: string }).tag;

describe("the provider factories", () => {
  it("declares the kind Sandcastle itself dispatches on", () => {
    const rows: ReadonlyArray<readonly [SandboxProvider, SandboxKind]> = [
      [providers.docker(), "bind-mount"],
      [providers.podman(), "bind-mount"],
      [providers.vercel(), "isolated"],
      [providers.daytona(), "isolated"],
      [providers.noSandbox(), "none"],
    ];

    for (const [provider, kind] of rows) {
      expect([provider.name, provider.capabilities.kind]).toEqual([provider.name, kind]);
      expect([provider.name, sandcastleTag(provider)]).toEqual([provider.name, kind]);
    }
  });

  it("threads a run's environment by constructing the provider", () => {
    // `CreateSandboxOptions` has no `env`, alone among Sandcastle's entry points, so this is the
    // only door a run id fits through.
    const provider = providers.docker({
      imageName: "kojo:hotfix",
      env: { KOJO_RUN_ID: "run_42", KOJO_PHASE_ID: "phase_7" },
    });

    expect(provider.sandcastle.env).toEqual({ KOJO_RUN_ID: "run_42", KOJO_PHASE_ID: "phase_7" });
  });

  it("builds a fresh provider per call, so two runs cannot share one environment", () => {
    const first = providers.docker({ env: { KOJO_RUN_ID: "run_1" } });
    const second = providers.docker({ env: { KOJO_RUN_ID: "run_2" } });

    expect([first.sandcastle.env, second.sandcastle.env]).toEqual([
      { KOJO_RUN_ID: "run_1" },
      { KOJO_RUN_ID: "run_2" },
    ]);
  });

  it("names the provider the way Sandcastle names it", () => {
    expect(providers.noSandbox().name).toBe("no-sandbox");
    expect(providers.vercel().name).toBe("vercel");
  });
});
