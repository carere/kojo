import type { SandboxHooks as SandcastleHooks } from "@ai-hero/sandcastle";
import { describe, expect, it } from "@effect/vitest";
import type { SandboxHooks } from "../../../../../src/contexts/sandbox/models/SandboxHooks.ts";

const hooks = {
  host: {
    onWorktreeReady: [{ command: "cp .kojo/.env .env" }],
    onSandboxReady: [{ command: "docker image inspect kojo:hotfix", timeoutMs: 5_000 }],
  },
  sandbox: {
    onSandboxReady: [{ command: "bun install", sudo: false, timeoutMs: 120_000 }],
  },
} satisfies SandboxHooks;

// The assertion is the annotation, and `bun tsc` is what checks it: Kojo's hooks reach Sandcastle
// as they are. A slot that moves upstream stops compiling here rather than failing at a container.
const asSandcastleWrites: SandcastleHooks = hooks;

describe("sandbox hooks", () => {
  it("fills the three slots that exist", () => {
    expect(Object.keys(hooks.host)).toEqual(["onWorktreeReady", "onSandboxReady"]);
    expect(Object.keys(hooks.sandbox)).toEqual(["onSandboxReady"]);
    expect(asSandcastleWrites).toBe(hooks);
  });

  it("has no fourth slot", () => {
    const impossible = {
      sandbox: {
        // There is no moment at which the worktree is ready and a sandbox already exists to run a
        // command in, so Sandcastle has no such slot. A `hooks` type modelled as
        // {host,sandbox} × {onWorktreeReady,onSandboxReady} would accept this line and then fail
        // to compile at the boundary, one file away from the mistake.
        // @ts-expect-error
        onWorktreeReady: [{ command: "bun install" }],
      },
    } satisfies SandboxHooks;

    expect(impossible).toBeDefined();
  });

  it("offers sudo only where a sandbox can grant it", () => {
    const hostSide = {
      // `sudo` belongs to a command running inside the sandbox. The host runs as whoever started
      // the run, and asking for it there names a privilege nobody can hand out.
      // @ts-expect-error
      host: { onWorktreeReady: [{ command: "apt-get install -y git", sudo: true }] },
    } satisfies SandboxHooks;

    expect(hostSide).toBeDefined();
  });
});
