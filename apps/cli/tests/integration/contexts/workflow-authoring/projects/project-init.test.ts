import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startKojoHostProcess } from "../../../../../../../tests/support/host-process";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("kojo init", () => {
  it("initializes the nearest Git working tree without replacing developer files", async () => {
    const directory = await temporaryDirectory("kojo-init-");
    const project = join(directory, "project");
    await run(["git", "init", project]);
    await writeFile(join(project, "README.md"), "developer source\n");
    await writeFile(join(project, "package.json"), '{"private":true}\n');
    await writeFile(join(project, "bun.lock"), "developer lockfile\n");
    await writeFile(join(project, ".gitignore"), "dist/\n");
    const nested = join(project, "src", "nested");
    await run(["mkdir", "-p", nested]);
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);

    const first = await runCli(["init", nested], host.socketPath, directory);
    const canonicalProject = await realpath(project);

    expect(first).toEqual({
      exitCode: 0,
      stdout: expect.stringContaining(`Initialized Kojo Project at ${canonicalProject}`),
      stderr: "",
    });
    expect(await readFile(join(project, "README.md"), "utf8")).toBe("developer source\n");
    expect(await readFile(join(project, "package.json"), "utf8")).toBe('{"private":true}\n');
    expect(await readFile(join(project, "bun.lock"), "utf8")).toBe("developer lockfile\n");
    expect(await readFile(join(project, ".gitignore"), "utf8")).toBe("dist/\n/.kojo/\n");
    expect(await readFile(join(project, "kojo.config.ts"), "utf8")).toBe(
      'import { defineConfig } from "@kojo/workflow";\n\nexport default defineConfig({ workflows: [] });\n',
    );
    const metadata = JSON.parse(await readFile(join(project, ".kojo", "project.json"), "utf8"));
    expect(metadata).toEqual({
      layoutVersion: 1,
      projectIdentity: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(await readFile(join(project, ".kojo", "project.json"), "utf8")).toMatch(/\n$/);
    expect((await stat(join(project, ".kojo"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(project, ".kojo", "project.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(project, ".kojo", "kojo.sqlite"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(project, ".kojo", "artifacts"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(project, ".kojo", "sandboxes"))).mode & 0o777).toBe(0o700);

    const before = await snapshotFiles(project);
    const second = await runCli(["init", project], host.socketPath, directory);
    const after = await snapshotFiles(project);

    expect(second.exitCode).toBe(0);
    expect(after).toEqual(before);
    expect(second.stdout).toContain(`Project Identity: ${metadata.projectIdentity}`);
  });

  it("makes no change outside a Git working tree or when an owned path is a symbolic link", async () => {
    const directory = await temporaryDirectory("kojo-init-safe-failure-");
    const outside = join(directory, "outside");
    await run(["mkdir", "-p", outside]);

    const outsideResult = await runCli(
      ["init", outside],
      join(directory, "unused.sock"),
      directory,
    );

    expect(outsideResult.exitCode).toBe(1);
    expect(outsideResult.stderr).toContain("not inside a non-bare Git working tree");
    expect(await pathsExist(outside, ["kojo.config.ts", ".gitignore", ".kojo"])).toEqual([
      false,
      false,
      false,
    ]);

    const project = join(directory, "project");
    await run(["git", "init", project]);
    await writeFile(join(project, "developer-config.ts"), "export default {};\n");
    await symlink("developer-config.ts", join(project, "kojo.config.ts"));

    const conflictResult = await runCli(
      ["init", project],
      join(directory, "unused.sock"),
      directory,
    );

    expect(conflictResult.exitCode).toBe(1);
    expect(conflictResult.stderr).toContain("kojo.config.ts is a symbolic link");
    expect((await lstat(join(project, "kojo.config.ts"))).isSymbolicLink()).toBe(true);
    expect(await pathsExist(project, [".gitignore", ".kojo"])).toEqual([false, false]);
  });

  it("preserves an existing configuration and equivalent Project-local ignore rule", async () => {
    const directory = await temporaryDirectory("kojo-init-adopt-");
    const project = join(directory, "project");
    await run(["git", "init", project]);
    const configuration =
      'import { defineConfig } from "@kojo/workflow";\n\nexport default defineConfig({ workflows: [] });\n// developer note\n';
    await writeFile(join(project, "kojo.config.ts"), configuration);
    await writeFile(join(project, ".gitignore"), ".kojo/\n");
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);

    const result = await runCli(["init", project], host.socketPath, directory);

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(project, "kojo.config.ts"), "utf8")).toBe(configuration);
    expect(await readFile(join(project, ".gitignore"), "utf8")).toBe(".kojo/\n");
  });

  it("gives clones and linked working trees distinct Project Identities", async () => {
    const directory = await temporaryDirectory("kojo-init-identities-");
    const project = join(directory, "project");
    const linked = join(directory, "linked");
    const clone = join(directory, "clone");
    const containingProject = join(directory, "containing-project");
    const submodule = join(containingProject, "submodule");
    await run(["git", "init", project]);
    await writeFile(join(project, "README.md"), "source\n");
    await run(["git", "-C", project, "add", "README.md"]);
    await run([
      "git",
      "-C",
      project,
      "-c",
      "user.name=Kojo Test",
      "-c",
      "user.email=kojo@example.test",
      "commit",
      "-m",
      "initial",
    ]);
    await run(["git", "-C", project, "worktree", "add", linked]);
    await run(["git", "clone", project, clone]);
    await run(["git", "init", containingProject]);
    await run([
      "git",
      "-C",
      containingProject,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      project,
      "submodule",
    ]);
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);

    for (const path of [project, linked, clone, submodule]) {
      expect((await runCli(["init", path], host.socketPath, directory)).exitCode).toBe(0);
    }

    const identities = await Promise.all(
      [project, linked, clone, submodule].map(async (path) =>
        JSON.parse(await readFile(join(path, ".kojo", "project.json"), "utf8")),
      ),
    );
    expect(new Set(identities.map(({ projectIdentity }) => projectIdentity)).size).toBe(4);
  });

  it("fails before writing when the working tree cannot be changed", async () => {
    const directory = await temporaryDirectory("kojo-init-permissions-");
    const project = join(directory, "project");
    await run(["git", "init", project]);
    await chmod(project, 0o500);
    cleanups.push(() => chmod(project, 0o700));

    const result = await runCli(["init", project], join(directory, "unused.sock"), directory);

    expect(result.exitCode).toBe(1);
    expect(await pathsExist(project, ["kojo.config.ts", ".gitignore", ".kojo"])).toEqual([
      false,
      false,
      false,
    ]);
  });
});

const temporaryDirectory = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true }));
  return directory;
};

const run = async (command: ReadonlyArray<string>) => {
  const process = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr}`);
};

const runCli = async (args: ReadonlyArray<string>, socketPath: string, cwd: string) => {
  const child = Bun.spawn(["bun", "run", join(process.cwd(), "main.ts"), ...args], {
    cwd,
    env: { ...process.env, KOJO_HOST_SOCKET: socketPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const snapshotFiles = async (project: string) => {
  const paths = [
    "kojo.config.ts",
    ".gitignore",
    "package.json",
    "bun.lock",
    ".kojo/project.json",
    ".kojo/kojo.sqlite",
  ];
  return Promise.all(
    paths.map(async (path) => {
      const fullPath = join(project, path);
      return { path, contents: await readFile(fullPath), modified: (await stat(fullPath)).mtimeMs };
    }),
  );
};

const pathsExist = (directory: string, paths: ReadonlyArray<string>) =>
  Promise.all(
    paths.map(async (path) => {
      try {
        await lstat(join(directory, path));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }),
  );
