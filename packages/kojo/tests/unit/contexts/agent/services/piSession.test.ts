import { describe, expect, it } from "@effect/vitest";
import {
  encodePiSessionDirectory,
  isPiSessionFile,
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
