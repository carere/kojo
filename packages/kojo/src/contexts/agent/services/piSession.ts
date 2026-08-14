/**
 * Where pi keeps a transcript, and what has to be rewritten when one moves.
 *
 * Sandcastle publishes the Claude and Codex halves of this — `encodeProjectPath`,
 * `claudeHostSessionPath`, `findClaudeSessionOnHost`, `transferClaudeSession`,
 * `findCodexSessionOnHost`, `transferCodexSession` — and publishes **none** of pi's. Nor
 * `makePiSessionStorage`. So the two providers whose helpers are public are used unmodified, and
 * this is the one that has to be written out again.
 *
 * Everything here is pure: strings in, strings out, no filesystem and no sandbox. The half that
 * needs both lives in `contexts/sandbox/adapters/boundary.ts`, because that is the one module in
 * Kojo allowed to hold a promise, and `AgentSessionStorage` is promise-shaped by definition.
 */

/** The layout pi installs itself into: `~/.pi/agent/sessions/<encoded cwd>/<file>.jsonl`. */
export const piSessionsSegments = [".pi", "agent", "sessions"] as const;

/**
 * Where pi keeps sessions inside the image Sandcastle builds for it.
 *
 * `/home/agent` is the home Sandcastle's own pi Dockerfile creates and the default its bind-mount
 * providers report as `sandboxHomedir`. Always POSIX, because the sandbox is Linux whatever the
 * host is.
 */
export const sandboxPiSessionsRoot = `/home/agent/${piSessionsSegments.join("/")}`;

/**
 * The directory name pi derives from a working directory.
 *
 * One leading separator goes, then every separator and every drive colon becomes a hyphen, and the
 * result is fenced in double hyphens: `/Users/ada/kojo` becomes `--Users-ada-kojo--`.
 *
 * **This encoding is the whole ticket.** `pi --session <id>` resolves the id against the encoded
 * directory of the project pi is *currently* running in — not against a global index. A transcript
 * captured to any other directory is a transcript pi cannot see, and what pi does then, in json
 * mode, is stop and ask whether to fork. A run that suspended for two days would resume into an
 * interactive prompt nobody is watching.
 */
export const encodePiSessionDirectory = (cwd: string): string =>
  `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/**
 * The directory under a sessions root that holds one working directory's transcripts — or nothing,
 * when they go straight into the root.
 *
 * **pi encodes only under its own default root, and this is the whole of ticket 56.** Read off pi's
 * own source, `SessionManager.create`:
 *
 *     const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)
 *
 * So `--session-dir S` makes the layout **flat**: pi writes `S/<timestamp>_<id>.jsonl` and nothing
 * else. Only when the flag is absent does pi build `~/.pi/agent/sessions/<encoded cwd>/`. Kojo used
 * to pass the flag *and* read an encoded subdirectory under it, which is two behaviours that cannot
 * both be pi's — and the failure was not a red test. `resumeIntoSandbox` landed a captured
 * transcript under an encoded directory pi never looks in, so a resumed turn would find nothing and
 * start cold: no error, no warning, a full prompt billed instead of one message, and none of the
 * context the run had earned. That silent cold start is the exact fault this whole capture half
 * exists to prevent.
 *
 * The rule is therefore stated once, here, as a function of the one thing that decides it: whether
 * the root is pi's own. A caller that supplies a root has passed `--session-dir` and gets no
 * subdirectory; a caller that supplies none is on pi's default and gets the encoding.
 *
 * The caller joins, because the host side joins with the platform's separator and the sandbox side
 * is always POSIX.
 */
export const piSessionSubdirectory = (options: {
  /**
   * The working directory pi runs in, **exactly as pi's own process reports it**.
   *
   * On macOS that is not always the string a caller has: `mkdtemp` hands back
   * `/var/folders/…` and a process started there reports `/private/var/folders/…`, because `/var`
   * is a symlink. pi encodes what its `process.cwd()` gives it and resolves nothing —
   * `resolvePath` is `path.resolve`, which does not follow symlinks. So a host path must be
   * resolved to its real path *before* it reaches here, or the two sides encode one directory
   * under two names. See `piSessionStorage` in `contexts/sandbox/adapters/boundary.ts`.
   */
  readonly cwd: string;
  /** Whether this root is pi's own default — that is, no `--session-dir` was passed for this side. */
  readonly rootIsPiDefault: boolean;
}): string | undefined =>
  options.rootIsPiDefault ? encodePiSessionDirectory(options.cwd) : undefined;

/**
 * Whether one filename is the transcript of one session.
 *
 * pi names a transcript `<timestamp>_<session id>.jsonl`, so the id is a suffix rather than the
 * whole stem, and matching on the stem would find nothing.
 *
 * A plain `string` rather than an `AgentSessionId`: this is a predicate over a filename, and the
 * brand's job is keeping ids apart in Kojo's own signatures, not in a `endsWith`.
 */
export const isPiSessionFile = (filename: string, session: string): boolean =>
  filename.endsWith(`_${session}.jsonl`);

/**
 * The same transcript, told that it now lives somewhere else.
 *
 * pi records the working directory once, on the line whose `type` is `"session"`, and the rest of
 * the file never mentions it. So this is a targeted rewrite rather than a search and replace: a
 * `cwd` that merely *appears* in a tool result is the agent's own text, and rewriting it would edit
 * the conversation rather than move it.
 *
 * Every other line is returned byte for byte, including a line that is not JSON at all. A partly
 * flushed transcript is a real thing to find on disk, and dropping its last line — or failing on it
 * — would lose the turn the run is about to resume from.
 */
export const rewritePiSessionCwd = (jsonl: string, fromCwd: string, toCwd: string): string => {
  if (jsonl === "") return "";
  return jsonl
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      try {
        const entry: unknown = JSON.parse(line);
        if (typeof entry !== "object" || entry === null) return line;
        const record = entry as { type?: unknown; cwd?: unknown };
        if (record.type !== "session" || record.cwd !== fromCwd) return line;
        return JSON.stringify({ ...record, cwd: toCwd });
      } catch {
        return line;
      }
    })
    .join("\n");
};
