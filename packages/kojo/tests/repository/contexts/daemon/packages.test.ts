import { describe, expect, it } from "vitest";

describe("the daemon package graph", () => {
  it("loads every package and rejects dependency or output drift", async () => {
    const process = Bun.spawn(["bun", "src/scripts/check-package-graph.ts"], {
      cwd: new URL("../../../../", import.meta.url).pathname,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(stdout).toContain("package graph and explicit package outputs are valid");
    expect(exitCode).toBe(0);
  });
});
