import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const packageDirectory = resolve(process.argv[2] ?? "");
const addressFile = resolve(process.argv[3] ?? "");
if (packageDirectory.length === 0 || addressFile.length === 0) {
  throw new Error("usage: shippedPackageRegistry.ts PACKAGE_DIRECTORY ADDRESS_FILE");
}

interface PackageEntry {
  readonly manifest: Record<string, unknown> & { readonly name: string; readonly version: string };
  readonly tarball: string;
  readonly sha1: string;
}

const entries = new Map<string, PackageEntry>();
for (const file of readdirSync(packageDirectory).filter((candidate) =>
  candidate.endsWith(".tgz"),
)) {
  const tarball = join(packageDirectory, file);
  const extracted = Bun.spawnSync(["tar", "-xOf", tarball, "package/package.json"]);
  if (extracted.exitCode !== 0) throw new Error(`the shipped registry cannot read ${file}`);
  const manifest = JSON.parse(extracted.stdout.toString()) as PackageEntry["manifest"];
  entries.set(manifest.name, {
    manifest,
    tarball,
    sha1: createHash("sha1").update(readFileSync(tarball)).digest("hex"),
  });
}
if (entries.size !== 4) throw new Error(`the shipped registry found ${entries.size} packages`);

let registryOrigin = "";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/tarballs/")) {
      const selected = [...entries.values()].find(
        (entry) => basename(entry.tarball) === url.pathname.slice("/tarballs/".length),
      );
      return selected === undefined
        ? new Response("not found", { status: 404 })
        : new Response(Bun.file(selected.tarball));
    }
    const name = decodeURIComponent(url.pathname.slice(1));
    const selected = entries.get(name);
    if (selected !== undefined) {
      return Response.json({
        name,
        "dist-tags": { latest: selected.manifest.version },
        versions: {
          [selected.manifest.version]: {
            ...selected.manifest,
            dist: {
              tarball: `${registryOrigin}/tarballs/${basename(selected.tarball)}`,
              shasum: selected.sha1,
            },
          },
        },
      });
    }
    const upstream = await fetch(`https://registry.npmjs.org${url.pathname}${url.search}`, {
      headers: { accept: request.headers.get("accept") ?? "application/json" },
    });
    const headers = new Headers(upstream.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
});

registryOrigin = `http://${server.hostname}:${server.port}`;
writeFileSync(addressFile, `${registryOrigin}\n`, { mode: 0o600 });
await new Promise<never>(() => undefined);
