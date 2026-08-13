import { describe, expect, it } from "@effect/vitest";
import {
  isPlaceholder,
  placeholder,
  placeholderExitCode,
  placeholderMarker,
} from "../../../../../src/contexts/scaffold/models/Placeholder.ts";

/**
 * Architecture.md edge 6, graded.
 *
 * A placeholder has three jobs, and failing any one of them makes it the thing the edge warns
 * about: it must be recognisable to a machine, it must be readable by a person, and it must not
 * pass.
 */
describe("a placeholder command", () => {
  it("cannot succeed", () => {
    // The one property that matters most. A fake command that exits 0 makes the mechanical half of
    // an acceptance report a clean suite that never ran — worse than no command at all.
    expect(placeholder("test")).toContain(`exit ${placeholderExitCode}`);
    expect(placeholderExitCode).not.toBe(0);
  });

  it("says what it is, and where to fix it", () => {
    const command = placeholder("test");
    expect(command).toContain(placeholderMarker);
    expect(command).toContain("test");
    expect(command).toContain(".kojo/commands.ts");
    // On stderr, so it survives a caller that only keeps stdout.
    expect(command).toContain(">&2");
  });

  it("is recognised by the same function on both sides", () => {
    // `kojo doctor` reads a target repository's own `commands.ts` and asks this question of each
    // string. Nothing about the file has to be parsed for the answer to be right.
    expect(isPlaceholder(placeholder("lint"))).toBe(true);
    expect(isPlaceholder("bun test")).toBe(false);
    expect(isPlaceholder("")).toBe(false);
  });

  it("is still recognised after a half-hearted edit", () => {
    // The realistic way a placeholder survives: somebody changed the words and left the shape.
    const halfEdited = placeholder("test").replace("no test command yet", "run the tests somehow");
    expect(isPlaceholder(halfEdited)).toBe(true);
  });
});
