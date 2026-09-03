import { readFileSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

interface PublicPackage {
  readonly directory: string;
  readonly name: string;
}

const run = (command: ReadonlyArray<string>, cwd: string): string => {
  const result = Bun.spawnSync(command, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
  }
  const output = result.stdout.toString();
  if (output.length > 0) process.stdout.write(output);
  return output;
};

const version = Bun.argv[2];
if (version === undefined) {
  throw new Error("Usage: cocogitto-package-version.ts <version>");
}

const packageDirectory = process.cwd();
const repositoryRoot = run(["git", "rev-parse", "--show-toplevel"], packageDirectory).trim();
const publicPackages = JSON.parse(
  readFileSync(resolve(repositoryRoot, ".github/release-packages.json"), "utf8"),
) as ReadonlyArray<PublicPackage>;
const workspace = relative(resolve(repositoryRoot, "packages"), packageDirectory);
const releasePackage = publicPackages.find(({ directory }) => directory === workspace);
if (releasePackage === undefined || basename(packageDirectory) !== releasePackage.directory) {
  throw new Error(`${packageDirectory} is not a public Kojo package.`);
}

run(["bun", "pm", "version", version, "--no-git-tag-version"], packageDirectory);

const lockPath = resolve(repositoryRoot, "bun.lock");
const lock = readFileSync(lockPath, "utf8");
const escapedDirectory = releasePackage.directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapedName = releasePackage.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const workspaceVersion = new RegExp(
  `("packages/${escapedDirectory}": \\{\\n\\s+"name": "${escapedName}",\\n\\s+"version": ")[^"]+(")`,
);
if (!workspaceVersion.test(lock)) {
  throw new Error(`bun.lock has no version field for packages/${releasePackage.directory}.`);
}
writeFileSync(lockPath, lock.replace(workspaceVersion, `$1${version}$2`));

const staged = [
  resolve(packageDirectory, "package.json"),
  lockPath,
];
if (releasePackage.directory === "kojo-runtime") {
  const runtimeManifestPath = resolve(packageDirectory, "runtime-manifest.json");
  const runtimeManifest = readFileSync(runtimeManifestPath, "utf8");
  const packageVersion = /("packageVersion": ")[^"]+(")/;
  if (!packageVersion.test(runtimeManifest)) {
    throw new Error("runtime-manifest.json has no packageVersion field.");
  }
  writeFileSync(runtimeManifestPath, runtimeManifest.replace(packageVersion, `$1${version}$2`));
  staged.push(runtimeManifestPath);
}

run(["git", "add", "--", ...staged], repositoryRoot);
