import { describe, expect, it } from "@effect/vitest";
import {
  promiseLeaksIn,
  reportLeaks,
} from "../../../../../src/contexts/sandbox/guards/promiseFreeTypes.ts";

/** Emitted by tsgo from a one-line source file, verbatim. This is the shape the guard reads. */
const leaky = [
  "export declare const leaked: () => Promise<string>;",
  "//# sourceMappingURL=deliberateLeak.d.ts.map",
].join("\n");

describe("the promise-free guard", () => {
  it("finds a deliberate violation, and names where it is", () => {
    const leaks = promiseLeaksIn("contexts/sandbox/adapters/deliberateLeak.d.ts", leaky);

    expect(leaks).toEqual([
      {
        file: "contexts/sandbox/adapters/deliberateLeak.d.ts",
        line: 1,
        text: "export declare const leaked: () => Promise<string>;",
      },
    ]);
  });

  it("counts `PromiseLike`, which `await` accepts just as happily", () => {
    expect(promiseLeaksIn("a.d.ts", "export declare const x: PromiseLike<void>;")).toHaveLength(1);
  });

  it("does not flag its own vocabulary", () => {
    // The guard's own declaration file is in the tree it grades. A name *about* promises is not a
    // promise, and a check that trips on itself is a check somebody switches off.
    const own = "export interface PromiseLeak { readonly line: number; }";

    expect(promiseLeaksIn("promiseFreeTypes.d.ts", own)).toEqual([]);
  });

  it("passes the boundary's own declarations, where every promise is already spent", () => {
    const boundary = [
      "import { Effect } from 'effect';",
      "export interface SandboxHandle {",
      "    readonly exec: (command: string) => Effect.Effect<ExecResult, SandboxError>;",
      "}",
    ].join("\n");

    expect(promiseLeaksIn("boundary.d.ts", boundary)).toEqual([]);
  });

  it("reads prose as prose", () => {
    // Every one of these mentions a promise and none of them is one. A guard that cannot tell the
    // difference is a guard somebody turns off.
    const prose = [
      "/**",
      " * Wraps the promise Sandcastle returns. Promise, PromiseLike — all of it, gone.",
      " */",
      "// Promise handling lives in boundary.ts",
      "export declare const label: string;",
    ].join("\n");

    expect(promiseLeaksIn("prose.d.ts", prose)).toEqual([]);
  });

  it("reads a string as data", () => {
    expect(
      promiseLeaksIn("a.d.ts", 'export declare const signal: "<promise>COMPLETE</promise>";'),
    ).toEqual([]);
  });

  it("is not blinded by a slash pair inside a string", () => {
    // A regex that stripped from the first `//` would drop the rest of this line, and the leak
    // after it with the rest. The scanner knows it is inside a string.
    const line = 'export declare const fetchDocs: (url: "https://x") => Promise<string>;';

    expect(promiseLeaksIn("a.d.ts", line)).toHaveLength(1);
  });

  it("is not blinded by a quote inside a comment", () => {
    // The apostrophe would open a string that never closes, swallowing the leak two lines down.
    const source = [
      "// Sandcastle's own build asserts the mirror image of this.",
      "export declare const close: () => Promise<void>;",
    ].join("\n");

    expect(promiseLeaksIn("a.d.ts", source).map((leak) => leak.line)).toEqual([2]);
  });

  it("keeps line numbers true across a multi-line docblock", () => {
    const source = ["/**", " * A promise, in prose.", " */", "", "type X = Promise<void>;"].join(
      "\n",
    );

    expect(promiseLeaksIn("a.d.ts", source).map((leak) => leak.line)).toEqual([5]);
  });

  it("reports what to do about it, not only that it happened", () => {
    const report = reportLeaks(promiseLeaksIn("a.d.ts", leaky));

    expect(report).toContain("1 promise reached the published types.");
    expect(report).toContain("boundary.ts");
    expect(report).toContain("a.d.ts:1");
  });
});
