import { describe, expect, it } from "@effect/vitest";
import {
  capabilitiesOf,
  type SandboxKind,
  tagged,
} from "../../../../../src/contexts/sandbox/models/SandboxProvider.ts";

/**
 * A provider value with nothing behind it.
 *
 * Sandcastle's three provider shapes are structurally `{ name, env }` plus, on bind mount, an
 * optional home directory — so a literal is a complete stand-in for one, and no real provider is
 * constructed in the unit tier.
 */
const value = (name: string) => ({ name, env: {} });

describe("the sandbox capability matrix", () => {
  it("has three rows, because capture and resume come apart", () => {
    const rows = (["bind-mount", "none", "isolated"] satisfies ReadonlyArray<SandboxKind>).map(
      (kind) => {
        const capabilities = capabilitiesOf(kind);
        return [kind, capabilities.capturesSessions, capabilities.resumesSessions];
      },
    );

    expect(rows).toEqual([
      // The worktree is on the host, so the session file moves both ways.
      ["bind-mount", true, true],
      // The agent writes its session on the host already. Nothing to move, and resume still works —
      // reading this row as "cannot resume" is the mistake it exists to prevent.
      ["none", false, true],
      // No host filesystem, so no transfer, so neither.
      ["isolated", false, false],
    ]);
  });

  it("carries the kind on the capabilities, so a caller cannot read one without the other", () => {
    expect(capabilitiesOf("none").kind).toBe("none");
  });
});

describe("a tagged provider", () => {
  it("takes its name from the provider and its capabilities from Kojo", () => {
    const provider = tagged("bind-mount", value("docker"));

    expect(provider.name).toBe("docker");
    expect(provider.capabilities).toEqual(capabilitiesOf("bind-mount"));
  });

  it("distinguishes two providers that are structurally identical", () => {
    // This is why the tag is Kojo's. Sandcastle strips its own `tag` from the published types, and
    // what is left of an isolated provider and a no-sandbox one is the same shape — so no function
    // over a provider value could tell these two apart, and one of them can resume a session.
    const isolated = tagged("isolated", value("vercel"));
    const none = tagged("none", value("no-sandbox"));

    expect(isolated.capabilities.resumesSessions).toBe(false);
    expect(none.capabilities.resumesSessions).toBe(true);
  });
});
