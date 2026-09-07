import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { linkEngine } from "../../../../support/linkEngine.ts";
import { revisionFixture } from "../../../../support/workflow/revisionFixture.ts";

it("isolates retained content, objects, and manifest data between fixture owners", () => {
  const root = mkdtempSync(join(tmpdir(), "kojo-revision-isolation-"));
  const fixture = revisionFixture("compile");
  try {
    const project = join(root, "project");
    mkdirSync(join(project, ".kojo", "workflows"), { recursive: true });
    writeFileSync(join(project, "package.json"), '{"name":"revision-fixture","private":true}');
    writeFileSync(join(project, ".kojo", "factory.json"), '{"formatVersion":1,"assets":[]}');
    const source = 'export const compile = "capture without execution";\n';
    writeFileSync(join(project, ".kojo", "workflows", "compile.ts"), source);
    linkEngine({
      root: project,
      packageRoot: new URL("../../../../../", import.meta.url).pathname,
    });

    const firstRoot = join(root, "first");
    const first = fixture.install(project, firstRoot);
    const manifest = structuredClone(first.manifest);
    const hash = first.manifest.sources[0]?.sha256 ?? "";
    const retainedSource = join("factory", "sources", "workflows", "compile.ts");
    writeFileSync(join(first.publishedPath, retainedSource), "changed by first owner");
    writeFileSync(join(firstRoot, "objects", hash), "changed object");
    writeFileSync(join(firstRoot, "kojo.db"), "private owner state");
    Object.assign(first.manifest, { workflowName: "changed manifest" });

    const secondRoot = join(root, "second");
    const second = fixture.install(project, secondRoot);
    rmSync(firstRoot, { recursive: true });
    fixture.dispose();
    expect(readFileSync(join(second.publishedPath, retainedSource), "utf8")).toBe(source);
    expect(readFileSync(join(secondRoot, "objects", hash), "utf8")).toBe(source);
    expect(second.manifest).toEqual(manifest);
    expect(existsSync(join(secondRoot, "kojo.db"))).toBe(false);
    expect(statSync(join(secondRoot, "revisions")).mode & 0o777).toBe(0o700);
    expect(statSync(join(secondRoot, "objects", hash)).mode & 0o777).toBe(0o600);
  } finally {
    fixture.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
