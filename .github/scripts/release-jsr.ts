import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseReleaseVersion } from "../../packages/kojo/src/scripts/release/ReleaseVersion.ts";

interface JsrPackage {
  readonly name: string;
  readonly directory: string;
  readonly version: string;
  readonly files: Record<string, string>;
}
interface Manifest {
  readonly version: string;
  jsr?: JsrPackage[];
}
const root = resolve(import.meta.dir, "../..");
const packages = ["kojo-client-contracts", "kojo-runner-contracts", "kojo-runtime"];
const registry = process.env.KOJO_JSR_REGISTRY ?? "https://jsr.io";
const run = (command: string[], cwd: string): void => {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command[0]} ${command[1]} failed.`);
};
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const files = (directory: string, prefix = ""): Record<string, string> =>
  Object.fromEntries(
    readdirSync(join(directory, prefix), { withFileTypes: true })
      .flatMap((entry) => {
        const path = join(prefix, entry.name);
        if (entry.name === "node_modules" || entry.name === "deno.lock") return [];
        return entry.isDirectory()
          ? Object.entries(files(directory, path))
          : [[`/${path}`, hash(readFileSync(join(directory, path)))]];
      })
      .sort(([left], [right]) => (left ?? "").localeCompare(right ?? "")),
  );
const [mode, manifestPath, project] = Bun.argv.slice(2);
if (!manifestPath)
  throw new Error(
    "Usage: release-jsr.ts prepare|validate|publish|verify|install <manifest> [project]",
  );
if (mode === "assert-unpublished") {
  const { version } = parseReleaseVersion(manifestPath);
  for (const directory of packages) {
    const response = await fetch(`${registry}/@carere/${directory}/${version}_meta.json`);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`JSR lookup failed (${response.status}).`);
    throw new Error(`@carere/${directory}@${version} already exists on JSR.`);
  }
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const staging = resolve(dirname(manifestPath), "jsr");
const packageSet = (): JsrPackage[] => {
  if (
    manifest.jsr?.length !== packages.length ||
    manifest.jsr.some(
      (pkg, index) =>
        pkg.directory !== packages[index] ||
        pkg.name !== `@carere/${pkg.directory}` ||
        pkg.version !== manifest.version ||
        !pkg.files["/jsr.json"] ||
        !Object.values(pkg.files).every((value) => /^[a-f0-9]{64}$/.test(value)),
    )
  )
    throw new Error("The Release manifest has an invalid JSR package set.");
  return manifest.jsr;
};

if (mode === "prepare") {
  if (existsSync(staging)) throw new Error("JSR staging directory already exists.");
  manifest.jsr = [];
  for (const directory of packages) {
    const source = join(root, "packages", directory);
    const target = join(staging, directory);
    mkdirSync(target, { recursive: true });
    for (const file of ["src", "LICENSE", "README.md", "jsr.json", "runtime-manifest.json"]) {
      if (existsSync(join(source, file)))
        cpSync(join(source, file), join(target, file), { recursive: true });
    }
    const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    pkg.dependencies = { ...pkg.peerDependencies, ...pkg.dependencies };
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      if (typeof version === "string" && version.startsWith("workspace:"))
        pkg.dependencies[name] = manifest.version;
    }
    delete pkg.devDependencies;
    delete pkg.peerDependencies;
    writeFileSync(join(target, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    const config = JSON.parse(readFileSync(join(target, "jsr.json"), "utf8"));
    if (config.version !== manifest.version)
      throw new Error(`${directory} JSR version differs from the Release.`);
    // Resolve bare dependency imports before hashing. Explicit npm specifiers prevent the JSR CLI
    // from changing source bytes during upload. Internal Kojo dependencies use the same npm Release.
    for (const path of Object.keys(files(target)).filter((path) => path.endsWith(".ts"))) {
      const fullPath = join(target, path);
      const sourceText = readFileSync(fullPath, "utf8");
      const explicit = sourceText.replace(
        /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])([^"']+)\2/g,
        (match, prefix: string, quote: string, specifier: string) => {
          const name = Object.keys(pkg.dependencies).find(
            (name) => specifier === name || specifier.startsWith(`${name}/`),
          );
          return name === undefined
            ? match
            : `${prefix}${quote}npm:${name}@${pkg.dependencies[name]}${specifier.slice(name.length)}${quote}`;
        },
      );
      writeFileSync(fullPath, explicit);
    }
    // JSR's Bun installation contains transpiled JavaScript. The exported JSON contract must name
    // those installed entry points, while the npm archive retains its TypeScript entry points.
    const runtimePath = join(target, "runtime-manifest.json");
    if (existsSync(runtimePath)) {
      const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
      runtime.runner = runtime.runner.replace(/\.ts$/, ".js");
      runtime.validator = runtime.validator.replace(/\.ts$/, ".js");
      writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
    }
    manifest.jsr.push({
      name: pkg.name,
      directory,
      version: manifest.version,
      files: files(target),
    });
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
} else if (mode === "validate" || mode === "publish") {
  for (const pkg of packageSet()) {
    const target = join(staging, pkg.directory);
    if (JSON.stringify(files(target)) !== JSON.stringify(pkg.files))
      throw new Error(`${pkg.name} JSR files changed after preparation.`);
    const modules = join(target, "node_modules");
    symlinkSync(join(root, "packages", pkg.directory, "node_modules"), modules, "dir");
    try {
      run(
        [
          "bun",
          "x",
          "--bun",
          "jsr@0.14.3",
          "publish",
          "--allow-dirty",
          ...(mode === "validate" ? ["--dry-run"] : []),
        ],
        target,
      );
    } finally {
      rmSync(modules);
    }
  }
} else if (mode === "verify") {
  for (const pkg of packageSet()) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      response = await fetch(`${registry}/${pkg.name}/${pkg.version}_meta.json`);
      if (response.status !== 404) break;
      if (attempt < 5) await Bun.sleep(2 ** attempt * 1_000);
    }
    if (!response?.ok)
      throw new Error(`${pkg.name}@${pkg.version} is absent from JSR (${response?.status}).`);
    const metadata = (await response.json()) as { manifest: Record<string, { checksum: string }> };
    const actual = metadata.manifest;
    if (
      !actual ||
      Object.keys(actual).length !== Object.keys(pkg.files).length ||
      Object.entries(pkg.files).some(
        ([path, digest]) => actual[path]?.checksum !== `sha256-${digest}`,
      )
    ) {
      throw new Error(`${pkg.name}@${pkg.version} on JSR differs from the validated source.`);
    }
  }
} else if (mode === "install") {
  if (!project) throw new Error("install requires a clean Project directory.");
  mkdirSync(project, { recursive: true });
  if (readdirSync(project).length !== 0) throw new Error("JSR install directory is not empty.");
  writeFileSync(join(project, ".npmrc"), "@jsr:registry=https://npm.jsr.io\n");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "kojo-jsr-install-check",
      private: true,
      type: "module",
      dependencies: Object.fromEntries(
        packageSet().map((pkg) => [pkg.name, `npm:@jsr/carere__${pkg.directory}@${pkg.version}`]),
      ),
    }),
  );
  run(["bun", "install"], project);
  // Import every public entry, including Runner and Validator, from the installed compatibility
  // packages. Neither entry may execute a Workflow on import.
  const entries = packages.flatMap((directory) => {
    const config = JSON.parse(readFileSync(join(root, "packages", directory, "jsr.json"), "utf8"));
    return Object.keys(config.exports)
      .filter((entry) => !entry.endsWith(".json"))
      .map((entry) => `@carere/${directory}/${entry.slice(2)}`);
  });
  writeFileSync(
    join(project, "check.ts"),
    `
    import { existsSync, readFileSync } from "node:fs";
    import { dirname, resolve } from "node:path";
    for (const entry of ${JSON.stringify(entries)}) await import(entry);
    const path = import.meta.resolve("@carere/kojo-runtime/runtime-manifest.json");
    const manifest = JSON.parse(readFileSync(new URL(path), "utf8"));
    if (manifest.packageVersion !== ${JSON.stringify(manifest.version)}) throw new Error("Installed JSR Runtime version differs.");
    for (const entry of [manifest.runner, manifest.validator]) {
      if (!existsSync(resolve(dirname(new URL(path).pathname), entry))) throw new Error("Installed JSR entry is missing: " + entry);
    }
  `,
  );
  run(["bun", "check.ts"], project);
} else {
  throw new Error("Use prepare, validate, publish, verify, or install.");
}
