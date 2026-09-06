import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = new URL("../../../../../", import.meta.url).pathname;
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "kojo-release-packages-"));
  temporary.push(directory);
  cpSync(join(root, ".github"), join(directory, ".github"), { recursive: true });
  for (const name of ["kojo", "kojo-runtime", "kojo-client-contracts", "kojo-runner-contracts"]) {
    const source = join(root, "packages", name);
    const target = join(directory, "packages", name);
    mkdirSync(target, { recursive: true });
    for (const entry of [
      "src",
      "package.json",
      "LICENSE",
      "runtime-manifest.json",
      "managed-release.json",
    ]) {
      if (existsSync(join(source, entry)))
        cpSync(join(source, entry), join(target, entry), { recursive: true });
    }
  }
  // Packing requires Console output; its UI build is checked by the separate Console task.
  mkdirSync(join(directory, "packages/kojo/console"));
  writeFileSync(
    join(directory, "packages/kojo/console/index.html"),
    "<html>Console fixture</html>",
  );
  const version = JSON.parse(readFileSync(join(directory, "packages/kojo/package.json"), "utf8"))
    .version as string;
  return { directory, version };
};

const execute = (root: string, script: string, args: string[]) => {
  const result = spawnSync(process.execPath, [join(root, ".github/scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
};

const assertLocalContracts = (target: string, contracts: string[]) => {
  const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
  expect(pkg.devDependencies).toBeUndefined();
  expect(JSON.stringify({ ...pkg.dependencies, ...pkg.peerDependencies })).not.toMatch(
    /workspace:|kojo-(client|runner)-contracts/,
  );
  for (const contract of contracts) {
    expect(existsSync(join(target, "src/internal", contract, "LICENSE"))).toBe(true);
  }
  const inspect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) inspect(path);
      else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(
          /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g,
        )) {
          const specifier = match[1] as string;
          expect(specifier).not.toMatch(/^@carere\/kojo-(client|runner)-contracts/);
          if (
            specifier.startsWith(".") &&
            (specifier.includes("/internal/") || path.includes("/src/internal/"))
          )
            expect(existsSync(resolve(dirname(path), specifier)), `${path}: ${specifier}`).toBe(
              true,
            );
        }
      }
    }
  };
  inspect(join(target, "src"));
  const runner = join(
    target,
    "src/internal/kojo-runner-contracts/contexts/project/contracts/frame.ts",
  );
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `const { RUNNER_PROTOCOL_VERSION } = await import(${JSON.stringify(runner)}); if (RUNNER_PROTOCOL_VERSION !== 1) throw new Error("protocol changed");`,
    ],
    { cwd: target, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
};

describe("self-contained Release packages", () => {
  it("refuses contract imports that are absent from the private export map", () => {
    const f = fixture();
    writeFileSync(
      join(f.directory, "packages/kojo-runtime/src/broken.ts"),
      'export { missing } from "@carere/kojo-runner-contracts/missing";\n',
    );
    const result = spawnSync(
      process.execPath,
      [
        join(f.directory, ".github/scripts/release-train.ts"),
        "pack",
        f.version,
        join(f.directory, "archives"),
      ],
      { cwd: f.directory, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unresolved private contract import");
  });

  it("packs two archives with local contract imports and leaves workspace source unchanged", () => {
    const f = fixture();
    const archives = join(f.directory, "archives");
    const runner = join(f.directory, "packages/kojo-runtime/src/runner/main.ts");
    const original = readFileSync(runner, "utf8");
    execute(f.directory, "release-train.ts", ["pack", f.version, archives]);
    const tarballs = readdirSync(archives);
    expect(tarballs).toHaveLength(2);
    for (const name of ["kojo", "kojo-runtime"]) {
      const target = join(f.directory, "unpacked", name);
      mkdirSync(target, { recursive: true });
      const archive = join(archives, `carere-${name}-${f.version}.tgz`);
      expect(spawnSync("tar", ["-xzf", archive, "-C", target]).status).toBe(0);
      assertLocalContracts(
        join(target, "package"),
        name === "kojo"
          ? ["kojo-client-contracts", "kojo-runner-contracts"]
          : ["kojo-runner-contracts"],
      );
      const manifest = JSON.parse(readFileSync(join(target, "package/package.json"), "utf8"));
      expect(manifest.name).toBe(`@carere/${name}`);
    }
    expect(readFileSync(runner, "utf8")).toBe(original);
    expect(original).toContain("@carere/kojo-runner-contracts/");
  });
});
