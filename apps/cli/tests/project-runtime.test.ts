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
        boundaries.push((await request.json()) as Record<string, unknown>);
        return Response.json({ status: "recorded" });
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
          idempotencyKey: "run-1:activity:echo:1:Activity.Started",
          leaseGeneration: 1,
          leaseHolder: "lease-holder",
          operation: "Activity.Started",
          subject: "echo",
        }),
        expect.objectContaining({
          idempotencyKey: "run-1:activity:echo:1:Activity.Completed",
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
});
