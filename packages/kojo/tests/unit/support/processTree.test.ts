import { describe, expect, it } from "vitest";
import { findProcessAncestor } from "../../support/processTree.ts";

const isRunner = (process: { readonly command: string }): boolean =>
  process.command.includes("runner/main");

describe("process ancestry", () => {
  it("keeps a direct Runner parent", () => {
    expect(
      findProcessAncestor(
        [
          {
            pid: 10,
            parent: 1,
            command: "bun packages/kojo-runtime/src/runner/main.ts",
          },
        ],
        10,
        isRunner,
      ),
    ).toMatchObject({ pid: 10 });
  });

  it("finds the Runner above a provider shell wrapper", () => {
    const runner = findProcessAncestor(
      [
        {
          pid: 30,
          parent: 20,
          command: "controlled-agent",
        },
        {
          pid: 20,
          parent: 10,
          command: "sh -c env KOJO_RESOURCE_ACQUISITION_KEY=resource-key controlled-agent",
        },
        {
          pid: 10,
          parent: 1,
          command: "bun packages/kojo-runtime/src/runner/main.ts",
        },
      ],
      20,
      isRunner,
    );

    expect(runner).toEqual({
      pid: 10,
      parent: 1,
      command: "bun packages/kojo-runtime/src/runner/main.ts",
    });
  });

  it("stops when ancestry is missing or cyclic", () => {
    expect(
      findProcessAncestor(
        [{ pid: 20, parent: 10, command: "sh -c controlled-agent" }],
        20,
        isRunner,
      ),
    ).toBeUndefined();
    expect(
      findProcessAncestor(
        [
          { pid: 20, parent: 10, command: "sh -c controlled-agent" },
          { pid: 10, parent: 20, command: "env controlled-agent" },
        ],
        20,
        isRunner,
      ),
    ).toBeUndefined();
  });
});
