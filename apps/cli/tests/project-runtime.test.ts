import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeProjectRuntimeResult } from "../src/system/project-runtime";

const cleanup = new Set<string>();

afterEach(async () => {
  for (const path of cleanup) await rm(path, { force: true, recursive: true });
  cleanup.clear();
});

describe("Project Runtime Process", () => {
  test("runs Effect Activities through durable System Process boundaries", async () => {
    const fixture = await mkdtemp(join(resolve(import.meta.dir, "../../.."), ".runtime-test-"));
    cleanup.add(fixture);
    const socket = join(await mkdtemp(join(tmpdir(), "kojo-runtime-socket-")), "system.sock");
    cleanup.add(socket.slice(0, socket.lastIndexOf("/")));
    const boundaries: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      async fetch(request) {
        const boundary = (await request.json()) as Record<string, unknown>;
        boundaries.push(boundary);
        return Response.json({
          status: boundary.operation === "Activity.Started" ? "execute" : "recorded",
        });
      },
      unix: socket,
    });
    await Bun.write(
      join(fixture, "workflow.ts"),
      `import { Effect, Schema } from "../packages/workflow/node_modules/effect/src/index.ts";
import { Activity } from "../packages/workflow/node_modules/effect/src/unstable/workflow/index.ts";
import { Workflow, defineConfig } from "../packages/workflow/src/index.ts";
const example = Workflow.make("example", {
  version: "v1",
  entryPoint: "workflow.ts",
  input: Schema.Struct({ message: Schema.String }),
  success: Schema.Struct({ echoed: Schema.String }),
  failure: Schema.String,
  run: ({ message }) => Effect.gen(function*() {
    const echoed = yield* Activity.make({
      name: "echo",
      success: Schema.String,
      execute: Effect.succeed(message),
    });
    return { echoed };
  }),
});
export default defineConfig({ workflows: [example] });
`,
    );

    try {
      const request = Buffer.from(
        JSON.stringify({
          configPath: "workflow.ts",
          endpoint: socket,
          input: { message: "hello" },
          leaseGeneration: 1,
          leaseHolder: "lease-holder",
          mode: "execute",
          projectId: "project-1",
          rootRunId: "run-1",
          attempt: 1,
          runId: "run-1",
          workflowName: "example",
        }),
      ).toString("base64url");
      const child = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../main.ts")], {
        cwd: fixture,
        env: {
          ...process.env,
          KOJO_INTERNAL_PROJECT_RUNTIME: "1",
          KOJO_RUNTIME_REQUEST: request,
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);

      expect(stderr).toBe("");
      expect(decodeProjectRuntimeResult(stdout)).toEqual({
        state: "Completed",
        value: { echoed: "hello" },
      });
      expect(exitCode).toBe(0);
      expect(boundaries).toEqual([
        expect.objectContaining({
          idempotencyKey: expect.stringMatching(/^run-1:activity:.+:echo:1:Activity\.Started$/),
          leaseGeneration: 1,
          leaseHolder: "lease-holder",
          operation: "Activity.Started",
          projectId: "project-1",
          rootRunId: "run-1",
          subject: "echo",
        }),
        expect.objectContaining({
          idempotencyKey: expect.stringMatching(/^run-1:activity:.+:echo:1:Activity\.Completed$/),
          leaseGeneration: 1,
          leaseHolder: "lease-holder",
          operation: "Activity.Completed",
          subject: "echo",
        }),
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("replays a completed Activity from the System Process journal", async () => {
    const fixture = await mkdtemp(join(resolve(import.meta.dir, "../../.."), ".runtime-test-"));
    cleanup.add(fixture);
    const socket = join(await mkdtemp(join(tmpdir(), "kojo-runtime-socket-")), "system.sock");
    cleanup.add(socket.slice(0, socket.lastIndexOf("/")));
    const boundaries: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      async fetch(request) {
        const boundary = (await request.json()) as Record<string, unknown>;
        boundaries.push(boundary);
        if (boundary.operation !== "Activity.Started") {
          return Response.json({ error: "replayed Activity executed again" }, { status: 409 });
        }
        return Response.json({
          payload: { _tag: "Complete", exit: { _tag: "Success", value: "from-journal" } },
          status: "replay",
        });
      },
      unix: socket,
    });
    await Bun.write(
      join(fixture, "workflow.ts"),
      `import { Effect, Schema } from "../packages/workflow/node_modules/effect/src/index.ts";
import { Activity } from "../packages/workflow/node_modules/effect/src/unstable/workflow/index.ts";
import { Workflow, defineConfig } from "../packages/workflow/src/index.ts";
const example = Workflow.make("example", {
  version: "v1",
  entryPoint: "workflow.ts",
  input: Schema.Struct({ message: Schema.String }),
  success: Schema.Struct({ echoed: Schema.String }),
  failure: Schema.String,
  run: ({ message }) => Effect.gen(function*() {
    const echoed = yield* Activity.make({
      name: "echo",
      success: Schema.String,
      execute: Effect.succeed(message),
    });
    return { echoed };
  }),
});
export default defineConfig({ workflows: [example] });
`,
    );

    try {
      const request = Buffer.from(
        JSON.stringify({
          attempt: 1,
          configPath: "workflow.ts",
          endpoint: socket,
          input: { message: "must-not-run" },
          leaseGeneration: 1,
          leaseHolder: "lease-holder",
          mode: "execute",
          projectId: "project-1",
          rootRunId: "run-1",
          runId: "run-1",
          workflowName: "example",
        }),
      ).toString("base64url");
      const child = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../main.ts")], {
        cwd: fixture,
        env: {
          ...process.env,
          KOJO_INTERNAL_PROJECT_RUNTIME: "1",
          KOJO_RUNTIME_REQUEST: request,
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);

      expect(stderr).toBe("");
      expect(decodeProjectRuntimeResult(stdout)).toEqual({
        state: "Completed",
        value: { echoed: "from-journal" },
      });
      expect(exitCode).toBe(0);
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0]).toMatchObject({ operation: "Activity.Started", subject: "echo" });
    } finally {
      server.stop(true);
    }
  });

  test("records Recovery Handler boundaries before replay continues", async () => {
    const fixture = await mkdtemp(join(resolve(import.meta.dir, "../../.."), ".runtime-test-"));
    cleanup.add(fixture);
    const socket = join(await mkdtemp(join(tmpdir(), "kojo-runtime-socket-")), "system.sock");
    cleanup.add(socket.slice(0, socket.lastIndexOf("/")));
    const boundaries: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      async fetch(request) {
        const boundary = (await request.json()) as Record<string, unknown>;
        boundaries.push(boundary);
        return Response.json({
          status: boundary.operation === "Activity.Started" ? "execute" : "recorded",
        });
      },
      unix: socket,
    });
    await Bun.write(
      join(fixture, "workflow.ts"),
      `import { Effect, Schema } from "../packages/workflow/node_modules/effect/src/index.ts";
import { Activity } from "../packages/workflow/node_modules/effect/src/unstable/workflow/index.ts";
import { Workflow, defineConfig } from "../packages/workflow/src/index.ts";
let recovered = false;
const failure = Schema.TaggedStruct("Retryable", { reason: Schema.String });
const example = Workflow.make("example", {
  version: "v1",
  entryPoint: "workflow.ts",
  input: Schema.Void,
  success: Schema.String,
  failure,
  recovery: {
    Retryable: () => Activity.make({
      name: "reconcile",
      success: Schema.Void,
      execute: Effect.sync(() => { recovered = true; }),
    }),
  },
  run: () => recovered ? Effect.succeed("recovered") : Effect.fail({ _tag: "Retryable", reason: "repair" }),
});
export default defineConfig({ workflows: [example] });
`,
    );

    try {
      const request = Buffer.from(
        JSON.stringify({
          attempt: 2,
          configPath: "workflow.ts",
          endpoint: socket,
          input: undefined,
          leaseGeneration: 2,
          leaseHolder: "lease-holder",
          mode: "execute",
          projectId: "project-1",
          recoveryFailure: { _tag: "Retryable", reason: "repair" },
          rootRunId: "run-1",
          runId: "run-1",
          workflowName: "example",
        }),
      ).toString("base64url");
      const child = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../main.ts")], {
        cwd: fixture,
        env: {
          ...process.env,
          KOJO_INTERNAL_PROJECT_RUNTIME: "1",
          KOJO_RUNTIME_REQUEST: request,
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(decodeProjectRuntimeResult(stdout)).toEqual({
        state: "Completed",
        value: "recovered",
      });
      expect(boundaries.map(({ operation }) => operation)).toEqual([
        "Recovery.Started",
        "Activity.Started",
        "Activity.Completed",
        "Recovery.Completed",
      ]);
    } finally {
      server.stop(true);
    }
  });
});
