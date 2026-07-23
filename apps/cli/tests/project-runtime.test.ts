import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBindMountSandboxProvider, createIsolatedSandboxProvider } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import {
  decodeProjectRuntimeResult,
  localDockerSandboxOptions,
  localSandboxOptions,
} from "../src/system/project-runtime";

const cleanup = new Set<string>();

afterEach(async () => {
  for (const path of cleanup) await rm(path, { force: true, recursive: true });
  cleanup.clear();
});

describe("Project Runtime Process", () => {
  test("anchors the local Docker Sandbox fallback to the registered Project", () => {
    const options = localDockerSandboxOptions("/registered/project", "sandcastle:kojo", {
      baseBranch: "920ff25",
      branch: "sandcastle/workstream-26/issue-36",
    });

    expect(options).toMatchObject({
      baseBranch: "920ff25",
      branch: "sandcastle/workstream-26/issue-36",
      cwd: "/registered/project",
    });
  });

  test("anchors every Sandcastle Sandbox Provider to the registered Project", () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("not created by this options test");
    };
    const providers = [
      noSandbox(),
      createBindMountSandboxProvider({ name: "custom-bind-mount", create: unavailable }),
      createIsolatedSandboxProvider({ name: "custom-isolated", create: unavailable }),
    ];

    for (const sandbox of providers) {
      const options = localSandboxOptions("/registered/project", sandbox, {
        branch: "sandcastle/custom-provider",
      });

      expect(options.cwd).toBe("/registered/project");
      expect(options.sandbox).toBe(sandbox);
    }
  });

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
          projectPath: fixture,
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

  test("executes a keyed Child Workflow with its own durable run scope", async () => {
    const fixture = await mkdtemp(join(resolve(import.meta.dir, "../../.."), ".runtime-test-"));
    cleanup.add(fixture);
    const socketDirectory = await mkdtemp(join(tmpdir(), "kojo-runtime-child-socket-"));
    cleanup.add(socketDirectory);
    const socket = join(socketDirectory, "system.sock");
    const requests: Array<{ readonly body: Record<string, unknown>; readonly path: string }> = [];
    const server = Bun.serve({
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as Record<string, unknown>;
        requests.push({ body, path });
        if (path.endsWith("/children")) {
          return Response.json({
            attempt: 1,
            leaseGeneration: 1,
            leaseHolder: "lease-holder",
            outcome: null,
            runId: "run-child",
            state: "Running",
            status: "created",
          });
        }
        if (path.endsWith("/children/finalize")) return Response.json({ state: "Completed" });
        return Response.json({
          status: body.operation === "Activity.Started" ? "execute" : "recorded",
        });
      },
      unix: socket,
    });
    await Bun.write(
      join(fixture, "workflow.ts"),
      `import { Effect, Schema } from "../packages/workflow/node_modules/effect/src/index.ts";
import { Activity } from "../packages/workflow/node_modules/effect/src/unstable/workflow/index.ts";
import { Workflow, defineConfig } from "../packages/workflow/src/index.ts";
const child = Workflow.make("child", {
  version: "v1", entryPoint: "workflow.ts", input: Schema.String, success: Schema.String,
  failure: Schema.Never,
  run: (message) => Activity.make({ name: "child-echo", success: Schema.String, execute: Effect.succeed(message) }),
});
const parent = Workflow.make("parent", {
  version: "v1", entryPoint: "workflow.ts", input: Schema.String, success: Schema.String,
  failure: Schema.Never, run: (message) => child.run("stable-child", message),
});
export default defineConfig({ workflows: [parent, child] });
`,
    );

    try {
      const runtimeRequest = Buffer.from(
        JSON.stringify({
          attempt: 1,
          configPath: "workflow.ts",
          endpoint: socket,
          input: "hello child",
          leaseGeneration: 1,
          leaseHolder: "lease-holder",
          mode: "execute",
          projectId: "project-1",
          projectPath: fixture,
          rootRunId: "run-root",
          runId: "run-root",
          workflowName: "parent",
        }),
      ).toString("base64url");
      const runtimeProcess = Bun.spawn(
        [process.execPath, "run", resolve(import.meta.dir, "../main.ts")],
        {
          cwd: fixture,
          env: {
            ...Bun.env,
            KOJO_INTERNAL_PROJECT_RUNTIME: "1",
            KOJO_RUNTIME_REQUEST: runtimeRequest,
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const [exitCode, stderr, stdout] = await Promise.all([
        runtimeProcess.exited,
        new Response(runtimeProcess.stderr).text(),
        new Response(runtimeProcess.stdout).text(),
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(decodeProjectRuntimeResult(stdout)).toEqual({
        state: "Completed",
        value: "hello child",
      });
      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/v1/workflow-runs/run-root/children" }),
          expect.objectContaining({
            body: expect.objectContaining({ runId: "run-child" }),
            path: "/v1/workflow-runs/run-child/boundaries",
          }),
          expect.objectContaining({ path: "/v1/workflow-runs/run-child/children/finalize" }),
        ]),
      );
    } finally {
      server.stop(true);
    }
  });

  test("binds Child Workflow keys within the parent durable path and resets the child path", async () => {
    const fixture = await mkdtemp(join(resolve(import.meta.dir, "../../.."), ".runtime-test-"));
    cleanup.add(fixture);
    const socketDirectory = await mkdtemp(join(tmpdir(), "kojo-runtime-child-path-socket-"));
    cleanup.add(socketDirectory);
    const socket = join(socketDirectory, "system.sock");
    const requests: Array<{ readonly body: Record<string, unknown>; readonly path: string }> = [];
    let childOrdinal = 0;
    const server = Bun.serve({
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as Record<string, unknown>;
        requests.push({ body, path });
        if (path.endsWith("/children")) {
          childOrdinal += 1;
          return Response.json({
            attempt: 1,
            leaseGeneration: 1,
            leaseHolder: "lease-holder",
            outcome: null,
            runId: `run-child-${childOrdinal}`,
            state: "Running",
            status: "created",
          });
        }
        if (path.endsWith("/children/finalize")) return Response.json({ state: "Completed" });
        return Response.json({
          status: body.operation === "Activity.Started" ? "execute" : "recorded",
        });
      },
      unix: socket,
    });
    await Bun.write(
      join(fixture, "workflow.ts"),
      `import { Effect, Schema } from "../packages/workflow/node_modules/effect/src/index.ts";
import { Activity } from "../packages/workflow/node_modules/effect/src/unstable/workflow/index.ts";
import { Loop, Workflow, defineConfig } from "../packages/workflow/src/index.ts";
const child = Workflow.make("child", {
  version: "v1", entryPoint: "workflow.ts", input: Schema.String, success: Schema.String,
  failure: Schema.Never,
  run: (message) => Activity.make({ name: "child-echo", success: Schema.String, execute: Effect.succeed(message) }),
});
const parent = Workflow.make("parent", {
  version: "v1", entryPoint: "workflow.ts", input: Schema.String, success: Schema.String,
  failure: Loop.MaximumLimitReached,
  run: (message) => Loop.run("tickets", {
    maxIterations: 2,
    effect: ({ iteration }) => child.run("stable-child", message + "-" + iteration),
    repeatWhile: (value) => value.endsWith("-1"),
  }),
});
export default defineConfig({ workflows: [parent, child] });
`,
    );

    try {
      const runtimeRequest = Buffer.from(
        JSON.stringify({
          attempt: 1,
          configPath: "workflow.ts",
          endpoint: socket,
          input: "hello",
          leaseGeneration: 1,
          leaseHolder: "lease-holder",
          mode: "execute",
          projectId: "project-1",
          projectPath: fixture,
          rootRunId: "run-root",
          runId: "run-root",
          workflowName: "parent",
        }),
      ).toString("base64url");
      const runtimeProcess = Bun.spawn(
        [process.execPath, "run", resolve(import.meta.dir, "../main.ts")],
        {
          cwd: fixture,
          env: {
            ...Bun.env,
            KOJO_INTERNAL_PROJECT_RUNTIME: "1",
            KOJO_RUNTIME_REQUEST: runtimeRequest,
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const [exitCode, stderr, stdout] = await Promise.all([
        runtimeProcess.exited,
        new Response(runtimeProcess.stderr).text(),
        new Response(runtimeProcess.stdout).text(),
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(decodeProjectRuntimeResult(stdout)).toEqual({ state: "Completed", value: "hello-2" });
      expect(
        requests
          .filter(({ path }) => path.endsWith("/children"))
          .map(({ body }) => body.invocationKey),
      ).toEqual(['["tickets[1]","stable-child"]', '["tickets[2]","stable-child"]']);
      expect(
        requests
          .filter(
            ({ body, path }) =>
              path.includes("run-child-") && body.operation === "Activity.Started",
          )
          .map(({ body }) => body.subject),
      ).toEqual(["child-echo", "child-echo"]);
    } finally {
      server.stop(true);
    }
  });

  test("propagates suspension from a Child Workflow boundary without finalizing it as failed", async () => {
    const fixture = await mkdtemp(join(resolve(import.meta.dir, "../../.."), ".runtime-test-"));
    cleanup.add(fixture);
    const socketDirectory = await mkdtemp(join(tmpdir(), "kojo-runtime-child-suspend-socket-"));
    cleanup.add(socketDirectory);
    const socket = join(socketDirectory, "system.sock");
    const paths: Array<string> = [];
    const server = Bun.serve({
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as Record<string, unknown>;
        paths.push(path);
        if (path.endsWith("/children")) {
          return Response.json({
            attempt: 1,
            leaseGeneration: 1,
            leaseHolder: "lease-holder",
            outcome: null,
            runId: "run-child",
            state: "Running",
            status: "created",
          });
        }
        if (path.endsWith("/children/finalize")) {
          return Response.json({ error: "Child is already Suspended" }, { status: 409 });
        }
        return Response.json({
          status:
            body.operation === "Activity.Started"
              ? "execute"
              : body.operation === "Activity.Completed"
                ? "suspend"
                : "recorded",
        });
      },
      unix: socket,
    });
    await Bun.write(
      join(fixture, "workflow.ts"),
      `import { Effect, Schema } from "../packages/workflow/node_modules/effect/src/index.ts";
import { Activity } from "../packages/workflow/node_modules/effect/src/unstable/workflow/index.ts";
import { Workflow, defineConfig } from "../packages/workflow/src/index.ts";
const child = Workflow.make("child", {
  version: "v1", entryPoint: "workflow.ts", input: Schema.Void, success: Schema.String,
  failure: Schema.Never,
  run: () => Activity.make({ name: "child-work", success: Schema.String, execute: Effect.succeed("done") }),
});
const parent = Workflow.make("parent", {
  version: "v1", entryPoint: "workflow.ts", input: Schema.Void, success: Schema.String,
  failure: Schema.Never, run: () => child.run("stable-child", undefined),
});
export default defineConfig({ workflows: [parent, child] });
`,
    );

    try {
      const runtimeRequest = Buffer.from(
        JSON.stringify({
          attempt: 1,
          configPath: "workflow.ts",
          endpoint: socket,
          leaseGeneration: 1,
          leaseHolder: "lease-holder",
          mode: "execute",
          projectId: "project-1",
          projectPath: fixture,
          rootRunId: "run-root",
          runId: "run-root",
          workflowName: "parent",
        }),
      ).toString("base64url");
      const runtimeProcess = Bun.spawn(
        [process.execPath, "run", resolve(import.meta.dir, "../main.ts")],
        {
          cwd: fixture,
          env: {
            ...Bun.env,
            KOJO_INTERNAL_PROJECT_RUNTIME: "1",
            KOJO_RUNTIME_REQUEST: runtimeRequest,
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const [exitCode, stderr, stdout] = await Promise.all([
        runtimeProcess.exited,
        new Response(runtimeProcess.stderr).text(),
        new Response(runtimeProcess.stdout).text(),
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(decodeProjectRuntimeResult(stdout)).toEqual({ state: "Suspended" });
      expect(paths.some((path) => path.endsWith("/children/finalize"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("does not run Compensation when a settled Activity suspends the Workflow Run", async () => {
    const fixture = await mkdtemp(join(resolve(import.meta.dir, "../../.."), ".runtime-test-"));
    cleanup.add(fixture);
    const socket = join(await mkdtemp(join(tmpdir(), "kojo-runtime-socket-")), "system.sock");
    cleanup.add(socket.slice(0, socket.lastIndexOf("/")));
    const server = Bun.serve({
      async fetch(request) {
        const boundary = (await request.json()) as Record<string, unknown>;
        return Response.json({
          status:
            boundary.operation === "Activity.Started"
              ? "execute"
              : boundary.operation === "Activity.Completed"
                ? "suspended"
                : "recorded",
        });
      },
      unix: socket,
    });
    await Bun.write(
      join(fixture, "workflow.ts"),
      `import { Effect, Schema } from "../packages/workflow/node_modules/effect/src/index.ts";
import { Activity, Workflow as EffectWorkflow } from "../packages/workflow/node_modules/effect/src/unstable/workflow/index.ts";
import { Workflow, defineConfig } from "../packages/workflow/src/index.ts";
const example = Workflow.make("example", {
  version: "v1",
  entryPoint: "workflow.ts",
  input: Schema.Void,
  success: Schema.String,
  failure: Schema.Never,
  run: () => EffectWorkflow.withCompensation(
    Activity.make({ name: "create", success: Schema.String, execute: Effect.succeed("created") }),
    () => Effect.promise(() => Bun.write("compensated", "yes")).pipe(Effect.asVoid),
  ),
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
          input: undefined,
          leaseGeneration: 1,
          leaseHolder: "lease-holder",
          mode: "execute",
          projectId: "project-1",
          projectPath: fixture,
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
      expect(decodeProjectRuntimeResult(stdout)).toEqual({ state: "Suspended" });
      expect(await Bun.file(join(fixture, "compensated")).exists()).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("does not run Compensation when a durable clock boundary discards the Workflow Run", async () => {
    const fixture = await mkdtemp(join(resolve(import.meta.dir, "../../.."), ".runtime-test-"));
    cleanup.add(fixture);
    const socket = join(await mkdtemp(join(tmpdir(), "kojo-runtime-socket-")), "system.sock");
    cleanup.add(socket.slice(0, socket.lastIndexOf("/")));
    const server = Bun.serve({
      async fetch(request) {
        const boundary = (await request.json()) as Record<string, unknown>;
        if (request.url.endsWith("/journal/read")) {
          return Response.json({ status: "missing" });
        }
        return Response.json({
          status:
            boundary.operation === "Activity.Started"
              ? "execute"
              : boundary.operation === "DurableClock.Scheduled"
                ? "discard"
                : "recorded",
        });
      },
      unix: socket,
    });
    await Bun.write(
      join(fixture, "workflow.ts"),
      `import { Effect, Schema } from "../packages/workflow/node_modules/effect/src/index.ts";
import { Activity, DurableClock, Workflow as EffectWorkflow } from "../packages/workflow/node_modules/effect/src/unstable/workflow/index.ts";
import { Workflow, defineConfig } from "../packages/workflow/src/index.ts";
const example = Workflow.make("example", {
  version: "v1",
  entryPoint: "workflow.ts",
  input: Schema.Void,
  success: Schema.String,
  failure: Schema.Never,
  run: () => EffectWorkflow.withCompensation(
    Activity.make({ name: "create", success: Schema.String, execute: Effect.succeed("created") }),
    () => Effect.promise(() => Bun.write("compensated", "yes")).pipe(Effect.asVoid),
  ).pipe(
    Effect.andThen(DurableClock.sleep({ duration: "2 minutes", name: "discard-here" })),
    Effect.as("done"),
  ),
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
          input: undefined,
          leaseGeneration: 1,
          leaseHolder: "lease-holder",
          mode: "execute",
          projectId: "project-1",
          projectPath: fixture,
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
      expect(decodeProjectRuntimeResult(stdout)).toEqual({ state: "Discarded" });
      expect(await Bun.file(join(fixture, "compensated")).exists()).toBe(false);
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
          projectPath: fixture,
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
          projectPath: fixture,
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
