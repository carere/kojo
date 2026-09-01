import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import {
  type AgentProvider,
  type BindMountSandboxHandle,
  type CreateSandboxOptions,
  createSandbox,
  type IterationResult,
  type Sandbox,
  type SandboxRunResult,
} from "@ai-hero/sandcastle";
import { Effect, type Scope } from "effect";
import {
  isPiSessionFile,
  piSessionSubdirectory,
  piSessionsSegments,
  rewritePiSessionCwd,
  sandboxPiSessionsRoot,
} from "../../agent/services/piSession.ts";
import { ExecResult } from "../models/ExecResult.ts";
import { SandboxError } from "../models/SandboxError.ts";
import type {
  AcquiredSandbox,
  SandboxAgentCall,
  SandboxAgentRun,
} from "../models/SandboxHandle.ts";
import type { SandboxHooks } from "../models/SandboxHooks.ts";
import type { SandboxProvider } from "../models/SandboxProvider.ts";
import type { SandboxResourceObserver } from "../ports/SandboxSource.ts";

/**
 * **The only module in Kojo that holds a `Promise`.**
 *
 * Sandcastle is a promise-based library, and Kojo is an Effect one. The two meet here and nowhere
 * else, so the seam is one file a reader can hold in their head rather than a habit spread through
 * every adapter. `moon run kojo:check-public-types` fails the build if a bare promise reaches the
 * package's published types, which is the same discipline Sandcastle applies to itself in the
 * opposite direction — its build asserts Effect never leaks out.
 *
 * The `@ai-hero/sandcastle` entry point is the only barrel import Kojo makes, because it is the
 * only path the package publishes for `createSandbox`.
 */

/** What a sandbox is asked for. `provider` is Kojo's tagged descriptor, not Sandcastle's value. */
export interface AcquireSandboxOptions {
  /** The branch the worktree is checked out on. The durable state of a run. */
  readonly branch: string;
  /** Where a branch that does not exist yet forks from. Ignored when it already exists. */
  readonly baseBranch?: string;
  readonly provider: SandboxProvider;
  /** The host repo the worktree comes from. Defaults to the process's own directory. */
  readonly cwd?: string;
  readonly hooks?: SandboxHooks;
  /** Paths, relative to the host repo root, copied into the worktree before the sandbox starts. */
  readonly copyToWorktree?: ReadonlyArray<string>;
}

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * `exactOptionalPropertyTypes` is on, so an absent option is absent rather than present-and-
 * undefined. `copyToWorktree` is copied because Sandcastle asks for a mutable array.
 */
const createOptions = (options: AcquireSandboxOptions): CreateSandboxOptions => ({
  branch: options.branch,
  sandbox: options.provider.sandcastle,
  ...(options.baseBranch === undefined ? {} : { baseBranch: options.baseBranch }),
  ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  ...(options.copyToWorktree === undefined ? {} : { copyToWorktree: [...options.copyToWorktree] }),
});

/**
 * What one iteration cost, read off whichever half of Sandcastle reported it.
 *
 * `IterationUsage` splits the input side three ways — fresh, cache-write and cache-read — and all
 * three are input to the model and all three are billed. A `tokensIn` that took only `inputTokens`
 * would read as almost nothing on the second turn of a correction loop, which is exactly the turn
 * somebody is looking at when they ask what a run cost.
 *
 * Usage is absent for a provider that cannot parse it, and absent is not zero — but `AgentAnswer`
 * types the two counts as required numbers, so zero is what a caller gets and the trace's own
 * `contextTokens` stays `undefined` to say the provider reported nothing at all.
 */
const usageOf = (
  iteration: IterationResult | undefined,
): { tokensIn: number; tokensOut: number; contextTokens: number | undefined } => {
  const usage = iteration?.usage;
  if (usage === undefined) return { tokensIn: 0, tokensOut: 0, contextTokens: undefined };
  const tokensIn = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  return { tokensIn, tokensOut: usage.outputTokens, contextTokens: tokensIn + usage.outputTokens };
};

const agentRunOf = (result: SandboxRunResult): SandboxAgentRun => {
  // The last iteration, because `maxIterations` is pinned to one and the last is therefore the
  // only one. `.at(-1)` rather than `[0]` so a future loop reports the turn that just happened.
  const iteration = result.iterations.at(-1);
  return {
    output: result.stdout,
    session: iteration?.sessionId,
    ...usageOf(iteration),
  };
};

const handleOf = (provider: SandboxProvider, sandbox: Sandbox): AcquiredSandbox => ({
  provider: provider.name,
  capabilities: provider.capabilities,
  branch: sandbox.branch,
  worktreePath: sandbox.worktreePath,
  exec: (command, options) =>
    Effect.tryPromise({
      try: () => sandbox.exec(command, options),
      catch: (cause) =>
        new SandboxError({
          operation: "exec",
          target: command,
          reason: reasonOf(cause),
          cause,
        }),
    }).pipe(
      Effect.map(
        (result) =>
          new ExecResult({
            argv: [command],
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }),
      ),
    ),
  agent: (call: SandboxAgentCall) =>
    Effect.tryPromise({
      // `maxIterations: 1` is the whole of D4 at this seam. Sandcastle will happily loop until a
      // completion signal appears in the agent's output; Kojo's phase decodes one answer and
      // corrects it in the author's program, and two loops mean neither can say why a run stopped.
      try: () =>
        sandbox.run({
          agent: call.provider,
          prompt: call.prompt,
          maxIterations: 1,
          ...(call.resumeSession === undefined ? {} : { resumeSession: call.resumeSession }),
        }),
      catch: (cause) =>
        new SandboxError({
          operation: "agent",
          target: call.provider.name,
          reason: reasonOf(cause),
          cause,
        }),
    }).pipe(Effect.map(agentRunOf)),
});

/**
 * Whether this worktree must be kept because nothing can say what is in it — ticket 60.
 *
 * The **same** command Sandcastle's own decision rests on, asked one step earlier and read the
 * opposite way. Sandcastle maps a failure to *clean* and deletes; this maps a failure to *do not
 * touch it*. A worktree that answers — dirty or clean — is released normally and Sandcastle decides
 * as it always did; only the unanswerable case changes hands.
 *
 * Synchronous, and deliberately: it stands inside a finalizer, where an async failure would be a
 * second thing to get wrong at exactly the moment the first thing already went wrong. A directory
 * that is gone is not unreadable — there is nothing there to lose — so that answers `false` and the
 * release proceeds, which keeps the ordinary teardown ordinary.
 */
const worktreeDisposition = (worktreePath: string): "absent" | "clean" | "dirty" | "unreadable" => {
  if (!existsSync(worktreePath)) return "absent";
  const asked = spawnSync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  if (asked.status !== 0) return "unreadable";
  return asked.stdout.trim() === "" ? "clean" : "dirty";
};

/**
 * Acquire a sandbox for the life of the surrounding scope, and release it when the scope closes.
 *
 * Scoped, and that is the whole tear-down-and-rebuild decision. A suspending run is interrupted by
 * the engine, an interrupt unwinds a local scope, and the finalizer below stops the container while
 * git keeps the branch. Replay re-enters the scope and builds the sandbox again from the branch
 * alone. Nothing is held across a two-day gate.
 *
 * **Release is `orDie`.** A teardown that fails is a defect: there is no recovery a workflow author
 * could write, and a run that quietly carried on would be a run holding a container it believes it
 * released. The typed error is still built, so the defect names the branch and the reason.
 *
 * Acquisition is uninterruptible — `acquireRelease`'s default — so an interrupt arriving mid-create
 * cannot leave a container nobody has a handle to.
 *
 * **The release asks one question before it hands over to Sandcastle, and it is ticket 60's.**
 * Sandcastle decides whether to keep the worktree by running `git status --porcelain` in it —
 * wrapped in a `catchAll` that turns *any* failure into "clean" — and then removes a clean one with
 * `git worktree remove --force`. So a repository git cannot read is a repository Sandcastle deletes,
 * uncommitted work and all, and says nothing about.
 *
 * That was recorded as latent until it was made to fire. Measured, on this machine: break the
 * worktree's own registration and both commands fail, so nothing is lost; but make `git status`
 * alone fail — an unreadable index is enough — and **the worktree and the work in it are gone**.
 *
 * So Kojo asks first. `preserveIfUnreadable` runs the same command Sandcastle will and, when it
 * cannot get an answer, does not call `close()` at all. The cost is a leaked worktree and a
 * container that outlives its scope; the alternative is deleted work. `architecture.md` §8 edge 14
 * carries the trade, and it is the one this repository has already made twice — `Permissions.output`
 * treats a failed `git diff` as an error for the same reason, because an empty answer from a failed
 * command reads as *nothing changed*.
 */
export const acquireSandbox = (
  options: AcquireSandboxOptions,
  observer?: SandboxResourceObserver,
): Effect.Effect<AcquiredSandbox, SandboxError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => createSandbox(createOptions(options)),
      catch: (cause) =>
        new SandboxError({
          operation: "create",
          target: options.branch,
          reason: reasonOf(cause),
          cause,
        }),
    }),
    (sandbox) =>
      Effect.gen(function* () {
        yield* observer?.releaseIntent ?? Effect.void;
        const disposition = worktreeDisposition(sandbox.worktreePath);
        if (disposition === "unreadable") {
          yield* observer?.preserved(
            "worktree",
            "host git could not read the worktree, so Kojo did not ask the provider to close it",
          ) ?? Effect.void;
          yield* observer?.unresolved(
            "sandbox",
            "the sandbox was preserved with an unreadable worktree; provider cleanup is not confirmed",
          ) ?? Effect.void;
          return yield* Effect.logWarning(
            `the worktree at ${sandbox.worktreePath} could not be read, so it was left in place ` +
              "rather than released: Sandcastle removes a worktree it reads as clean, and a " +
              "repository git cannot answer about reads as clean. Anything uncommitted there is " +
              "still there. Remove it by hand once you have looked: " +
              `git worktree remove --force ${sandbox.worktreePath}`,
          );
        }
        const closed = yield* Effect.tryPromise({
          try: () => sandbox.close(),
          catch: (cause) =>
            new SandboxError({
              operation: "close",
              target: sandbox.branch,
              reason: reasonOf(cause),
              cause,
            }),
        }).pipe(Effect.result);
        if (closed._tag === "Failure") {
          yield* observer?.unresolved(
            "sandbox",
            "the provider close operation failed; process exit is not cleanup evidence",
          ) ?? Effect.void;
          yield* observer?.unresolved(
            "worktree",
            "the provider close operation failed before worktree disposition was confirmed",
          ) ?? Effect.void;
          return yield* Effect.die(closed.failure);
        }
        yield* observer?.released("sandbox", "the provider close operation completed") ??
          Effect.void;
        if (disposition === "dirty") {
          yield* observer?.preserved(
            "worktree",
            "host git reported uncommitted work, so the provider preserved the worktree",
          ) ?? Effect.void;
        } else {
          yield* observer?.released(
            "worktree",
            disposition === "absent"
              ? "the worktree was already absent after provider close"
              : "the provider removed the clean worktree",
          ) ?? Effect.void;
        }
      }),
  ).pipe(Effect.map((sandbox) => handleOf(options.provider, sandbox)));

/**
 * Sandcastle's session-storage contract, named without being exported.
 *
 * `AgentSessionStorage` is not on the package's export list — only the `AgentProvider` that carries
 * it — so the type is read back off the interface. `NonNullable` because the field is optional:
 * three of Sandcastle's seven agent providers have one, and the type says so.
 */
export type AgentSessionStorage = NonNullable<AgentProvider["sessionStorage"]>;

/** The two roots a pi transcript can live under. Both default to where pi itself puts them. */
export interface PiSessionRoots {
  /** Host sessions root. Defaults to `~/.pi/agent/sessions`. */
  readonly host?: string;
  /** Sandbox sessions root. Defaults to `/home/agent/.pi/agent/sessions`. */
  readonly sandbox?: string;
}

/** A temporary file that exists only for the length of one transfer. */
const throughTemporaryFile = async <A>(
  tag: string,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), `kojo-${tag}-`));
  try {
    return await use(join(directory, "session.jsonl"));
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * pi's half of session capture, which Sandcastle keeps to itself.
 *
 * `makePiSessionStorage` is private, and so is every helper under it — the cwd encoding, the
 * sandbox-side locate, the transfer rewrite. Claude's and Codex's equivalents are public, so
 * `claudeCode()` and `codex()` are used exactly as they ship and only this one is written again.
 *
 * The promises are why it is here rather than beside `kojoPi`. This module is the one place in Kojo
 * that holds them, `AgentSessionStorage` is promise-shaped by definition, and
 * `moon run kojo:check-public-types` is what stops that spreading. The pure half — encoding,
 * matching, rewriting — is `contexts/agent/services/piSession.ts`, and is unit-tested there.
 *
 * **Locate broadly, land precisely.** The sandbox-side search covers the whole sessions root,
 * because the agent may have run in a directory nobody recorded. The host-side write does not: it
 * goes under the encoded *host* cwd and nowhere else, because that is the only directory
 * `pi --session <id>` will look in when the sandbox is rebuilt. `existsOnHost` asks the same narrow
 * question for the same reason — a transcript that is on the host but under the wrong directory is
 * a transcript pi will stop and ask about, and answering "yes, it is captured" would be a lie the
 * run finds out about two days later.
 */
export const piSessionStorage = (roots?: PiSessionRoots): AgentSessionStorage => {
  const hostRoot = roots?.host ?? join(homedir(), ...piSessionsSegments);
  const sandboxRoot = roots?.sandbox ?? sandboxPiSessionsRoot;

  /**
   * **One flag decides the layout on both sides, and it is `--session-dir`.**
   *
   * `kojoPi` passes that flag exactly when `sessions.sandbox` is given, and pi's own
   * `SessionManager.create` reads
   * `sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)`. So a run that named a
   * root gets a flat directory and a run that named none gets pi's encoded one — and it is the
   * same answer wherever pi ran, because the flag travels with the process rather than with the
   * root. `roots.host` moves *where* Kojo reads and writes; it does not change what pi did.
   */
  const rootIsPiDefault = roots?.sandbox === undefined;

  /**
   * A host path as the operating system really spells it, resolved once and in one place.
   *
   * `mkdtemp` hands back `/var/folders/…`; a process started there reports `/private/var/folders/…`,
   * because `/var` is a symlink on macOS. pi encodes what its own `process.cwd()` gives it and
   * resolves nothing — `resolvePath` is `path.resolve`. So without this the two sides name one
   * directory twice and every lookup misses. Measured, not reasoned.
   *
   * A path that cannot be resolved is returned unchanged rather than thrown over: the transcript
   * this asks about may legitimately not exist yet, and the caller's own *file* lookups are what
   * decide that. **Host paths only** — a sandbox cwd names a filesystem this process cannot see, and
   * resolving it here would answer about the host's tree instead.
   */
  const onHost = (cwd: string): string => {
    try {
      return realpathSync(cwd);
    } catch {
      return cwd;
    }
  };

  const hostDirectory = (cwd: string) => {
    const under = piSessionSubdirectory({ cwd: onHost(cwd), rootIsPiDefault });
    return under === undefined ? hostRoot : join(hostRoot, under);
  };

  /** The transcript of one session inside one directory, or nothing. A missing directory is nothing. */
  const fileIn = async (directory: string, sessionId: string): Promise<string | undefined> => {
    const names = await readdir(directory).catch(() => undefined);
    const match = names?.find((name) => isPiSessionFile(name, sessionId));
    return match === undefined ? undefined : join(directory, match);
  };

  /**
   * The same search, over the whole host root: the root itself, then every directory under it.
   *
   * **Both, and not one or the other**, because the layout depends on how pi was started and this
   * search is what a resume falls back on when it does not know. A named root is flat, so the file
   * is in the root; pi's default root is encoded, so it is one level down. Looking only one level
   * down was the old behaviour and it could not find a transcript written under a named root.
   *
   * The id is unique, so the first match is the answer and the order does not matter.
   */
  const anywhereOnHost = async (sessionId: string): Promise<string | undefined> => {
    const inRoot = await fileIn(hostRoot, sessionId);
    if (inRoot !== undefined) return inRoot;
    const entries = await readdir(hostRoot, { withFileTypes: true }).catch(() => undefined);
    for (const entry of entries ?? []) {
      if (!entry.isDirectory()) continue;
      const found = await fileIn(join(hostRoot, entry.name), sessionId);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const inSandbox = async (handle: BindMountSandboxHandle, sessionId: string): Promise<string> => {
    const found = await handle.exec(
      `find ${JSON.stringify(sandboxRoot)} -type f -name ${JSON.stringify(`*_${sessionId}.jsonl`)} -print -quit`,
    );
    const path = found.stdout.trim().split("\n")[0];
    if (found.exitCode !== 0 || path === undefined || path === "") {
      throw new Error(`pi session ${sessionId} is not under ${sandboxRoot} in the sandbox`);
    }
    return path;
  };

  return {
    // Sandcastle reports the *directory*, not the file, because the filename carries a timestamp
    // nobody can reconstruct. It is what a not-found message names, so it stays the directory.
    hostSessionFilePath: (cwd) => hostDirectory(cwd),

    existsOnHost: async (cwd, sessionId) =>
      (await fileIn(hostDirectory(cwd), sessionId)) !== undefined,

    readHostSession: async (cwd, sessionId) => {
      const path = await fileIn(hostDirectory(cwd), sessionId);
      return path === undefined ? undefined : readFile(path, "utf-8");
    },

    findByIdOnHost: async (sessionId) => ({
      path: await anywhereOnHost(sessionId),
      searchedRoot: hostRoot,
    }),

    captureToHost: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const source = await inSandbox(handle, sessionId);
      const jsonl = await throughTemporaryFile("pi-capture", async (temporary) => {
        await handle.copyFileOut(source, temporary);
        return readFile(temporary, "utf-8");
      });
      const target = join(hostDirectory(hostCwd), posix.basename(source));
      await mkdir(dirname(target), { recursive: true });
      // The rewritten `cwd` line is the resolved host path for the same reason the directory is:
      // it is what pi's own `process.cwd()` will say the next time it runs there, and a session
      // line naming the unresolved twin would not match.
      await writeFile(target, rewritePiSessionCwd(jsonl, sandboxCwd, onHost(hostCwd)));
    },

    resumeIntoSandbox: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const source = await anywhereOnHost(sessionId);
      if (source === undefined) {
        throw new Error(`pi session ${sessionId} is not under ${hostRoot} on the host`);
      }
      const jsonl = await readFile(source, "utf-8");
      const under = piSessionSubdirectory({ cwd: sandboxCwd, rootIsPiDefault });
      const target =
        under === undefined
          ? posix.join(sandboxRoot, basename(source))
          : posix.join(sandboxRoot, under, basename(source));
      await throughTemporaryFile("pi-resume", async (temporary) => {
        // From the **resolved** host path, because that is the one `captureToHost` wrote into the
        // session line — and a rewrite whose `from` does not match leaves the line alone, silently,
        // sending the transcript into the sandbox still claiming a directory that is not there.
        await writeFile(temporary, rewritePiSessionCwd(jsonl, onHost(hostCwd), sandboxCwd));
        await handle.exec(`mkdir -p ${JSON.stringify(posix.dirname(target))}`);
        await handle.copyFileIn(temporary, target);
      });
    },
  };
};
