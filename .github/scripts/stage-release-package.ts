import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

interface PackageManifest {
  readonly name: string;
  readonly private?: boolean;
  readonly exports?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

const contracts = ["kojo-client-contracts", "kojo-runner-contracts"];

/** Prepare self-contained source without changing workspace imports or package boundaries. */
export const stageReleasePackage = (root: string, directory: string, target: string): void => {
  const source = join(root, "packages", directory);
  const pkg: PackageManifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (pkg.private) throw new Error(`Cannot stage private package ${pkg.name}.`);
  mkdirSync(target, { recursive: true });
  for (const file of [
    "src",
    "console",
    "LICENSE",
    "README.md",
    "runtime-manifest.json",
    "managed-release.json",
  ]) {
    if (existsSync(join(source, file)))
      cpSync(join(source, file), join(target, file), { recursive: true });
  }

  const imports = new Map<string, string>();
  for (const contract of contracts) {
    const name = `@carere/${contract}`;
    if (pkg.dependencies?.[name] === undefined) continue;
    const contractRoot = join(root, "packages", contract);
    const manifest: PackageManifest = JSON.parse(
      readFileSync(join(contractRoot, "package.json"), "utf8"),
    );
    if (
      !manifest.private ||
      Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).length > 0
    ) {
      throw new Error(`${name} must be private and have no production dependencies.`);
    }
    const embedded = join(target, "src/internal", contract);
    cpSync(join(contractRoot, "src"), embedded, { recursive: true });
    cpSync(join(contractRoot, "LICENSE"), join(embedded, "LICENSE"));
    for (const [entry, path] of Object.entries(manifest.exports ?? {})) {
      if (!path.startsWith("./src/") || !existsSync(resolve(contractRoot, path))) {
        throw new Error(`Invalid contract export ${name}/${entry}.`);
      }
      imports.set(`${name}/${entry.slice(2)}`, resolve(embedded, path.slice("./src/".length)));
    }
    delete pkg.dependencies[name];
  }
  delete pkg.devDependencies;
  for (const version of Object.values({ ...pkg.dependencies, ...pkg.peerDependencies })) {
    if (version.startsWith("workspace:"))
      throw new Error(`${pkg.name} retains a workspace dependency.`);
  }

  const rewrite = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) rewrite(path);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        const content = readFileSync(path, "utf8");
        const rewritten = content.replace(
          /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])([^"']+)\2/g,
          (match, prefix: string, quote: string, specifier: string) => {
            const destination = imports.get(specifier);
            if (destination === undefined) {
              if (contracts.some((contract) => specifier.startsWith(`@carere/${contract}`))) {
                throw new Error(`Unresolved private contract import ${specifier} in ${path}.`);
              }
              return match;
            }
            const local = relative(dirname(path), destination).split("\\").join("/");
            return `${prefix}${quote}${local.startsWith(".") ? local : `./${local}`}${quote}`;
          },
        );
        writeFileSync(path, rewritten);
      }
    }
  };
  rewrite(join(target, "src"));
  writeFileSync(join(target, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
};
