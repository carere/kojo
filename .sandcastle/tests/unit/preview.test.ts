import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { parseGitWorktrees } from "../../src/shared/git";
import { WorkflowError } from "../../src/types/errors";
import { DockerRunInput, PreviewOptions } from "../../src/types/preview";
import { buildDockerRunArguments, parsePublishedPort } from "../../src/workflows/preview/docker";
import { createPreviewIdentity } from "../../src/workflows/preview/identity";
import { hasPreviewBlockingChanges } from "../../src/workflows/preview/worktree";
import { runEffect, runFailure } from "../helpers/effect";

const decodeDockerRunInput = Schema.decodeUnknownSync(DockerRunInput);
const decodePreviewOptions = Schema.decodeUnknownSync(PreviewOptions);

describe("preview options", () => {
  test("decodes start and stop commands", () => {
    expect(decodePreviewOptions({ action: "start", branch: "feat/quotes" })).toMatchObject({
      action: "start",
      branch: "feat/quotes",
    });
    expect(decodePreviewOptions({ action: "stop", branch: "feat/quotes" })).toMatchObject({
      action: "stop",
      branch: "feat/quotes",
    });
  });

  test("rejects missing branches and unknown actions through the schema error channel", async () => {
    const missingBranch = await runFailure(
      Schema.decodeUnknownEffect(PreviewOptions)({ action: "start" }),
    );
    const unknownAction = await runFailure(
      Schema.decodeUnknownEffect(PreviewOptions)({ action: "restart", branch: "feat/quotes" }),
    );

    expect(missingBranch).toMatchObject({ _tag: "SchemaError" });
    expect(missingBranch.message).toContain("branch");
    expect(unknownAction).toMatchObject({ _tag: "SchemaError" });
    expect(unknownAction.message).toContain('"start" | "stop"');
  });
});

describe("preview identity", () => {
  test("derives a stable branch hostname and container name", () => {
    const identity = createPreviewIdentity("feat/Quote Simulator", "/repo/delimoov");

    expect(identity.hostname).toMatch(/^feat-quote-simulator-[a-f0-9]{8}\.delimoov\.localhost$/);
    expect(identity.containerName).toMatch(
      /^delimoov-preview-feat-quote-simulator-[a-f0-9]{8}-[a-f0-9]{6}$/,
    );
    expect(createPreviewIdentity("feat/Quote Simulator", "/repo/delimoov")).toEqual(identity);
  });

  test("avoids collisions after sanitizing branch names", () => {
    const first = createPreviewIdentity("feat/quote", "/repo/delimoov");
    const second = createPreviewIdentity("feat-quote", "/repo/delimoov");

    expect(first.hostname).not.toBe(second.hostname);
    expect(first.containerName).not.toBe(second.containerName);
  });
});

describe("git worktrees", () => {
  test("parses branch paths including spaces", () => {
    const output = `worktree /repo/delimoov
HEAD abc123
branch refs/heads/main

worktree /repo/delimoov worktrees/feat-quotes
HEAD def456
branch refs/heads/feat/quotes
`;

    expect(parseGitWorktrees(output)).toEqual([
      { path: "/repo/delimoov", branch: "main" },
      { path: "/repo/delimoov worktrees/feat-quotes", branch: "feat/quotes" },
    ]);
  });

  test("allows Proto's preview lockfile but rejects user changes", () => {
    expect(hasPreviewBlockingChanges("?? .protolock\n")).toBe(false);
    expect(hasPreviewBlockingChanges(" M apps/admin/src/app.tsx\n?? .protolock\n")).toBe(true);
    expect(hasPreviewBlockingChanges("?? notes.txt\n")).toBe(true);
  });
});

describe("Docker preview", () => {
  test("publishes only a loopback port and mounts the branch worktree", () => {
    const input = decodeDockerRunInput({
      identity: createPreviewIdentity("feat/quotes", "/repo/delimoov"),
      envExamplePath: "/repo/delimoov/.sandcastle/.env.example",
      gitCommonDirectory: "/repo/delimoov/.git",
      image: "sandcastle:delimoov",
      worktreePath: "/repo/.sandcastle/worktrees/feat-quotes",
      uid: 501,
      gid: 20,
    });
    const args = buildDockerRunArguments(input);

    expect(args).toContain("127.0.0.1::5173");
    expect(args).toContain("/repo/.sandcastle/worktrees/feat-quotes:/home/agent/workspace");
    expect(args).toContain(
      "/repo/delimoov/.sandcastle/.env.example:/home/agent/workspace/.sandcastle/.env:ro",
    );
    expect(args).toContain("/repo/delimoov/.git:/repo/delimoov/.git:ro");
    expect(args).toContain("501:20");
    expect(args).toContain(
      "PATH=/home/agent/preview-bin:/usr/local/bin:/usr/local/bun-node-fallback-bin:/home/agent/.proto/bin:/home/agent/.cargo/bin:/home/agent/.bun/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(args).not.toContain("0.0.0.0::5173");
  });

  test("reads Docker's assigned host port through the Effect error channel", async () => {
    expect(await runEffect(parsePublishedPort("127.0.0.1:6101\n"))).toBe(6101);

    const error = await runFailure(parsePublishedPort("not-a-port"));
    expect(error).toBeInstanceOf(WorkflowError);
    expect(error.message).toContain("invalid port mapping");
  });
});
