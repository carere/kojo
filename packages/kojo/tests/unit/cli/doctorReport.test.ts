import { describe, expect, it } from "@effect/vitest";
import { fold, renderDiagnosis, verdictLine } from "../../../src/cli/doctorReport.ts";
import { failed, ok, skipped } from "../../../src/contexts/scaffold/models/Finding.ts";

const findings = [
  ok("runtime", "bun 1.3.14"),
  failed("commands", "test, lint, build are still placeholders", "Write the real ones."),
  skipped("container", "this factory runs with `none`, which builds no image here"),
];

describe("folding a remedy", () => {
  it("keeps every line inside the room it is given", () => {
    const lines = fold("one two three four five six seven eight", 4, 12);
    expect(lines.every((line) => line.length <= 12 + 4)).toBe(true);
    expect(lines.join(" ").replace(/\s+/g, " ").trim()).toBe(
      "one two three four five six seven eight",
    );
  });

  it("indents every line after the first, so the text stays in its column", () => {
    const [first, ...rest] = fold("alpha beta gamma delta", 6, 12);
    expect(first?.startsWith(" ")).toBe(false);
    expect(rest.every((line) => line.startsWith("      "))).toBe(true);
  });

  it("does not lose a word longer than the room it has", () => {
    expect(fold("supercalifragilistic", 0, 5)).toEqual(["supercalifragilistic"]);
  });
});

describe("the report", () => {
  it("prints one line per check, including the ones that were skipped", () => {
    const report = renderDiagnosis({ root: "/repo", findings });

    // The skips are the point of printing everything: a report that showed only failures would
    // answer "what is wrong" while hiding "a check you were counting on never ran".
    expect(report).toContain("runtime");
    expect(report).toContain("commands");
    expect(report).toContain("container");
    expect(report).toContain("/repo");
  });

  it("puts the remedy under its own failure, not in a list at the bottom", () => {
    const lines = renderDiagnosis({ root: "/repo", findings }).split("\n");
    const at = lines.findIndex((line) => line.includes("still placeholders"));

    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toContain("→");
    expect(lines[at + 1]).toContain("Write the real ones.");
  });

  it("shouts only about the failures", () => {
    const report = renderDiagnosis({ root: "/repo", findings });
    expect(report).toContain("FAILED");
    expect(report).not.toContain("OK");
    expect(report).not.toContain("SKIPPED");
  });

  it("says nothing about the verdict, which the command says once, on the right stream", () => {
    expect(renderDiagnosis({ root: "/repo", findings })).not.toContain("not ready");
  });
});

describe("the verdict", () => {
  it("counts the failures out of the checks that ran", () => {
    expect(verdictLine(findings)).toBe("this factory is not ready — 1 of 3 checks failed");
  });

  it("calls a factory ready only when nothing failed", () => {
    expect(verdictLine([ok("runtime", "bun"), skipped("image", "no container here")])).toContain(
      "ready",
    );
  });
});
