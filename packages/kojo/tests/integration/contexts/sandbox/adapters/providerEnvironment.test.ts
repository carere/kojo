import { execFileSync } from "node:child_process";
import type { AgentProvider } from "@ai-hero/sandcastle";
import { createSandbox, createWorktree } from "@ai-hero/sandcastle";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { noSandbox } from "../../../../../src/contexts/sandbox/adapters/providers.ts";
import { withEnvironment } from "../../../../../src/contexts/sandbox/models/SandboxProvider.ts";

/**
 * Where a run's own environment may come from, and where it may not — measured against Sandcastle
 * 0.12.0 rather than argued from its source.
 *
 * Ticket 17 shipped a claim it could not check: that an agent invocation may override the
 * correlation keys `sandboxed` stamps on the sandbox provider. Wave 5 found the opposite in the
 * source — `mergeProviderEnv` **throws** on any key both providers set — and wrote it down as a
 * warning. This file settles the whole question by running it, because the source told only two
 * thirds of the story:
 *
 * 1. On the entry points that merge an agent provider's env, an overlapping key throws **at run
 *    start**, not at build time. Real, and reproduced below.
 * 2. On those same entry points `RunOptions.env` is spread last and wins. Also real.
 * 3. **Kojo uses neither of them.** `createSandbox` + `sandbox.run()` passes `agentProviderEnv: {}`,
 *    so an agent provider's `env` never reaches the merge at all: it does not throw, and it does not
 *    win — it is dropped, silently. `SandboxRunOptions` has no `env` either. So on Kojo's path the
 *    container's environment is fixed when the container is built, and the only per-invocation door
 *    is an `env NAME=value` prefix on the command line — which is what
 *    `tests/support/InSandboxAgentInvoker.ts` uses and what `lane.test.ts` grades.
 *
 * The agent below is a stub `AgentProvider`: Sandcastle's orchestrator only needs a command to run
 * and a parser for its output, so no model is called and nothing is spent.
 */

/** An agent that prints one variable and calls it an answer. */
const echoing = (env: Record<string, string>): AgentProvider =>
  ({
    name: "echoing",
    env,
    buildPrintCommand: () => ({ command: 'printf %s "$KOJO_RUN_ID"' }),
    parseStreamLine: (line: string) => [{ type: "text" as const, text: line }],
  }) as unknown as AgentProvider;

const inRepository = <A, E>(use: (root: string) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-provider-env-" });
    yield* Effect.sync(() => {
      const git = (args: ReadonlyArray<string>) => execFileSync("git", [...args], { cwd: root });
      git(["init", "--quiet", "--initial-branch=main"]);
      git(["config", "user.name", "Kojo"]);
      git(["config", "user.email", "kojo@example.invalid"]);
      git(["commit", "--quiet", "--allow-empty", "--message", "seed"]);
    });
    return yield* use(root);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/** The sandbox provider as `sandboxed` builds it: the author's, rebuilt with this run's keys. */
const stamped = () => withEnvironment(noSandbox(), { KOJO_RUN_ID: "run-from-sandbox" }).sandcastle;

describe("an agent provider that sets a key the sandbox provider already set", () => {
  it.live("throws at run start on the entry points that merge the two", () =>
    inRepository((root) =>
      Effect.tryPromise({
        try: async () => {
          const worktree = await createWorktree({
            branchStrategy: { type: "branch", branch: "kojo/overlap" },
            cwd: root,
          });
          try {
            await worktree.run({
              agent: echoing({ KOJO_RUN_ID: "run-from-agent" }),
              sandbox: stamped(),
              prompt: "hello",
              logging: { type: "file", path: `${root}/agent.log` },
            });
            return "no throw";
          } finally {
            await worktree.close();
          }
        },
        catch: (cause) => (cause as Error).message,
      }).pipe(
        Effect.flip,
        Effect.map((message) =>
          // The exact sentence, because it is what a factory author will read at three in the
          // morning and the whole point is that it arrives at run start rather than at build time.
          expect(message).toContain(
            "Overlapping env keys between agent provider and sandbox provider: KOJO_RUN_ID",
          ),
        ),
      ),
    ),
  );

  it.live("is dropped without a word on the path Kojo actually uses", () =>
    inRepository((root) =>
      Effect.promise(async () => {
        // `createSandbox` is what `adapters/boundary.ts` calls, and it hard-codes
        // `agentProviderEnv: {}`. So the overlap above cannot happen here — and neither can the
        // override: the agent provider's `env` reaches nothing at all.
        const sandbox = await createSandbox({
          branch: "kojo/kojo-path",
          sandbox: stamped(),
          cwd: root,
        });
        try {
          const result = await sandbox.run({
            agent: echoing({ KOJO_RUN_ID: "run-from-agent" }),
            prompt: "hello",
            logging: { type: "file", path: `${root}/agent.log` },
          });
          return result.stdout.trim();
        } finally {
          await sandbox.close();
        }
      }).pipe(Effect.map((stdout) => expect(stdout).toContain("run-from-sandbox"))),
    ),
  );
});

describe("the option that does override a sandbox provider's environment", () => {
  it.live("wins, because it is spread after both providers", () =>
    inRepository((root) =>
      Effect.promise(async () => {
        const worktree = await createWorktree({
          branchStrategy: { type: "branch", branch: "kojo/override" },
          cwd: root,
        });
        try {
          const result = await worktree.run({
            // No overlap between the two providers, so the merge is allowed to happen at all —
            // and only then does `env` get its say.
            agent: echoing({ AGENT_ONLY: "yes" }),
            sandbox: stamped(),
            prompt: "hello",
            env: { KOJO_RUN_ID: "run-from-run-options" },
            logging: { type: "file", path: `${root}/agent.log` },
          });
          return result.stdout.trim();
        } finally {
          await worktree.close();
        }
      }).pipe(
        Effect.map((stdout) =>
          // Read out of the agent's own process, not out of the options object.
          expect(stdout).toContain("run-from-run-options"),
        ),
      ),
    ),
  );
});
