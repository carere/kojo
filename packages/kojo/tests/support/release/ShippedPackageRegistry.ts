import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

interface PackedPackage {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly shasum: string;
  readonly integrity: string;
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly [key: string]: unknown;
}

export interface ShippedPackageRegistry {
  readonly origin: string;
  readonly packages: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
    readonly tarball: string;
    readonly sha256: string;
  }>;
  readonly composition: {
    readonly packageNames: ReadonlyArray<string>;
    readonly consoleFiles: number;
    readonly consoleSha256: string;
  };
  readonly requests: ReadonlyArray<string>;
  readonly assertConsumed: () => void;
  readonly stop: () => void;
}

const digest = (algorithm: "sha1" | "sha256" | "sha512", bytes: Uint8Array): string =>
  new Bun.CryptoHasher(algorithm).update(bytes).digest("hex");

const packedManifest = (tarball: string): PackageManifest => {
  const result = spawnSync("/usr/bin/tar", ["-xOf", tarball, "package/package.json"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`the shipped package manifest could not be read: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as PackageManifest;
};

const pack = (workspace: string, packagePath: string, destination: string): PackedPackage => {
  const packageRoot = join(workspace, packagePath);
  const packageDestination = join(destination, basename(packagePath));
  mkdirSync(packageDestination, { recursive: true });
  const result = spawnSync(process.execPath, ["pm", "pack", "--destination", packageDestination], {
    cwd: packageRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`could not pack ${packagePath}:\n${result.stdout}\n${result.stderr}`);
  }
  const tarballs = readdirSync(packageDestination).filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`${packagePath} produced ${tarballs.length} package archives, not one`);
  }
  const tarball = join(packageDestination, tarballs[0] ?? "");
  const manifest = packedManifest(tarball);
  const bytes = readFileSync(tarball);
  return {
    name: manifest.name,
    version: manifest.version,
    tarball,
    shasum: digest("sha1", bytes),
    integrity: `sha512-${Buffer.from(digest("sha512", bytes), "hex").toString("base64")}`,
  };
};

const filesBelow = (root: string, prefix = ""): ReadonlyArray<string> =>
  readdirSync(join(root, prefix)).flatMap((entry) => {
    const relative = join(prefix, entry);
    const stat = lstatSync(join(root, relative));
    if (stat.isSymbolicLink()) {
      throw new Error(`the built Console contains a symbolic link: ${relative}`);
    }
    return stat.isDirectory() ? filesBelow(root, relative) : [relative];
  });

const archivedFiles = (tarball: string): ReadonlyArray<string> => {
  const result = spawnSync("/usr/bin/tar", ["-tzf", tarball], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`the shipped package inventory could not be read: ${result.stderr}`);
  }
  return result.stdout.split("\n").filter((entry) => entry.length > 0 && !entry.endsWith("/"));
};

const verifyPackedConsole = (
  workspace: string,
  packed: ReadonlyArray<PackedPackage>,
): { readonly consoleFiles: number; readonly consoleSha256: string } => {
  const kojo = packed.find((entry) => entry.name === "@carere/kojo");
  if (kojo === undefined) throw new Error("the shipped package set has no @carere/kojo archive");
  const consoleRoot = join(workspace, "packages", "kojo", "console");
  const localFiles = [...filesBelow(consoleRoot)].sort();
  const archiveFiles = archivedFiles(kojo.tarball)
    .filter((entry) => entry.startsWith("package/console/"))
    .map((entry) => entry.slice("package/console/".length))
    .sort();
  if (
    localFiles.length === 0 ||
    !localFiles.includes("index.html") ||
    localFiles.length !== archiveFiles.length ||
    localFiles.some((entry, index) => entry !== archiveFiles[index])
  ) {
    throw new Error(
      "the @carere/kojo archive does not contain the matching built Console inventory",
    );
  }
  const inventory = localFiles.map((relative) => {
    const archived = spawnSync(
      "/usr/bin/tar",
      ["-xOf", kojo.tarball, `package/console/${relative}`],
      { encoding: "buffer" },
    );
    if (archived.status !== 0) {
      throw new Error(`the packed Console file could not be read: ${relative}`);
    }
    const localHash = digest("sha256", readFileSync(join(consoleRoot, relative)));
    const archiveHash = digest("sha256", archived.stdout);
    if (localHash !== archiveHash) {
      throw new Error(`the packed Console file differs from the tested build: ${relative}`);
    }
    return `${relative}\0${archiveHash}`;
  });
  return {
    consoleFiles: inventory.length,
    consoleSha256: digest("sha256", Buffer.from(inventory.join("\n"))),
  };
};

const packageName = (path: string): string | undefined => {
  const decoded = decodeURIComponent(path.slice(1));
  return decoded.startsWith("@carere/") ? decoded : undefined;
};

/**
 * Serve exact `bun pm pack` output as a private scoped registry.
 *
 * The upstream proxy is only for public dependencies. Every `@carere` request must resolve from
 * the four archives built from this checkout, so a registry release cannot hide a missing package.
 */
export const startShippedPackageRegistry = async (options: {
  readonly workspace: string;
  readonly destination: string;
}): Promise<ShippedPackageRegistry> => {
  const packagePaths = [
    "packages/kojo",
    "packages/kojo-runtime",
    "packages/kojo-client-contracts",
    "packages/kojo-runner-contracts",
  ] as const;
  const packed = packagePaths.map((path) => pack(options.workspace, path, options.destination));
  const expectedNames = [
    "@carere/kojo",
    "@carere/kojo-client-contracts",
    "@carere/kojo-runner-contracts",
    "@carere/kojo-runtime",
  ];
  const actualNames = packed.map((entry) => entry.name).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, i) => name !== expectedNames[i])
  ) {
    throw new Error(`the shipped package set is not exact: ${actualNames.join(", ")}`);
  }
  const consoleComposition = verifyPackedConsole(options.workspace, packed);
  const byName = new Map(packed.map((entry) => [entry.name, entry] as const));
  const requests: string[] = [];

  let origin = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      const tarballMatch = url.pathname.match(/^\/tarballs\/([^/]+)$/);
      if (tarballMatch !== null) {
        const selected = packed.find((entry) => basename(entry.tarball) === tarballMatch[1]);
        return selected === undefined
          ? new Response("not found\n", { status: 404 })
          : new Response(Bun.file(selected.tarball), {
              headers: { "content-type": "application/octet-stream" },
            });
      }

      const selectedName = packageName(url.pathname);
      if (selectedName !== undefined) {
        const selected = byName.get(selectedName);
        if (selected === undefined) {
          return Response.json(
            { error: `the shipped registry has no ${selectedName}` },
            { status: 404 },
          );
        }
        const manifest = packedManifest(selected.tarball);
        const tarball: string = `${origin}/tarballs/${basename(selected.tarball)}`;
        return Response.json({
          name: selected.name,
          "dist-tags": { latest: selected.version },
          versions: {
            [selected.version]: {
              ...manifest,
              dist: {
                tarball,
                shasum: selected.shasum,
                integrity: selected.integrity,
              },
            },
          },
        });
      }

      const upstream = await fetch(`https://registry.npmjs.org${url.pathname}${url.search}`, {
        headers: { accept: request.headers.get("accept") ?? "application/json" },
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        },
      });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;

  const assertConsumed = (): void => {
    const requestPaths = requests.map((request) => {
      const path = request.slice(request.indexOf(" ") + 1);
      try {
        return decodeURIComponent(path);
      } catch {
        return path;
      }
    });
    for (const entry of packed) {
      if (!requestPaths.includes(`/${entry.name}`)) {
        throw new Error(`the shipped installation did not request ${entry.name} metadata`);
      }
      if (!requestPaths.includes(`/tarballs/${basename(entry.tarball)}`)) {
        throw new Error(`the shipped installation did not consume ${entry.name} archive`);
      }
    }
  };

  return {
    origin,
    packages: packed.map((entry) => ({
      name: entry.name,
      version: entry.version,
      tarball: basename(entry.tarball),
      sha256: digest("sha256", readFileSync(entry.tarball)),
    })),
    composition: {
      packageNames: actualNames,
      ...consoleComposition,
    },
    requests,
    assertConsumed,
    stop: () => server.stop(true),
  };
};
