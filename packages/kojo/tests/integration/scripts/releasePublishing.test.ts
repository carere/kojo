import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = new URL("../../../../../", import.meta.url).pathname;
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "kojo-release-publish-"));
  temporary.push(directory);
  mkdirSync(join(directory, "packages"));
  mkdirSync(join(directory, "bin"));
  const names = JSON.parse(
    readFileSync(join(root, ".github/release-packages.json"), "utf8"),
  ) as Array<{ name: string }>;
  const version = "0.1.0-alpha.1";
  const packages = names.map(({ name }, index) => {
    const bytes = Buffer.from(`tested package ${index}`);
    const archive = `package-${index}.tgz`;
    writeFileSync(join(directory, "packages", archive), bytes);
    return {
      name,
      version,
      archive,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
  });
  const manifest = {
    formatVersion: 1,
    version,
    baseVersion: "0.1.0",
    stage: "alpha",
    testedRevision: "a".repeat(40),
    evidence: { policy: "core", fullHostEvidence: "not-required" },
    packages,
  };
  const path = join(directory, "release-manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  // This executable replaces only the final publisher. It cannot contact a registry.
  const publisher = join(directory, "bin/bun");
  writeFileSync(
    publisher,
    `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.PUBLISH_LOG, JSON.stringify({args:process.argv.slice(2), token:process.env.NPM_CONFIG_TOKEN})+"\\n");\n`,
  );
  chmodSync(publisher, 0o755);
  return { directory, path, manifest };
};
const execute = async (
  args: string[],
  env: Record<string, string>,
  script = "release-train.ts",
) => {
  const child = Bun.spawn([process.execPath, join(root, ".github/scripts", script), ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
};

describe("npm registry verification", () => {
  it("verifies public archives through full metadata when the install view is absent", async () => {
    const f = fixture();
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.headers.get("accept") !== "application/json") {
          return new Response(null, { status: 404 });
        }
        const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
        const pkg = f.manifest.packages.find((candidate) => candidate.name === name);
        return Response.json({
          versions: { [f.manifest.version]: { dist: { integrity: pkg?.integrity } } },
        });
      },
    });
    try {
      const env = { KOJO_NPM_REGISTRY: server.url.origin };
      const result = await execute(["verify-published", f.path], env);
      expect(result.status, result.stderr).toBe(0);
      expect((await execute(["auth-mode", f.manifest.version], env)).stdout.trim()).toBe("oidc");
      const reused = await execute(["assert-unpublished", f.manifest.version], env);
      expect(reused.status).not.toBe(0);
      expect(reused.stderr).toContain("already exists");
    } finally {
      server.stop(true);
    }
  }, 45_000);
});

describe("npm publication authentication", () => {
  it("exchanges a GitHub identity for a separate npm credential per package", async () => {
    const f = fixture();
    const exchanged: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/identity") {
          expect(url.searchParams.get("audience")).toBe("npm:registry.npmjs.org");
          expect(request.headers.get("authorization")).toBe("Bearer github-request");
          return Response.json({ value: "github-identity" });
        }
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toBe("Bearer github-identity");
        const name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        exchanged.push(name);
        return Response.json({ token: `temporary-${exchanged.length}` });
      },
    });
    try {
      const result = await execute(["publish", f.path, "candidate"], {
        PATH: `${join(f.directory, "bin")}${delimiter}${process.env.PATH}`,
        PUBLISH_LOG: join(f.directory, "published.jsonl"),
        KOJO_NPM_REGISTRY: server.url.origin,
        RELEASE_NPM_AUTH: "oidc",
        ACTIONS_ID_TOKEN_REQUEST_URL: `${server.url.origin}/identity`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request",
        NPM_TOKEN: "must-not-be-used",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(exchanged).toEqual(f.manifest.packages.map((pkg) => pkg.name));
      const published = readFileSync(join(f.directory, "published.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(published.map((entry) => entry.token)).toEqual([
        "temporary-1",
        "temporary-2",
        "temporary-3",
        "temporary-4",
      ]);
      expect(published.every((entry) => entry.args.includes("candidate"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("does not fall back to NPM_TOKEN after an OIDC refusal", async () => {
    const f = fixture();
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === "/identity"
          ? Response.json({ value: "identity" })
          : new Response("refused", { status: 403 });
      },
    });
    try {
      const result = await execute(["publish", f.path, "candidate"], {
        RELEASE_NPM_AUTH: "oidc",
        NPM_TOKEN: "must-not-be-used",
        KOJO_NPM_REGISTRY: server.url.origin,
        ACTIONS_ID_TOKEN_REQUEST_URL: `${server.url.origin}/identity`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("npm OIDC exchange failed");
    } finally {
      server.stop(true);
    }
  });

  it("refuses modified archives before authentication or publication", async () => {
    const f = fixture();
    writeFileSync(join(f.directory, "packages/package-0.tgz"), "changed bytes");
    const result = await execute(["publish", f.path, "candidate"], { RELEASE_NPM_AUTH: "oidc" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("archive changed after validation");
  });

  it("chooses bootstrap only for absent packages and only in alpha", async () => {
    let absent = true;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return absent ? new Response(null, { status: 404 }) : Response.json({ versions: {} });
      },
    });
    try {
      const env = { KOJO_NPM_REGISTRY: server.url.origin };
      expect((await execute(["auth-mode", "0.1.0-alpha.1"], env)).stdout.trim()).toBe("bootstrap");
      expect((await execute(["auth-mode", "0.1.0-beta.1"], env)).status).not.toBe(0);
      absent = false;
      expect((await execute(["auth-mode", "0.1.0-beta.1"], env)).stdout.trim()).toBe("oidc");
    } finally {
      server.stop(true);
    }
  });
});

describe("JSR source verification", () => {
  it("checks every source hash and refuses absent package entries", async () => {
    const f = fixture();
    const jsr = ["kojo-client-contracts", "kojo-runner-contracts", "kojo-runtime"].map(
      (directory) => ({
        directory,
        name: `@carere/${directory}`,
        version: f.manifest.version,
        files: { "/jsr.json": "a".repeat(64), "/src/example.ts": "b".repeat(64) },
      }),
    );
    writeFileSync(f.path, JSON.stringify({ ...f.manifest, jsr }));
    let changed = false;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          manifest: {
            "/jsr.json": { checksum: `sha256-${"a".repeat(64)}` },
            "/src/example.ts": { checksum: `sha256-${(changed ? "c" : "b").repeat(64)}` },
          },
        });
      },
    });
    try {
      const env = { KOJO_JSR_REGISTRY: server.url.origin };
      expect((await execute(["verify", f.path], env, "release-jsr.ts")).status).toBe(0);
      changed = true;
      expect((await execute(["verify", f.path], env, "release-jsr.ts")).stderr).toContain(
        "differs from the validated source",
      );
      writeFileSync(f.path, JSON.stringify(f.manifest));
      expect((await execute(["verify", f.path], env, "release-jsr.ts")).stderr).toContain(
        "invalid JSR package set",
      );
    } finally {
      server.stop(true);
    }
  });
});
