import { describe, expect, it } from "@effect/vitest";
import {
  encodePiSessionDirectory,
  isPiSessionFile,
  piSessionSubdirectory,
  piSessionsSegments,
  rewritePiSessionCwd,
  sandboxPiSessionsRoot,
} from "../../../../../src/contexts/agent/services/piSession.ts";

/** One transcript, in the shape pi writes it: the working directory on the first line and nowhere else. */
const transcript = (cwd: string): string =>
  [
    JSON.stringify({ type: "session", id: "01J8", cwd, model: "claude-sonnet-4-6" }),
    JSON.stringify({ type: "message", role: "user", content: `read ${cwd}/src/main.ts` }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta" } }),
  ].join("\n");

describe("pi's session layout", () => {
  it("encodes a working directory the way pi names its directory", () => {
    expect(encodePiSessionDirectory("/Users/ada/kojo")).toBe("--Users-ada-kojo--");
  });

  it("drops one leading separator and no more, so a nested path keeps its shape", () => {
    // Two leading slashes are one separator and one path segment, and pi treats them that way.
    expect(encodePiSessionDirectory("//srv/repo")).toBe("---srv-repo--");
  });

  it("hyphenates a drive letter's colon as well as its separators", () => {
    // Two hyphens after the drive letter, not one: the colon and the separator each become one.
    expect(encodePiSessionDirectory("C:\\Users\\ada\\kojo")).toBe("--C--Users-ada-kojo--");
  });

  it("distinguishes two working directories, which is the whole point of the encoding", () => {
    // The host worktree and the sandbox mount are never the same path, so a transcript captured
    // under one is invisible to `pi --session <id>` running under the other.
    expect(encodePiSessionDirectory("/Users/ada/kojo/.sandcastle/worktrees/hotfix")).not.toBe(
      encodePiSessionDirectory("/repo"),
    );
  });

  it("puts sessions under ~/.pi/agent/sessions on either side", () => {
    expect(piSessionsSegments.join("/")).toBe(".pi/agent/sessions");
    expect(sandboxPiSessionsRoot).toBe("/home/agent/.pi/agent/sessions");
  });

  it("matches a transcript by the id that ends its name, not by its whole name", () => {
    expect(isPiSessionFile("2026-08-10T09-14-00_01J8.jsonl", "01J8")).toBe(true);
    expect(isPiSessionFile("01J8.jsonl", "01J8")).toBe(false);
    expect(isPiSessionFile("2026-08-10T09-14-00_01J9.jsonl", "01J8")).toBe(false);
    expect(isPiSessionFile("2026-08-10T09-14-00_01J8.jsonl.bak", "01J8")).toBe(false);
  });
});

describe("moving one pi transcript between two working directories", () => {
  it("rewrites the session line and leaves every other line byte for byte", () => {
    const moved = rewritePiSessionCwd(transcript("/repo"), "/repo", "/Users/ada/kojo");
    const lines = moved.split("\n");

    expect(JSON.parse(lines[0] ?? "")).toEqual({
      type: "session",
      id: "01J8",
      cwd: "/Users/ada/kojo",
      model: "claude-sonnet-4-6",
    });
    // The agent's own words mention the old path. Rewriting them would edit the conversation.
    expect(lines.slice(1)).toEqual(transcript("/repo").split("\n").slice(1));
  });

  it("leaves a session line whose directory is a different one alone", () => {
    const untouched = transcript("/somewhere/else");
    expect(rewritePiSessionCwd(untouched, "/repo", "/Users/ada/kojo")).toBe(untouched);
  });

  it("keeps a half-written last line rather than dropping the turn it holds", () => {
    // A transcript read while pi was still flushing. Losing this line loses the turn a resumed run
    // continues from, and failing on it loses the whole session.
    const partial = `${transcript("/repo")}\n{"type":"message","rol`;
    const moved = rewritePiSessionCwd(partial, "/repo", "/host");

    expect(moved.endsWith(`{"type":"message","rol`)).toBe(true);
    expect(moved.split("\n")).toHaveLength(4);
  });

  it("keeps a trailing newline, because a JSONL file ends with one", () => {
    expect(rewritePiSessionCwd(`${transcript("/repo")}\n`, "/repo", "/host").endsWith("\n")).toBe(
      true,
    );
  });

  it("answers an empty transcript with an empty one", () => {
    expect(rewritePiSessionCwd("", "/repo", "/host")).toBe("");
  });

  it("is its own inverse, so a captured transcript resumes into the sandbox unchanged", () => {
    const original = transcript("/repo");
    const captured = rewritePiSessionCwd(original, "/repo", "/Users/ada/kojo");

    expect(rewritePiSessionCwd(captured, "/Users/ada/kojo", "/repo")).toBe(original);
  });
});

/**
 * **Which layout pi uses, which is ticket 56.**
 *
 * Read off pi 0.80.10's own `SessionManager.create`:
 *
 *     const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)
 *
 * Kojo used to pass `--session-dir` *and* read an encoded subdirectory under it. Both cannot be
 * pi's behaviour, and the wrong half did not fail loudly: a captured transcript landed where pi
 * never looks, so a resumed turn would have started cold — no error, a full prompt billed instead
 * of one message, and none of the context the run had earned.
 */
describe("which directory pi writes a transcript into", () => {
  it("puts it straight in the root it was given, because `--session-dir` is flat", () => {
    expect(
      piSessionSubdirectory({ cwd: "/private/tmp/repo", rootIsPiDefault: false }),
    ).toBeUndefined();
  });

  it("encodes the working directory under its own default root, where there is no flag", () => {
    expect(piSessionSubdirectory({ cwd: "/private/tmp/repo", rootIsPiDefault: true })).toBe(
      "--private-tmp-repo--",
    );
  });

  /**
   * The rule is a function of the flag and of nothing else — not of the cwd, and not of the
   * platform. Stated as a property so that a later reader cannot add a third case by accident.
   */
  it.each(["/repo", "/private/var/folders/z2/T/x", "C:/work/kojo", "/home/agent/workspace"])(
    "answers on the flag alone, for %s",
    (cwd) => {
      expect(piSessionSubdirectory({ cwd, rootIsPiDefault: false })).toBeUndefined();
      expect(piSessionSubdirectory({ cwd, rootIsPiDefault: true })).toBe(
        encodePiSessionDirectory(cwd),
      );
    },
  );

  /**
   * **The macOS trap, as a test rather than as a warning.**
   *
   * `mkdtemp` hands back `/var/folders/…`; a process started there reports
   * `/private/var/folders/…`, because `/var` is a symlink. pi encodes what its own `process.cwd()`
   * gives it and resolves nothing — its `resolvePath` is `path.resolve`, which does not follow
   * symlinks. So these two spellings of one directory encode to two names, and whoever hands a path
   * to this function owes it the resolved one. `piSessionStorage` resolves every host path exactly
   * once, in `onHost`.
   */
  it("gives two different names to the two spellings of one macOS temp directory", () => {
    const asHandedOut = "/var/folders/z2/T/kojo-pi-worktree-a1";
    const asTheProcessSeesIt = `/private${asHandedOut}`;

    expect(encodePiSessionDirectory(asHandedOut)).not.toBe(
      encodePiSessionDirectory(asTheProcessSeesIt),
    );
    expect(encodePiSessionDirectory(asTheProcessSeesIt)).toBe(
      "--private-var-folders-z2-T-kojo-pi-worktree-a1--",
    );
  });
});
