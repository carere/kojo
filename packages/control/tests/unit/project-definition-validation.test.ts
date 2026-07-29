import { describe, expect, it } from "vitest";
import {
  selectProjectDefinitionInstallCommand,
  validateProjectDefinitionInSubprocessWith,
} from "../../src/project-definition-validation";

describe("shared Project Definition loader orchestration", () => {
  it.each([
    ["bun.lock", "bun add @kojo/workflow"],
    ["pnpm-lock.yaml", "pnpm add @kojo/workflow"],
    ["yarn.lock", "yarn add @kojo/workflow"],
    ["package.json", "npm install @kojo/workflow"],
  ])("selects the install command for %s", (present, expected) => {
    expect(selectProjectDefinitionInstallCommand((name) => name === present)).toBe(expected);
  });

  it("decodes the validated envelope from an application subprocess", async () => {
    const result = await validateProjectDefinitionInSubprocessWith((receive) => {
      receive({ ok: true });
      return { exited: Promise.resolve(0), kill: () => undefined };
    }, 100);

    expect(result).toEqual({ ok: true });
  });

  it("kills a loader that exceeds its shared deadline", async () => {
    let finish: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const result = await validateProjectDefinitionInSubprocessWith(
      () => ({
        exited,
        kill: () => finish?.(137),
      }),
      1,
    );

    expect(result).toMatchObject({ ok: false, findingKey: "configuration.load-failed" });
  });
});
