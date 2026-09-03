import { describe, expect, it } from "@effect/vitest";
import {
  dependencyFinding,
  factoryFinding,
  repositoryFinding,
  runtimeFinding,
} from "../../../../../src/contexts/scaffold/services/readiness.ts";
import { someEngine } from "../../../../support/engineDependency.ts";

describe("Daemon Project readiness", () => {
  it("checks Bun and the Git worktree", () => {
    expect(runtimeFinding(undefined).standing).toBe("failed");
    expect(runtimeFinding("1.3.14").standing).toBe("ok");
    expect(
      repositoryFinding({ git: "git version 2.50.1", insideWorkTree: true, head: "9f3a1c2" })
        .standing,
    ).toBe("ok");
  });

  it("requires an authored Factory", () => {
    expect(
      factoryFinding({ directory: false, config: false, commands: false, workflows: [] }).standing,
    ).toBe("failed");
    expect(
      factoryFinding({ directory: true, config: true, commands: true, workflows: ["review"] })
        .standing,
    ).toBe("ok");
  });

  it("checks runtime packages without opening a database", () => {
    const manager = "bun" as const;
    expect(
      dependencyFinding({ engine: undefined, runtime: undefined, effect: undefined, manager })
        .standing,
    ).toBe("skipped");
    expect(
      dependencyFinding({
        engine: someEngine,
        runtime: {
          name: someEngine.runtime.name,
          version: someEngine.runtime.version,
          directory: "/runtime",
        },
        effect: {
          name: someEngine.effect.name,
          version: someEngine.effect.version,
          directory: "/effect",
        },
        manager,
      }).standing,
    ).toBe("ok");
  });
});
