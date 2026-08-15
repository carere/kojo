import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The package's only entry point for its core types and its stock agent providers, as
// `models/SandboxProvider.ts` records. The provider factories go through `./sandboxes/*` subpaths.
import * as sandcastle from "@ai-hero/sandcastle";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { kojoPi } from "../../../../../src/contexts/agent/adapters/kojoPi.ts";
import {
  encodePiSessionDirectory,
  piSessionsSegments,
} from "../../../../../src/contexts/agent/services/piSession.ts";
import { piSessionStorage } from "../../../../../src/contexts/sandbox/adapters/boundary.ts";
import { type LocalBindMount, localBindMount } from "../../../../support/localBindMountHandle.ts";

const call = (over?: Partial<sandcastle.AgentCommandOptions>): sandcastle.AgentCommandOptions => ({
  prompt: "Fix the failing test",
  dangerouslySkipPermissions: true,
  ...over,
});

const session = "01J8VQ2N";

describe("the identity kojoPi puts on the command line", () => {
  const full = kojoPi({
    model: "claude-sonnet-4-6",
    system: "You are the scout. Report what you find and change nothing.",
    tools: ["read", "grep", "find", "ls"],
    extensions: ["./ext/tracker.ts", "npm:@kojo/pi-trace"],
    thinking: "high",
  });

  it("carries the system prompt, the tool allowlist, and the extensions", () => {
    const { command, stdin } = full.buildPrintCommand(call());

    // The three things the stock provider drops. Each one changes what the agent is.
    expect(command).toContain(
      "--system-prompt 'You are the scout. Report what you find and change nothing.'",
    );
    expect(command).toContain("--tools 'read,grep,find,ls'");
    expect(command).toContain("--extension './ext/tracker.ts'");
    expect(command).toContain("--extension 'npm:@kojo/pi-trace'");
    expect(command).toContain("--thinking 'high'");
    expect(command.startsWith("pi -p --mode json --model 'claude-sonnet-4-6'")).toBe(true);
    expect(stdin).toBe("Fix the failing test");
  });

  it("is exactly what the stock provider drops, measured against it", () => {
    const stock = sandcastle.pi("claude-sonnet-4-6", { thinking: "high" });
    const dropped = stock.buildPrintCommand(call());

    for (const flag of ["--system-prompt", "--tools", "--extension"]) {
      expect([flag, dropped.command.includes(flag)]).toEqual([flag, false]);
      expect([flag, full.buildPrintCommand(call()).command.includes(flag)]).toEqual([flag, true]);
    }
  });

  it("keeps the prompt on stdin, never in argv", () => {
    // A prompt carries an envelope's JSON Schema and often a diff. Linux caps one argument at
    // 128 KB, which is the reason Sandcastle put a `stdin` field on `PrintCommand` at all.
    const long = "x".repeat(200_000);
    const built = full.buildPrintCommand(call({ prompt: long }));

    expect(built.stdin).toBe(long);
    expect(built.command).not.toContain(long);
  });

  it("quotes a system prompt that is prose rather than a token", () => {
    const awkward = kojoPi({
      model: "m",
      system: 'Don\'t run `rm -rf $HOME`; say "no" instead.',
    });
    const { command } = awkward.buildPrintCommand(call());

    // Close-reopen quoting: the apostrophe ends the quoted run and a literal one is spliced in.
    expect(command).toContain(
      `--system-prompt 'Don'\\''t run \`rm -rf $HOME\`; say "no" instead.'`,
    );
  });

  it("passes no tool flag when the roster names no tools, which means pi's own default set", () => {
    const bare = kojoPi({ model: "m", tools: [] });
    expect(bare.buildPrintCommand(call()).command).not.toContain("--tools");
  });

  it("names itself pi, because pi is the binary that runs", () => {
    expect(full.name).toBe("pi");
    expect(full.captureSessions).toBe(true);
    expect(kojoPi({ model: "m", captureSessions: false }).captureSessions).toBe(false);
    expect(kojoPi({ model: "m", env: { KOJO_RUN_ID: "run_7" } }).env).toEqual({
      KOJO_RUN_ID: "run_7",
    });
  });

  it("keeps the identity in an interactive session too", () => {
    const args = full.buildInteractiveArgs?.(call()) ?? [];

    expect(args.slice(0, 3)).toEqual(["pi", "--model", "claude-sonnet-4-6"]);
    expect(args).toContain("--system-prompt");
    expect(args).toContain("read,grep,find,ls");
    // An argv needs no quoting, so the prompt is the value the agent reads.
    expect(args[args.length - 1]).toBe("Fix the failing test");
  });
});

describe("re-entering a pi session, and branching off one", () => {
  const provider = kojoPi({ model: "m" });

  it("resumes with --session", () => {
    const { command } = provider.buildPrintCommand(call({ resumeSession: session }));

    expect(command).toContain(`--session '${session}'`);
    expect(command).not.toContain("--fork");
  });

  it("forks with --fork, which replaces --session rather than joining it", () => {
    // pi spells fork as its own flag taking the id. The stock provider reads `forkSession` and
    // emits nothing for it, so a fan-out asking for a fork silently mutated the parent transcript.
    const { command } = provider.buildPrintCommand(
      call({ resumeSession: session, forkSession: true }),
    );

    expect(command).toContain(`--fork '${session}'`);
    expect(command).not.toContain("--session ");
  });

  it("is what the stock provider drops on the floor", () => {
    const stock = sandcastle.pi("m");
    const dropped = stock.buildPrintCommand(call({ resumeSession: session, forkSession: true }));

    expect(dropped.command).toContain(`--session '${session}'`);
    expect(dropped.command).not.toContain("--fork");
  });

  it("opens a cold session when none is named", () => {
    const { command } = provider.buildPrintCommand(call());

    expect(command).not.toContain("--session");
    expect(command).not.toContain("--fork");
  });

  it("passes --session-dir only when a sandbox root is chosen", () => {
    expect(provider.buildPrintCommand(call()).command).not.toContain("--session-dir");
    expect(
      kojoPi({ model: "m", sessions: { sandbox: "/srv/sessions" } }).buildPrintCommand(call())
        .command,
    ).toContain("--session-dir '/srv/sessions'");
  });
});

describe("the stream parser kojoPi reuses", () => {
  const provider = kojoPi({ model: "claude-sonnet-4-6" });
  const stock = sandcastle.pi("claude-sonnet-4-6");

  /**
   * The return type is not exported, so it is read back off the interface.
   *
   * `ReturnType<AgentProvider["parseStreamLine"]>` is the only name for it, and a test that typed
   * these as `unknown` would not notice the shape changing.
   */
  type Events = ReturnType<sandcastle.AgentProvider["parseStreamLine"]>;

  const lines: ReadonlyArray<readonly [string, Events]> = [
    [
      JSON.stringify({ type: "session", id: session }),
      [{ type: "session_id", sessionId: session }],
    ],
    [
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      }),
      [{ type: "text", text: "hello" }],
    ],
    [
      JSON.stringify({ type: "tool_execution_start", toolName: "Bash", args: { command: "ls" } }),
      [{ type: "tool_call", name: "Bash", args: "ls" }],
    ],
    ["not json at all", []],
  ];

  it("parses what pi emits, event for event", () => {
    for (const [line, expected] of lines) {
      expect([line, provider.parseStreamLine(line)]).toEqual([line, expected]);
    }
  });

  it("gives the same answer as the instance it borrows it from", () => {
    // Reuse rather than reimplementation: the two agree line for line, so an upstream fix to pi's
    // parser is a fix here and never a divergence to discover in a trace.
    for (const [line] of lines) {
      expect([line, provider.parseStreamLine(line)]).toEqual([line, stock.parseStreamLine(line)]);
    }
  });
});

describe("the providers whose session helpers are already public", () => {
  it("carry their own session storage, so Kojo uses them unmodified", () => {
    expect(sandcastle.claudeCode("claude-opus-4-5").sessionStorage).toBeDefined();
    expect(sandcastle.codex("gpt-5.4").sessionStorage).toBeDefined();
  });

  it("publish the helpers under that storage, and pi publishes none of its", () => {
    // This asymmetry is the whole reason `piSessionStorage` exists. When upstream publishes pi's
    // helpers, this test fails and Kojo's copy can be deleted rather than quietly kept forever.
    const published = sandcastle as unknown as Record<string, unknown>;

    for (const helper of [
      "encodeProjectPath",
      "claudeHostSessionPath",
      "claudeSandboxSessionPath",
      "findClaudeSessionOnHost",
      "transferClaudeSession",
      "findCodexSessionOnHost",
      "transferCodexSession",
    ]) {
      expect([helper, typeof published[helper]]).toEqual([helper, "function"]);
    }

    for (const missing of [
      "makePiSessionStorage",
      "encodePiSessionDir",
      "piSessionDirPath",
      "findPiSessionOnHost",
      "transferPiSession",
    ]) {
      expect([missing, published[missing]]).toEqual([missing, undefined]);
    }
  });
});

/**
 * **Every root in this suite is named, so every layout here is flat** — ticket 56.
 *
 * `localBindMount` stands a sandbox up in a temporary directory, so the "sandbox" sessions root is
 * a real host path and has to be given. Naming it is what makes `kojoPi` pass `--session-dir`, and
 * pi's own `SessionManager.create` reads
 * `sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)` — so pi writes straight into
 * that root and encodes nothing.
 *
 * These tests used to expect an encoded subdirectory under a named root, which is a layout pi never
 * produces. They passed, because both sides of the assertion were Kojo's own encoding. The suite
 * below now grades pi's behaviour instead of Kojo's assumption, and the encoded half is graded in
 * *finding a transcript pi wrote, without pi*.
 */
describe("capturing a pi transcript to the host and putting it back", () => {
  let mount: LocalBindMount;
  let hostRoot: string;
  let hostCwd: string;

  /** The worktree path as the agent saw it from inside the sandbox. Never the host's own. */
  const sandboxCwd = "/repo";

  const transcript = (cwd: string) =>
    [
      JSON.stringify({ type: "session", id: session, cwd }),
      JSON.stringify({ type: "message", role: "user", content: "fix the test" }),
    ].join("\n");

  const fileName = `2026-08-10T09-14-00_${session}.jsonl`;

  const storage = () => piSessionStorage({ host: hostRoot, sandbox: join(mount.root, "sessions") });

  beforeEach(async () => {
    mount = await localBindMount();
    hostRoot = await mkdtemp(join(tmpdir(), "kojo-pi-host-"));
    hostCwd = await mkdtemp(join(tmpdir(), "kojo-pi-worktree-"));

    // What pi leaves behind inside the sandbox: one transcript, straight in the root it was given.
    const directory = join(mount.root, "sessions");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, fileName), transcript(sandboxCwd));
  });

  afterEach(async () => {
    await mount.handle.close();
    await rm(hostRoot, { recursive: true, force: true });
    await rm(hostCwd, { recursive: true, force: true });
  });

  it("lands the transcript in the host root, which is the only place pi looks", async () => {
    await storage().captureToHost({
      hostCwd,
      sandboxCwd,
      sessionId: session,
      handle: mount.handle,
    });

    const landed = join(hostRoot, fileName);
    // The rewritten session line carries the **resolved** host cwd, because that is what pi's own
    // `process.cwd()` will report the next time it runs there — `/private/var/...`, not `/var/...`.
    expect(await readFile(landed, "utf-8")).toBe(transcript(realpathSync(hostCwd)));

    // Nothing was scattered anywhere else under the root, and no encoded directory was invented.
    expect(await readdir(hostRoot)).toEqual([fileName]);
  });

  it("reports the session as captured, for any cwd, because a named root is one directory", async () => {
    const captured = storage();
    await captured.captureToHost({
      hostCwd,
      sandboxCwd,
      sessionId: session,
      handle: mount.handle,
    });

    expect(await captured.existsOnHost(hostCwd, session)).toBe(true);

    // **Under a named root the cwd does not discriminate, and that is correct rather than sloppy.**
    // pi resolves `--session <id>` against the whole of `--session-dir`, so a transcript in it is a
    // transcript pi will find whatever directory it is run from. Reporting `false` for another cwd
    // would be Kojo answering about its own encoding rather than about pi. The encoded layout, where
    // the cwd *does* discriminate, is graded in the suite below.
    expect(await captured.existsOnHost("/some/other/worktree", session)).toBe(true);

    // The id still discriminates, which is the half that has to keep working.
    expect(await captured.existsOnHost(hostCwd, "01J-NOT-A-SESSION")).toBe(false);

    expect(await captured.readHostSession(hostCwd, session)).toBe(
      transcript(realpathSync(hostCwd)),
    );
    expect(await captured.readHostSession(hostCwd, "01J-NOT-A-SESSION")).toBeUndefined();
    expect(captured.hostSessionFilePath(hostCwd, session)).toBe(hostRoot);
  });

  it("finds the transcript by id alone, and says where it looked when it cannot", async () => {
    const captured = storage();
    await captured.captureToHost({
      hostCwd,
      sandboxCwd,
      sessionId: session,
      handle: mount.handle,
    });

    expect(await captured.findByIdOnHost(session)).toEqual({
      path: join(hostRoot, fileName),
      searchedRoot: hostRoot,
    });
    expect(await captured.findByIdOnHost("01J-NOT-A-SESSION")).toEqual({
      path: undefined,
      searchedRoot: hostRoot,
    });
  });

  it("puts it back under the rebuilt sandbox's own cwd, not the one it was captured from", async () => {
    const captured = storage();
    await captured.captureToHost({
      hostCwd,
      sandboxCwd,
      sessionId: session,
      handle: mount.handle,
    });

    // A replayed run gets a fresh worktree, and Sandcastle may mount it somewhere else. The
    // transcript has to follow it, or pi resolves the id against a directory that holds nothing.
    const rebuilt = "/workspace/repo";
    await captured.resumeIntoSandbox({
      hostCwd,
      sandboxCwd: rebuilt,
      sessionId: session,
      handle: mount.handle,
    });

    const restored = join(mount.root, "sessions", fileName);
    expect(await readFile(restored, "utf-8")).toBe(transcript(rebuilt));
  });

  it("refuses rather than inventing a transcript that is not there", async () => {
    const captured = storage();

    await expect(
      captured.captureToHost({
        hostCwd,
        sandboxCwd,
        sessionId: "01J-NOT-A-SESSION",
        handle: mount.handle,
      }),
    ).rejects.toThrow(/is not under .* in the sandbox/);

    await expect(
      captured.resumeIntoSandbox({
        hostCwd,
        sandboxCwd,
        sessionId: "01J-NOT-A-SESSION",
        handle: mount.handle,
      }),
    ).rejects.toThrow(/is not under .* on the host/);
  });

  it("is the storage kojoPi hands Sandcastle, built from the same roots", async () => {
    const provider = kojoPi({
      model: "m",
      sessions: { host: hostRoot, sandbox: join(mount.root, "sessions") },
    });

    await provider.sessionStorage.captureToHost({
      hostCwd,
      sandboxCwd,
      sessionId: session,
      handle: mount.handle,
    });

    expect(await provider.sessionStorage.existsOnHost(hostCwd, session)).toBe(true);
  });
});

/**
 * **Ticket 56's own criterion: write the file the way pi writes it, and ask Kojo to find it.**
 *
 * No pi process, no model, no bill — and it is the test that would have caught the fault. The old
 * code passed `--session-dir` *and* read an encoded subdirectory under it, and every existing test
 * agreed with it because both sides of the assertion were Kojo's own encoding. Here the file is
 * placed by hand, in the place pi's source says pi places it, and Kojo is asked the question a
 * resume asks.
 *
 * The two layouts come from one flag, read off pi 0.80.10's `SessionManager.create`:
 *
 *     const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)
 */
describe("finding a transcript pi wrote, without pi", () => {
  const session = "01JPI56";
  const fileName = `2026-08-14T15-48-44-573Z_${session}.jsonl`;
  const body = JSON.stringify({ type: "session", id: session, cwd: "/x" });

  let root: string;
  let worktree: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kojo-pi-find-"));
    worktree = await mkdtemp(join(tmpdir(), "kojo-pi-cwd-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  });

  it("finds it flat under a root Kojo named, because that is where --session-dir puts it", async () => {
    await writeFile(join(root, fileName), body);

    // A named sandbox root is what makes `kojoPi` pass the flag, so both sides go flat.
    const storage = piSessionStorage({ host: root, sandbox: "/home/agent/sessions" });

    expect(await storage.existsOnHost(worktree, session)).toBe(true);
    expect(await storage.readHostSession(worktree, session)).toBe(body);
    expect(await storage.findByIdOnHost(session)).toEqual({
      path: join(root, fileName),
      searchedRoot: root,
    });
  });

  it("finds it under the encoded cwd when Kojo named no root, which is pi's own default", async () => {
    // pi encodes what its own `process.cwd()` reports, and on macOS that is the resolved path.
    const asPiSeesIt = realpathSync(worktree);
    const directory = join(root, encodePiSessionDirectory(asPiSeesIt));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, fileName), body);

    // No `sandbox` root, so no `--session-dir`, so pi's own encoded layout. `host` only moves where
    // Kojo reads; it does not change what pi did.
    const storage = piSessionStorage({ host: root });

    expect(await storage.existsOnHost(worktree, session)).toBe(true);
    expect(await storage.findByIdOnHost(session)).toEqual({
      path: join(directory, fileName),
      searchedRoot: root,
    });

    // And here the cwd *does* discriminate, which is the difference between the two layouts.
    expect(await storage.existsOnHost("/some/other/worktree", session)).toBe(false);
  });

  /**
   * **The macOS trap, end to end.**
   *
   * `mkdtemp` hands back `/var/folders/…` and pi, running there, reports `/private/var/folders/…`.
   * The transcript is written under the name pi would use; Kojo is asked with the name it was
   * handed. Before `onHost` resolved the path, these were two directories and the answer was `false`
   * — a resume that silently started cold.
   */
  it("finds it when asked with the unresolved twin of the directory pi recorded", async () => {
    // **The symlink is built here rather than borrowed from the platform.** macOS hands `/var` back
    // as a symlink to `/private/var`, so `mkdtemp` alone used to produce this case — and the test
    // asserted that it had, which made it pass on a Mac and fail on the first Linux runner, where
    // a temp directory is its own real path. The fault being graded is Kojo's, not the operating
    // system's, so the two spellings of one directory are made on purpose.
    const real = join(worktree, "real");
    const twin = join(worktree, "twin");
    await mkdir(real, { recursive: true });
    await symlink(real, twin);

    // Resolved on both sides: on macOS the temp root is itself a symlink, so the directory just
    // created is already spelled two ways before this test adds a third.
    const asPiSeesIt = realpathSync(twin);
    expect(asPiSeesIt).toBe(realpathSync(real));
    expect(asPiSeesIt).not.toBe(twin);

    const directory = join(root, encodePiSessionDirectory(asPiSeesIt));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, fileName), body);

    const storage = piSessionStorage({ host: root });

    // Asked with the name the caller was handed; answered about the directory pi recorded.
    expect(await storage.existsOnHost(twin, session)).toBe(true);
    expect(storage.hostSessionFilePath(twin, session)).toBe(directory);
  });

  it("names pi's own sessions root when Kojo names none at all", () => {
    // Not a filesystem assertion — the default must stay `~/.pi/agent/sessions`, and a test that
    // wrote there would write into whoever is running it.
    expect(piSessionsSegments.join("/")).toBe(".pi/agent/sessions");
  });
});
