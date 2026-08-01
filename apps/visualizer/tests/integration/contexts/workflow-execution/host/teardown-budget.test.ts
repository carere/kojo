import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const teardownBudgetModulePath = fileURLToPath(
  new URL("../../../../../../../tests/support/teardown-budget.ts", import.meta.url),
);

test("exits promptly after a bounded operation settles", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { makeTeardownBudget } from ${JSON.stringify(teardownBudgetModulePath)}; await makeTeardownBudget().run("quick operation", () => Promise.resolve());`,
    ],
    { stderr: "ignore", stdout: "ignore" },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Bounded budget timer kept the worker alive.")),
          1_000,
        );
      }),
    ]);
    expect(exitCode).toBe(0);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});
