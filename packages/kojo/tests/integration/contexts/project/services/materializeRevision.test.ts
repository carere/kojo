import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discardMaterializedRevisionCacheForPurge } from "../../../../../src/contexts/project/services/materializeRevision.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("materialized revision purge preparation", () => {
  it("reports an external package link without exposing its Host target", () => {
    const parent = mkdtempSync(join(tmpdir(), "kojo-materialized-purge-"));
    roots.push(parent);
    const executionRoot = join(parent, "runner-materialized");
    const link = join(
      executionRoot,
      "graphs",
      "graph",
      "packages",
      "package",
      "node_modules",
      "external",
    );
    const external = join(parent, "external-package");
    mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
    mkdirSync(external, { mode: 0o700 });
    symlinkSync(external, link);

    let message = "";
    try {
      discardMaterializedRevisionCacheForPurge(executionRoot);
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toContain(relative(executionRoot, link));
    expect(message).not.toContain(executionRoot);
    expect(message).not.toContain(external);
  });

  it("reports unexpected and dangling links with cache-relative paths only", () => {
    const parent = mkdtempSync(join(tmpdir(), "kojo-materialized-purge-"));
    roots.push(parent);
    const unexpectedRoot = join(parent, "unexpected-cache");
    const unexpected = join(unexpectedRoot, "unexpected-link");
    const danglingRoot = join(parent, "dangling-cache");
    const dangling = join(
      danglingRoot,
      "graphs",
      "graph",
      "packages",
      "package",
      "node_modules",
      "dangling",
    );
    const absentTarget = join(parent, "absent-target");
    mkdirSync(unexpectedRoot, { mode: 0o700 });
    mkdirSync(dirname(dangling), { recursive: true, mode: 0o700 });
    symlinkSync(absentTarget, unexpected);
    symlinkSync(absentTarget, dangling);

    for (const [root, link] of [
      [unexpectedRoot, unexpected],
      [danglingRoot, dangling],
    ] as const) {
      let message = "";
      try {
        discardMaterializedRevisionCacheForPurge(root);
      } catch (cause) {
        message = cause instanceof Error ? cause.message : String(cause);
      }
      expect(message).toContain(relative(root, link));
      expect(message).not.toContain(root);
      expect(message).not.toContain(absentTarget);
    }
  });
});
