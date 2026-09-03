import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly exports: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

interface RuntimeManifest {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly effectPeer: string;
  readonly runner: string;
  readonly validator: string;
}

const packageRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const packageManifest = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
) as PackageManifest;
const runtimeManifest = JSON.parse(
  readFileSync(resolve(packageRoot, "runtime-manifest.json"), "utf8"),
) as RuntimeManifest;

describe("the Project-local runtime package contract", () => {
  it("has one exact physical Effect peer", () => {
    const fromRuntime = Bun.resolveSync("effect", resolve(packageRoot, "src"));
    const fromAuthoredCode = Bun.resolveSync("effect", testDirectory);

    expect(packageManifest.peerDependencies.effect).toBe("4.0.0-beta.106");
    expect(runtimeManifest.effectPeer).toBe(packageManifest.peerDependencies.effect);
    expect(fromRuntime).toBe(fromAuthoredCode);
  });

  it("loads every explicit TypeScript export without a package barrel", async () => {
    const exports = Object.keys(packageManifest.exports).filter(
      (path) => path !== "./runtime-manifest.json",
    );
    expect(exports.some((path) => path.includes("*"))).toBe(false);

    for (const exported of exports) {
      const target = packageManifest.exports[exported];
      expect(target).toBeDefined();
      await expect(
        import(pathToFileURL(resolve(packageRoot, target ?? "")).href),
      ).resolves.toBeDefined();
    }
  });

  it("keeps the static entry paths inside the package", () => {
    expect(runtimeManifest.packageName).toBe(packageManifest.name);
    expect(runtimeManifest.packageVersion).toBe(packageManifest.version);
    for (const entry of [runtimeManifest.runner, runtimeManifest.validator]) {
      const target = resolve(packageRoot, entry);
      const fromPackage = relative(packageRoot, target);
      expect(fromPackage.startsWith("..") || isAbsolute(fromPackage)).toBe(false);
    }
  });
});
