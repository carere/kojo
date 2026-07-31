import { Database } from "bun:sqlite";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { makeTemporaryDirectory, runKojoCli } from "../../../../../../../tests/support/cli-process";
import { startKojoHostProcess } from "../../../../../../../tests/support/host-process";

const cleanups: Array<() => Promise<void>> = [];
const workflowPackagePath = fileURLToPath(
  new URL("../../../../../../../packages/workflow", import.meta.url),
);
const effectPackagePath = fileURLToPath(
  new URL("../../../../../../../apps/host/node_modules/effect", import.meta.url),
);
const cliMainPath = fileURLToPath(
  new URL("../../../../../../../apps/cli/main.ts", import.meta.url),
);
const dockerTestImage = "kojo-sandbox-test:local";
const dockerAvailable =
  Bun.which("docker") !== null &&
  Bun.spawnSync(["docker", "version", "--format", "{{.Server.Version}}"], {
    stderr: "ignore",
    stdout: "ignore",
  }).exitCode === 0;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const initializeGit = async (path: string) => {
  const child = Bun.spawn(["git", "init", path], { stdout: "ignore", stderr: "pipe" });
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
};

const commitInitialGitState = async (path: string) => {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=Kojo Test",
      "-c",
      "user.email=kojo@example.test",
      "commit",
      "--allow-empty",
      "--message",
      "initial",
    ],
    { cwd: path, stdout: "ignore", stderr: "pipe" },
  );
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
};

const installWorkflowDependencies = async (path: string) => {
  await mkdir(join(path, "node_modules", "@kojo"), { recursive: true });
  await symlink(workflowPackagePath, join(path, "node_modules", "@kojo", "workflow"), "dir");
  await symlink(await realpath(effectPackagePath), join(path, "node_modules", "effect"), "dir");
};

const buildDockerTestImage = async (path: string) => {
  await writeFile(
    join(path, "Dockerfile"),
    `FROM alpine:3.21
ARG KOJO_UID
RUN adduser -D -u $KOJO_UID kojo
USER $KOJO_UID
CMD ["sh", "-c", "while true; do sleep 3600; done"]
`,
  );
  const child = Bun.spawn(
    [
      "docker",
      "build",
      "--build-arg",
      `KOJO_UID=${process.getuid?.() ?? 1000}`,
      "--tag",
      dockerTestImage,
      path,
    ],
    { stderr: "pipe", stdout: "ignore" },
  );
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
};

const removeDockerTestImage = async () => {
  const child = Bun.spawn(["docker", "image", "rm", "--force", dockerTestImage], {
    stderr: "ignore",
    stdout: "ignore",
  });
  await child.exited;
};

const configuration = `
import { Effect, Schema } from "effect";
import { Workflow, activity, defineConfig, defineWorkflow } from "@kojo/workflow";

const input = Schema.Struct({ message: Schema.String });
const activityResult = Schema.Struct({ idempotencyKey: Schema.String, invocationNumber: Schema.Number });
let retriedActivityInvocations = 0;
let perRetryActivityInvocations = 0;
export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "echo",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: ({ message }) => Effect.succeed("echo:" + message)
    }),
    defineWorkflow({
      workflowKey: "declared-failure",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: () => Effect.fail("declared")
    }),
    defineWorkflow({
      workflowKey: "defect",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: () => Effect.die("defect")
    }),
    defineWorkflow({
      workflowKey: "invalid-result",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: () => Effect.succeed(42)
    }),
    defineWorkflow({
      workflowKey: "retry-exhausted",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: () => Effect.fail("retry").pipe(Effect.retry({ times: 1 }))
    }),
    defineWorkflow({
      workflowKey: "slow",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: ({ message }) => Effect.sleep("3 seconds").pipe(Effect.as("echo:" + message))
    }),
    defineWorkflow({
      workflowKey: "activity-retry",
      revision: "1",
      inputSchema: input,
      successSchema: activityResult,
      failureSchema: Schema.String,
      handler: () => activity({
        operationKey: "send-message",
        name: "Send message",
        successSchema: activityResult,
        failureSchema: Schema.String,
        retry: { maxRetries: 1, idempotency: "stable" },
        execute: (attempt) => Effect.suspend(() => {
          retriedActivityInvocations += 1;
          return retriedActivityInvocations === 1
            ? Effect.fail("try again")
            : Effect.succeed({ idempotencyKey: attempt.idempotencyKey, invocationNumber: attempt.invocationNumber });
        })
      })
    }),
    defineWorkflow({
      workflowKey: "activity-per-retry",
      revision: "1",
      inputSchema: input,
      successSchema: activityResult,
      failureSchema: Schema.String,
      handler: () => activity({
        operationKey: "send-message-per-retry",
        name: "Send message per retry",
        successSchema: activityResult,
        failureSchema: Schema.String,
        retry: { maxRetries: 1, idempotency: "per-retry" },
        execute: (attempt) => Effect.suspend(() => {
          perRetryActivityInvocations += 1;
          return perRetryActivityInvocations === 1
            ? Effect.fail("try again")
            : Effect.succeed({ idempotencyKey: attempt.idempotencyKey, invocationNumber: attempt.invocationNumber });
        })
      })
    }),
    defineWorkflow({
      workflowKey: "trace-burst",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: () => Effect.gen(function* () {
        // Ensure trace follow has completed history-first setup before the
        // live burst starts; this keeps the window pressure on one active
        // subscription rather than on the initial Trace page.
        yield* Effect.sleep("2 seconds");
        for (let index = 0; index < 12; index += 1) {
          yield* activity({
            operationKey: "burst-" + index,
            name: "Burst " + index,
            successSchema: Schema.String,
            failureSchema: Schema.String,
            execute: () => Effect.succeed("burst-" + index),
          });
        }
        // The test releases this durable barrier only after the live client
        // has received Host-owned resync recovery and opened a new stream.
        // It keeps the Run non-final without relying on a timed delay.
        const deferred = yield* Workflow.deferred({
          operationKey: "release-trace-burst",
          successSchema: Schema.String,
        });
        const release = yield* Workflow.await(deferred);
        return "burst-" + release;
      })
    }),
    defineWorkflow({
      workflowKey: "activity-key-conflict",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: () => Effect.gen(function* () {
        yield* activity({
          operationKey: "conflicting-operation",
          name: "First operation",
          successSchema: Schema.String,
          failureSchema: Schema.String,
          execute: () => Effect.succeed("first")
        });
        return yield* activity({
          operationKey: "conflicting-operation",
          name: "Second operation",
          successSchema: Schema.String,
          failureSchema: Schema.String,
          execute: () => Effect.succeed("second")
        });
      })
    })
  ]
});
`;

const sensitiveConfiguration = `
import { Effect, Schema } from "effect";
import { defineConfig, defineWorkflow } from "@kojo/workflow";

const input = Schema.Struct({
  credentials: Schema.Struct({ token: Schema.String }),
  message: Schema.String,
});
const success = Schema.Struct({ result: Schema.String, token: Schema.String });
export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "sensitive-echo",
      revision: "1",
      inputSchema: input,
      successSchema: success,
      failureSchema: Schema.String,
      sensitivity: { input: ["credentials"], success: ["token"] },
      handler: ({ credentials, message }) => Effect.succeed({ result: "echo:" + message, token: credentials.token })
    })
  ]
});
`;

const childConfiguration = `
import { Effect, Schema } from "effect";
import { Workflow, defineConfig, defineWorkflow } from "@kojo/workflow";
const input = Schema.Struct({ message: Schema.String });
const invokeChild = (invocationKey, workflowKey, message) =>
  Workflow.invokeChild({ invocationKey, workflowKey, input: { message } }).pipe(Effect.map(String));

export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "child",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: ({ message }) => Effect.succeed("child:" + message),
    }),
    defineWorkflow({
      workflowKey: "failing-child",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: () => Effect.fail("child failed"),
    }),
    defineWorkflow({
      workflowKey: "slow-child",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: ({ message }) => Effect.sleep("2 seconds").pipe(Effect.as("slow:" + message)),
    }),
    defineWorkflow({
      workflowKey: "parent",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      childWorkflowKeys: ["child"],
      handler: ({ message }) => invokeChild("child", "child", message),
    }),
    defineWorkflow({
      workflowKey: "parent-reuses-child",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      childWorkflowKeys: ["child"],
      handler: ({ message }) => Effect.gen(function* () {
        const first = yield* invokeChild("reused", "child", message);
        const second = yield* invokeChild("reused", "child", message);
        return first + "," + second;
      }),
    }),
    defineWorkflow({
      workflowKey: "parent-conflicts-child",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      childWorkflowKeys: ["child"],
      handler: ({ message }) => Effect.gen(function* () {
        yield* invokeChild("conflicted", "child", message);
        return yield* invokeChild("conflicted", "child", message + " again");
      }),
    }),
    defineWorkflow({
      workflowKey: "parent-handles-child-failure",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      childWorkflowKeys: ["failing-child"],
      handler: ({ message }) => invokeChild("handled", "failing-child", message).pipe(
        Effect.catchTag("WorkflowChildFailure", () => Effect.succeed("handled")),
      ),
    }),
    defineWorkflow({
      workflowKey: "parent-propagates-child-failure",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      childWorkflowKeys: ["failing-child"],
      handler: ({ message }) => invokeChild("unhandled", "failing-child", message),
    }),
    defineWorkflow({
      workflowKey: "parent-waits-for-child",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      childWorkflowKeys: ["slow-child"],
      handler: ({ message }) => invokeChild("slow", "slow-child", message),
    }),
    defineWorkflow({
      workflowKey: "parent-without-child-declaration",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: ({ message }) => invokeChild("undeclared", "child", message),
    }),
    defineWorkflow({
      workflowKey: "parent-without-invocation-key",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      childWorkflowKeys: ["child"],
      handler: ({ message }) => invokeChild(" ", "child", message),
    }),
  ],
});
`;

const durableWaitConfiguration = `
import { Effect, Schema } from "effect";
import { Workflow, defineConfig, defineWorkflow } from "@kojo/workflow";

const input = Schema.Struct({ message: Schema.String });
export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "manual-wait",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: ({ message }) => Workflow.waitForResume({
        operationKey: "approval",
        valueSchema: Schema.String,
      }).pipe(Effect.map((approval) => message + ":" + approval)),
    }),
    defineWorkflow({
      workflowKey: "deferred-wait",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: ({ message }) => Effect.gen(function* () {
        const deferred = yield* Workflow.deferred({
          operationKey: "approval",
          successSchema: Schema.String,
        });
        const approval = yield* Workflow.await(deferred);
        return message + ":" + approval;
      }),
    }),
  ],
});
`;

const sandboxConfiguration = `
import { Effect, Schema } from "effect";
import { Agent, AgentFailure, AgentResult, Command, CommandFailure, CommandResult, Sandbox, defineCommand, defineConfig, defineCustomAgentProvider, defineCustomSandboxProvider, defineSandbox, defineSandboxImage, defineWorkflow } from "@kojo/workflow";
import { docker } from "@kojo/workflow/sandboxes/docker";
import { unsafeHost } from "@kojo/workflow/sandboxes/unsafe-host";

const input = Schema.Struct({ message: Schema.String });
const provider = unsafeHost({ providerKey: "trusted-local", revision: "1" });
const sandbox = defineSandbox({
  sandboxKey: "local-command",
  revision: "1",
  provider,
});
const changedSandbox = defineSandbox({
  sandboxKey: "local-command",
  revision: "2",
  provider,
});
const dockerSandbox = defineSandbox({
  sandboxKey: "isolated-command",
  revision: "1",
  provider: docker({ providerKey: "local-docker", revision: "1" }),
  image: defineSandboxImage({
    imageKey: "kojo-sandbox-test",
    revision: "1",
    source: { kind: "container-image", reference: "kojo-sandbox-test:local" },
  }),
});
const customSandbox = defineSandbox({
  sandboxKey: "custom-command",
  revision: "1",
  provider: defineCustomSandboxProvider({
    kind: "custom",
    providerKey: "test-custom",
    revision: "1",
    supportsAgentSessionContinuation: true,
    runCommand: ({ command }) =>
      Effect.succeed({ durationMs: 1, exitCode: 0, stderr: "", stdout: "custom:" + command.commandKey }),
  }),
});
const customAgent = defineCustomAgentProvider({
  kind: "custom",
  providerKey: "test-agent",
  revision: "1",
  supportsSessionContinuation: true,
  run: ({ prompt, session }) => Effect.sync(() => {
    if (process.env.KOJO_TEST_AGENT_CREDENTIAL !== "agent-secret-from-environment") {
      throw new Error("Agent credential was not resolved at invocation.");
    }
    return {
      commits: [{ sha: session === undefined ? "first-commit" : "continued-commit" }],
      sessionId: session === undefined ? "first-session" : "continued-session",
      text: (session === undefined ? "first:" : "continued:") + prompt,
      usage: { inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: 3, outputTokens: 4 },
    };
  }),
});
const unsupportedAgent = defineCustomAgentProvider({
  kind: "custom",
  providerKey: "unsupported-agent",
  revision: "1",
  run: () => Effect.succeed({ commits: [], text: "unreachable" }),
});
const interruptedAgent = defineCustomAgentProvider({
  kind: "custom",
  providerKey: "interrupted-agent",
  revision: "1",
  supportsSessionContinuation: true,
  run: () => Effect.never,
});
const unsupportedSession = {
  _tag: "agent-session",
  providerKind: "custom",
  providerKey: "unsupported-agent",
  providerRevision: "1",
  sandboxIdentity: "will-not-match",
  sessionId: "not-captured",
};
const echo = defineCommand({
  commandKey: "echo-environment",
  revision: "1",
  arguments: ["/bin/sh", "-lc", "printf '%s:%s' \\"$KOJO_SANDBOX_VALUE\\" \\"$PWD\\""],
  environment: { KOJO_SANDBOX_VALUE: "present" },
  workingDirectory: ".",
});
const nonZero = defineCommand({
  commandKey: "non-zero",
  revision: "1",
  arguments: ["/bin/sh", "-lc", "exit 7"],
  nonZeroExit: "return",
});
const timeout = defineCommand({
  commandKey: "timeout",
  revision: "1",
  arguments: ["/bin/sh", "-lc", "sleep 1"],
  timeout: "10 millis",
});
const recovery = defineCommand({
  commandKey: "recovery-wait",
  revision: "1",
  arguments: ["/bin/sh", "-lc", "sleep 10; printf recovered"],
});

export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "sandbox-command",
      revision: "1",
      inputSchema: input,
      successSchema: CommandResult,
      failureSchema: CommandFailure,
      handler: () => Effect.gen(function* () {
        const acquired = yield* Sandbox.acquire({ operationKey: "sandbox", sandbox });
        return yield* Command.run({ operationKey: "echo", sandbox: acquired, command: echo });
      }),
    }),
    defineWorkflow({
      workflowKey: "sandbox-non-zero",
      revision: "1",
      inputSchema: input,
      successSchema: CommandResult,
      failureSchema: CommandFailure,
      handler: () => Effect.gen(function* () {
        const acquired = yield* Sandbox.acquire({ operationKey: "sandbox", sandbox });
        return yield* Command.run({ operationKey: "non-zero", sandbox: acquired, command: nonZero });
      }),
    }),
    defineWorkflow({
      workflowKey: "sandbox-timeout",
      revision: "1",
      inputSchema: input,
      successSchema: CommandResult,
      failureSchema: CommandFailure,
      handler: () => Effect.gen(function* () {
        const acquired = yield* Sandbox.acquire({ operationKey: "sandbox", sandbox });
        return yield* Command.run({ operationKey: "timeout", sandbox: acquired, command: timeout });
      }),
    }),
    defineWorkflow({
      workflowKey: "sandbox-key-conflict",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: () => Effect.gen(function* () {
        yield* Sandbox.acquire({ operationKey: "sandbox", sandbox });
        yield* Sandbox.acquire({ operationKey: "sandbox", sandbox: changedSandbox });
        return "unreachable";
      }),
    }),
    defineWorkflow({
      workflowKey: "sandbox-docker",
      revision: "1",
      inputSchema: input,
      successSchema: CommandResult,
      failureSchema: CommandFailure,
      handler: () => Effect.gen(function* () {
        const acquired = yield* Sandbox.acquire({ operationKey: "sandbox", sandbox: dockerSandbox });
        return yield* Command.run({ operationKey: "echo", sandbox: acquired, command: echo });
      }),
    }),
    defineWorkflow({
      workflowKey: "sandbox-custom",
      revision: "1",
      inputSchema: input,
      successSchema: CommandResult,
      failureSchema: CommandFailure,
      handler: () => Effect.gen(function* () {
        const acquired = yield* Sandbox.acquire({ operationKey: "sandbox", sandbox: customSandbox });
        return yield* Command.run({ operationKey: "echo", sandbox: acquired, command: echo });
      }),
    }),
    defineWorkflow({
      workflowKey: "sandbox-recovery",
      revision: "1",
      inputSchema: input,
      successSchema: CommandResult,
      failureSchema: CommandFailure,
      handler: () => Effect.gen(function* () {
        const acquired = yield* Sandbox.acquire({ operationKey: "sandbox", sandbox });
        yield* Command.run({ operationKey: "before-restart", sandbox: acquired, command: echo });
        return yield* Command.run({ operationKey: "after-restart", sandbox: acquired, command: recovery });
      }),
    }),
    defineWorkflow({
      workflowKey: "agent-continuation",
      revision: "1",
      inputSchema: input,
      successSchema: AgentResult,
      failureSchema: AgentFailure,
      handler: ({ message }) => Effect.gen(function* () {
        const acquired = yield* Sandbox.acquire({ operationKey: "sandbox", sandbox: customSandbox });
        const first = yield* Agent.run({
          agent: customAgent,
          operationKey: "first-agent-attempt",
          prompt: "first " + message,
          sandbox: acquired,
        });
        if (first.session === undefined) return yield* Effect.die("Expected an Agent Session.");
        const continued = yield* Agent.run({
          agent: customAgent,
          operationKey: "continued-agent-attempt",
          prompt: "continued " + message,
          sandbox: acquired,
          session: first.session,
        });
        yield* Agent.run({
          agent: customAgent,
          operationKey: "first-agent-attempt",
          prompt: "first " + message,
          sandbox: acquired,
        });
        return continued;
      }),
    }),
    defineWorkflow({
      workflowKey: "agent-unsupported-continuation",
      revision: "1",
      inputSchema: input,
      successSchema: AgentResult,
      failureSchema: AgentFailure,
      handler: () => Effect.gen(function* () {
        const acquired = yield* Sandbox.acquire({ operationKey: "sandbox", sandbox: customSandbox });
        return yield* Agent.run({
          agent: unsupportedAgent,
          operationKey: "unsupported-agent-attempt",
          prompt: "unreachable",
          sandbox: acquired,
          session: unsupportedSession,
        });
      }),
    }),
    defineWorkflow({
      workflowKey: "agent-interrupted-without-session",
      revision: "1",
      inputSchema: input,
      successSchema: AgentResult,
      failureSchema: AgentFailure,
      handler: () => Effect.gen(function* () {
        const acquired = yield* Sandbox.acquire({ operationKey: "sandbox", sandbox: customSandbox });
        return yield* Agent.run({
          agent: interruptedAgent,
          operationKey: "interrupted-agent-attempt",
          prompt: "wait",
          sandbox: acquired,
          timeout: "5 millis",
        });
      }),
    }),
  ],
});
`;

const crashWindowConfiguration = (proofPath: string, releasePath: string) => `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { activity, defineConfig, defineWorkflow } from "@kojo/workflow";

const proofPath = ${JSON.stringify(proofPath)};
const releasePath = ${JSON.stringify(releasePath)};
const input = Schema.Struct({ message: Schema.String });
const record = (kind, attempt) => Effect.sync(() => {
  const alreadyRecorded = existsSync(proofPath) && readFileSync(proofPath, "utf8").includes(kind + ":");
  appendFileSync(proofPath, kind + ":" + attempt.idempotencyKey + "\\n");
  return alreadyRecorded;
});
const waitForCrashRelease = () => Effect.promise(async () => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (existsSync(releasePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting to complete the crash-window Activity");
});
const completeAndCrash = () => Effect.promise(() => new Promise((resolve) => {
  resolve("first");
  process.nextTick(() => process.kill(process.pid, "SIGKILL"));
}));
const external = (kind, holdFirstAttempt) => (attempt) => record(kind, attempt).pipe(
  Effect.flatMap((alreadyRecorded) =>
    holdFirstAttempt && !alreadyRecorded
      ? waitForCrashRelease().pipe(Effect.andThen(completeAndCrash()))
      : Effect.succeed("done")
  )
);

export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "activity-crash-window",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: () => activity({
        operationKey: "send-once-after-crash",
        successSchema: Schema.String,
        failureSchema: Schema.String,
        execute: external("crash", true)
      })
    })
  ]
});
`;

const agentRecoveryConfiguration = (proofPath: string) => `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import {
  Agent,
  AgentFailure,
  AgentResult,
  Sandbox,
  defineConfig,
  defineCustomAgentProvider,
  defineCustomSandboxProvider,
  defineSandbox,
  defineWorkflow,
} from "@kojo/workflow";

const proofPath = ${JSON.stringify(proofPath)};
const input = Schema.Struct({ message: Schema.String });
const sandbox = defineSandbox({
  sandboxKey: "agent-recovery-sandbox",
  revision: "1",
  provider: defineCustomSandboxProvider({
    kind: "custom",
    providerKey: "agent-recovery-sandbox",
    revision: "1",
    supportsAgentSessionContinuation: true,
    runCommand: () => Effect.succeed({ durationMs: 0, exitCode: 0, stderr: "", stdout: "" }),
  }),
});
const agent = defineCustomAgentProvider({
  kind: "custom",
  providerKey: "agent-recovery",
  revision: "1",
  supportsSessionContinuation: true,
  run: ({ idempotencyKey }) => Effect.sync(() => {
    const wasStarted = existsSync(proofPath) && readFileSync(proofPath, "utf8").includes("agent:");
    appendFileSync(proofPath, "agent:" + idempotencyKey + "\\n");
    return wasStarted;
  }).pipe(
    Effect.flatMap((wasStarted) =>
      wasStarted
        ? Effect.succeed({ commits: [], sessionId: "recovered-session", text: "recovered" })
        : Effect.never
    )
  ),
});

export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "agent-recovery",
      revision: "1",
      inputSchema: input,
      successSchema: AgentResult,
      failureSchema: AgentFailure,
      handler: () => Effect.gen(function* () {
        const acquired = yield* Sandbox.acquire({ operationKey: "sandbox", sandbox });
        return yield* Agent.run({
          agent,
          operationKey: "after-restart",
          prompt: "recover",
          sandbox: acquired,
        });
      }),
    }),
  ],
});
`;

const waitForProof = async (path: string, prefix: string, expectedCount = 1) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const lines = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .filter((line) => line.startsWith(`${prefix}:`));
      if (lines.length >= expectedCount) return lines;
    } catch {
      // The first external attempt has not reached its durable proof yet.
    }
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${prefix} Activity proof.`);
};

const waitForCondition = async (
  label: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const waitForFinalRun = async (
  socketPath: string,
  project: string,
  runId: string,
): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const shown = await runKojoCli(["run", "show", runId, "--json"], socketPath, project);
    if (shown.exitCode === 0) {
      const run = JSON.parse(shown.stdout).result.run as Record<string, unknown>;
      if (run.state === "completed" || run.state === "failed") return run;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for Workflow Run ${runId}.`);
};

const startKojoCli = (args: ReadonlyArray<string>, socketPath: string, cwd: string) => {
  const child = Bun.spawn(["bun", "run", cliMainPath, ...args], {
    cwd,
    env: { ...process.env, KOJO_HOST_SOCKET: socketPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = "";
  let stderr = "";
  const drain = async (stream: ReadableStream<Uint8Array>, append: (chunk: string) => void) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      append(decoder.decode(value, { stream: true }));
    }
    append(decoder.decode());
  };
  const result = Promise.all([
    child.exited,
    drain(child.stdout as ReadableStream<Uint8Array>, (chunk) => {
      stdout += chunk;
    }),
    drain(child.stderr as ReadableStream<Uint8Array>, (chunk) => {
      stderr += chunk;
    }),
  ]).then(([exitCode]) => ({ exitCode, stderr, stdout }));
  return {
    child,
    result,
    waitForStdout: async (fragment: string) => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (stdout.includes(fragment)) return;
        await Bun.sleep(10);
      }
      throw new Error(
        `Timed out waiting for CLI output containing ${fragment}. Current output: ${stdout}`,
      );
    },
  };
};

const finishKojoCliWithin = async (
  running: ReturnType<typeof startKojoCli>,
  timeoutMs: number,
  label: string,
) => {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    running.child.kill("SIGKILL");
  }, timeoutMs);
  const result = await running.result;
  clearTimeout(timeout);
  if (timedOut) {
    throw new Error(
      `${label} exceeded ${timeoutMs}ms. stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return result;
};

const completeWithin = async (operation: Promise<void>, timeoutMs: number, label: string) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const TRACE_PROXY_CLOSE_GRACE_MS = 500;

interface TraceProxySocketPair {
  readonly downstream: Socket;
  readonly terminateUpstream: () => void;
  readonly upstream: Socket;
}

interface TraceProxySocketState {
  readonly connections: number;
  readonly liveDownstreamSockets: number;
  readonly liveUpstreamSockets: number;
  readonly maximumOpenDownstreamSockets: number;
  readonly maximumOpenUpstreamSockets: number;
  readonly stopped: boolean;
}

const waitForTraceProxySocketClose = (socket: Socket) =>
  new Promise<void>((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      socket.off("close", finish);
      resolve();
    };
    socket.once("close", finish);
    timeout = setTimeout(() => {
      socket.destroy();
      timeout = setTimeout(finish, 100);
    }, TRACE_PROXY_CLOSE_GRACE_MS);
  });

const startTraceProxy = async (
  socketPath: string,
  upstreamSocketPath: string,
  options: {
    /** Drop after the Host starts the selected live stream, never by socket number. */
    readonly dropAfterSubscriptionChunk?: ReadonlySet<number>;
    /** Drop only an acknowledgement RPC response after the Host has processed it. */
    readonly dropAcknowledgementResponse?: ReadonlySet<number>;
    /** Hold an acknowledgement request so the Host observes genuine consumer lag. */
    readonly delayAcknowledgementRequest?: ReadonlyMap<number, number>;
    readonly dropImmediately?: ReadonlySet<number>;
  },
) => {
  let connections = 0;
  let droppedConnections = 0;
  let droppedAcknowledgementResponses = 0;
  let droppedSubscriptionChunks = 0;
  let acknowledgementRequests = 0;
  let resyncRequiredUpdates = 0;
  let subscriptionRequests = 0;
  let maximumOpenDownstreamSockets = 0;
  let maximumOpenUpstreamSockets = 0;
  let stopped = false;
  let acknowledgementResponseLossSocketState: TraceProxySocketState | undefined;
  let subscriptionLossSocketState: TraceProxySocketState | undefined;
  const socketPairs = new Set<TraceProxySocketPair>();
  const downstreamSockets = new Set<Socket>();
  const upstreamSockets = new Set<Socket>();
  const delayedWrites = new Set<ReturnType<typeof setTimeout>>();
  const socketState = (): TraceProxySocketState => ({
    connections,
    liveDownstreamSockets: downstreamSockets.size,
    liveUpstreamSockets: upstreamSockets.size,
    maximumOpenDownstreamSockets,
    maximumOpenUpstreamSockets,
    stopped,
  });
  const server = createServer((downstream) => {
    connections += 1;
    downstreamSockets.add(downstream);
    maximumOpenDownstreamSockets = Math.max(maximumOpenDownstreamSockets, downstreamSockets.size);
    downstream.once("close", () => downstreamSockets.delete(downstream));
    if (options.dropImmediately?.has(connections)) {
      droppedConnections += 1;
      downstream.destroy();
      return;
    }
    const upstream = createConnection(upstreamSocketPath);
    upstreamSockets.add(upstream);
    maximumOpenUpstreamSockets = Math.max(maximumOpenUpstreamSockets, upstreamSockets.size);
    let droppingResponse = false;
    const requests = new Map<
      string | number,
      { readonly operation: "acknowledgement" | "subscription"; readonly ordinal: number }
    >();
    const activeRequests = new Set<string | number>();
    let pendingProtocolDisconnect: Set<string | number> | undefined;
    let protocolDisconnectStarted = false;
    let protocolDisconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let protocolCloseTimer: ReturnType<typeof setTimeout> | undefined;
    const finishProtocolDisconnect = () => {
      if (!protocolDisconnectStarted || upstream.destroyed) return;
      protocolDisconnectStarted = false;
      if (protocolDisconnectTimer !== undefined) clearTimeout(protocolDisconnectTimer);
      protocolDisconnectTimer = undefined;
      pendingProtocolDisconnect = undefined;
      upstream.write('{"_tag":"Eof"}\n', () => {
        upstream.end();
        protocolCloseTimer = setTimeout(() => {
          if (!upstream.destroyed) upstream.destroy();
        }, TRACE_PROXY_CLOSE_GRACE_MS);
      });
    };
    const maybeFinishProtocolDisconnect = () => {
      if (
        pendingProtocolDisconnect !== undefined &&
        [...pendingProtocolDisconnect].every((requestId) => !activeRequests.has(requestId))
      ) {
        finishProtocolDisconnect();
      }
    };
    const interruptAndEndHostClient = () => {
      if (protocolDisconnectStarted) return;
      protocolDisconnectStarted = true;
      const requestIds = new Set(activeRequests);
      pendingProtocolDisconnect = requestIds;
      if (requestIds.size === 0) {
        finishProtocolDisconnect();
        return;
      }
      const interrupts = [...requestIds]
        .map((requestId) => JSON.stringify({ _tag: "Interrupt", requestId }))
        .join("\n");
      upstream.write(`${interrupts}\n`, maybeFinishProtocolDisconnect);
      // A malformed or uncooperative peer must not strand the fixture. The
      // normal path waits for every terminal Exit; this is only the bounded
      // test-transport fallback.
      protocolDisconnectTimer = setTimeout(finishProtocolDisconnect, 500);
    };
    const pair: TraceProxySocketPair = {
      downstream,
      terminateUpstream: interruptAndEndHostClient,
      upstream,
    };
    socketPairs.add(pair);
    upstream.once("close", () => {
      if (protocolDisconnectTimer !== undefined) clearTimeout(protocolDisconnectTimer);
      if (protocolCloseTimer !== undefined) clearTimeout(protocolCloseTimer);
      socketPairs.delete(pair);
      upstreamSockets.delete(upstream);
    });
    upstream.once("error", () => {
      if (!downstream.destroyed) downstream.destroy();
    });
    downstream.once("error", () => {
      if (!droppingResponse) interruptAndEndHostClient();
    });
    downstream.once("end", interruptAndEndHostClient);
    let downstreamBuffer = "";
    const requestFrames = (chunk: Buffer) => {
      downstreamBuffer += chunk.toString("utf8");
      const frames = downstreamBuffer.split("\n");
      downstreamBuffer = frames.pop() ?? "";
      let delayMs: number | undefined;
      for (const frame of frames) {
        try {
          const request = JSON.parse(frame) as {
            _tag?: string;
            id?: string | number;
            tag?: string;
          };
          if (request._tag !== "Request" || request.id === undefined) continue;
          activeRequests.add(request.id);
          if (request.tag === "SubscribeControl") {
            requests.set(request.id, {
              operation: "subscription",
              ordinal: ++subscriptionRequests,
            });
          }
          if (request.tag === "AcknowledgeControlSubscription") {
            const ordinal = ++acknowledgementRequests;
            requests.set(request.id, {
              operation: "acknowledgement",
              ordinal,
            });
            const configuredDelay = options.delayAcknowledgementRequest?.get(ordinal);
            if (configuredDelay !== undefined) delayMs = Math.max(delayMs ?? 0, configuredDelay);
          }
        } catch {
          // The proxy only recognizes complete NDJSON request frames; it never
          // changes or invents protocol data when an unrelated frame is split.
        }
      }
      return delayMs;
    };
    downstream.on("data", (chunk: Buffer) => {
      const delayMs = requestFrames(chunk);
      if (delayMs === undefined) {
        upstream.write(chunk);
        return;
      }
      const delayedWrite = setTimeout(() => {
        delayedWrites.delete(delayedWrite);
        if (!upstream.destroyed) upstream.write(chunk);
      }, delayMs);
      delayedWrites.add(delayedWrite);
    });
    let upstreamBuffer = "";
    upstream.on("data", (chunk) => {
      upstreamBuffer += chunk.toString("utf8");
      const frames = upstreamBuffer.split("\n");
      upstreamBuffer = frames.pop() ?? "";
      let dropBeforeForward = false;
      let dropAfterForward = false;
      for (const frame of frames) {
        try {
          const response = JSON.parse(frame) as {
            _tag?: string;
            requestId?: string | number;
          };
          if (response._tag === "Exit" && response.requestId !== undefined) {
            activeRequests.delete(response.requestId);
            maybeFinishProtocolDisconnect();
          }
          const request =
            response.requestId === undefined ? undefined : requests.get(response.requestId);
          if (request === undefined) continue;
          if (
            request.operation === "acknowledgement" &&
            response._tag === "Exit" &&
            options.dropAcknowledgementResponse?.has(request.ordinal)
          ) {
            droppedAcknowledgementResponses += 1;
            dropBeforeForward = true;
          }
          if (
            request.operation === "subscription" &&
            response._tag === "Chunk" &&
            options.dropAfterSubscriptionChunk?.has(request.ordinal)
          ) {
            droppedSubscriptionChunks += 1;
            dropAfterForward = true;
          }
          if (
            request.operation === "subscription" &&
            response._tag === "Chunk" &&
            frame.includes('"kind":"resync-required"')
          ) {
            resyncRequiredUpdates += 1;
          }
        } catch {
          // Forward unknown protocol frames unchanged.
        }
      }
      if (dropBeforeForward) {
        droppedConnections += 1;
        // The Host has completed the acknowledgement. Drop only the client
        // side so no response bytes are delivered. The Host-facing side uses
        // active-request Interrupt → terminal Exit → Eof → bounded close.
        acknowledgementResponseLossSocketState = socketState();
        droppingResponse = true;
        downstream.destroy();
        interruptAndEndHostClient();
        return;
      }
      downstream.write(chunk);
      if (dropAfterForward) {
        droppedConnections += 1;
        subscriptionLossSocketState = socketState();
        queueMicrotask(() => {
          downstream.destroy();
          interruptAndEndHostClient();
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    get connections() {
      return connections;
    },
    get droppedConnections() {
      return droppedConnections;
    },
    get droppedAcknowledgementResponses() {
      return droppedAcknowledgementResponses;
    },
    get droppedSubscriptionChunks() {
      return droppedSubscriptionChunks;
    },
    get subscriptionRequests() {
      return subscriptionRequests;
    },
    get resyncRequiredUpdates() {
      return resyncRequiredUpdates;
    },
    get acknowledgementResponseLossSocketState() {
      return acknowledgementResponseLossSocketState;
    },
    get subscriptionLossSocketState() {
      return subscriptionLossSocketState;
    },
    get socketState() {
      return socketState();
    },
    get upstreamConnections() {
      return upstreamSockets.size;
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const delayedWrite of delayedWrites) clearTimeout(delayedWrite);
      const pairs = [...socketPairs];
      for (const pair of pairs) pair.terminateUpstream();
      for (const socket of downstreamSockets) socket.destroy();
      const upstreamClose = pairs.map((pair) => waitForTraceProxySocketClose(pair.upstream));
      await Promise.all(upstreamClose);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};

it("starts, redelivers, lists, shows, and follows finalized Execution Trace history once", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-runs-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await commitInitialGitState(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  const initialized = await runKojoCli(["init", project], host.socketPath);
  expect(initialized.exitCode, `${initialized.stdout}${initialized.stderr}`).toBe(0);
  const invalidInput = await runKojoCli(
    ["run", "start", "echo", "--input", '{"message":42}', "--json"],
    host.socketPath,
    project,
  );
  expect(invalidInput.exitCode).toBe(4);
  expect(JSON.parse(invalidInput.stdout).error.code).toBe("workflow-input-invalid");
  const beforeFirstStart = await runKojoCli(["run", "list", "--json"], host.socketPath, project);
  expect(beforeFirstStart.exitCode).toBe(0);
  expect(JSON.parse(beforeFirstStart.stdout).result).toEqual([]);
  const first = await runKojoCli(
    [
      "run",
      "start",
      "echo",
      "--input",
      '{"message":"hello"}',
      "--request-key",
      "run-request-one",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(first.exitCode, `${first.stdout}${first.stderr}`).toBe(0);
  const firstResult = JSON.parse(first.stdout).result;
  expect(firstResult).toMatchObject({
    alreadyApplied: false,
    run: {
      workflowKey: "echo",
      workflowRevision: "1",
      state: "completed",
      startSnapshot: {
        environment: {
          definitionSnapshotId: expect.any(String),
          runtimeKind: "local-effect-workflow",
        },
        input: { message: "hello" },
        trigger: { kind: "manual", requestKey: "run-request-one" },
      },
      outcome: { kind: "completed", value: "echo:hello" },
    },
  });
  const database = new Database(join(project, ".kojo", "kojo.sqlite"), {
    readonly: true,
    strict: true,
  });
  try {
    const events = database
      .query(
        "SELECT sequence, kind, payload_json FROM kojo_execution_events WHERE run_id = ? ORDER BY sequence",
      )
      .all(firstResult.run.runId) as ReadonlyArray<{
      readonly sequence: number;
      readonly kind: string;
      readonly payload_json: string;
    }>;
    const accepted = events[0];
    expect(accepted).toMatchObject({ sequence: 1, kind: "run.accepted" });
    if (accepted === undefined) throw new Error("Workflow Run has no accepted event");
    expect(JSON.parse(accepted.payload_json)).toEqual(firstResult.run.startSnapshot);
    const terminal = database
      .query(
        "SELECT state, outcome_summary_json, finalized_at_ms FROM kojo_workflow_runs WHERE run_id = ?",
      )
      .get(firstResult.run.runId) as {
      readonly state: string;
      readonly outcome_summary_json: string;
      readonly finalized_at_ms: number;
    };
    expect(terminal).toMatchObject({ state: "completed", finalized_at_ms: expect.any(Number) });
    expect(JSON.parse(terminal.outcome_summary_json)).toEqual({
      kind: "completed",
      value: "echo:hello",
    });
    expect(events.at(-1)).toMatchObject({ kind: "run.completed" });
  } finally {
    database.close();
  }

  const redelivery = await runKojoCli(
    [
      "run",
      "start",
      "echo",
      "--input",
      '{"message":"hello"}',
      "--request-key",
      "run-request-one",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(redelivery.exitCode).toBe(0);
  expect(JSON.parse(redelivery.stdout).result).toMatchObject({
    alreadyApplied: true,
    run: { runId: firstResult.run.runId },
  });

  const conflict = await runKojoCli(
    [
      "run",
      "start",
      "echo",
      "--input",
      '{"message":"different"}',
      "--request-key",
      "run-request-one",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(conflict.exitCode).toBe(4);
  expect(JSON.parse(conflict.stdout).error.code).toBe("request-key-conflict");

  const second = await runKojoCli(
    ["run", "start", "echo", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(second.exitCode).toBe(0);
  const secondRunId = JSON.parse(second.stdout).result.run.runId as string;
  expect(secondRunId).not.toBe(firstResult.run.runId);

  const failedRunIds: Array<string> = [];
  for (const workflowKey of ["declared-failure", "defect", "invalid-result", "retry-exhausted"]) {
    const failed = await runKojoCli(
      ["run", "start", workflowKey, "--input", '{"message":"hello"}', "--json"],
      host.socketPath,
      project,
    );
    expect(failed.exitCode, `${workflowKey}: ${failed.stdout}${failed.stderr}`).toBe(0);
    const failedRun = JSON.parse(failed.stdout).result.run as {
      readonly runId: string;
      readonly state: string;
    };
    expect(failedRun.state, workflowKey).toBe("failed");
    failedRunIds.push(failedRun.runId);
  }

  const listed = await runKojoCli(
    ["run", "list", "--workflow", "echo", "--state", "completed", "--json"],
    host.socketPath,
    project,
  );
  expect(listed.exitCode).toBe(0);
  expect(JSON.parse(listed.stdout).result).toHaveLength(2);

  const shown = await runKojoCli(
    ["run", "show", firstResult.run.runId, "--json"],
    host.socketPath,
    project,
  );
  expect(shown.exitCode).toBe(0);
  expect(JSON.parse(shown.stdout).result).toMatchObject({ run: { runId: firstResult.run.runId } });

  const firstTracePage = await runKojoCli(
    ["trace", "show", firstResult.run.runId, "--limit", "1", "--json"],
    host.socketPath,
    project,
  );
  expect(firstTracePage.exitCode, `${firstTracePage.stdout}${firstTracePage.stderr}`).toBe(0);
  const firstTracePageResult = JSON.parse(firstTracePage.stdout).result.page as {
    readonly events: ReadonlyArray<{ readonly kind: string; readonly sequence: number }>;
    readonly firstSequence: number | null;
    readonly hasMore: boolean;
    readonly lastSequence: number | null;
    readonly nextCursor: string | null;
  };
  expect(firstTracePageResult.events).toEqual([
    expect.objectContaining({ kind: "run.accepted", sequence: 1 }),
  ]);
  expect(firstTracePageResult).toMatchObject({
    firstSequence: 1,
    hasMore: true,
    lastSequence: 1,
  });
  expect(firstTracePageResult.nextCursor).toEqual(expect.any(String));
  expect(
    JSON.parse(
      Buffer.from(firstTracePageResult.nextCursor as string, "base64url").toString("utf8"),
    ),
  ).toMatchObject({ resourceKind: "execution-trace" });

  const continuedTracePage = await runKojoCli(
    [
      "trace",
      "show",
      firstResult.run.runId,
      "--cursor",
      firstTracePageResult.nextCursor as string,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(
    continuedTracePage.exitCode,
    `${continuedTracePage.stdout}${continuedTracePage.stderr}`,
  ).toBe(0);
  expect(
    (
      JSON.parse(continuedTracePage.stdout).result.page.events as ReadonlyArray<{
        readonly sequence: number;
      }>
    )[0],
  ).toMatchObject({ sequence: 2 });

  const wrongRunCursor = await runKojoCli(
    ["trace", "show", secondRunId, "--cursor", firstTracePageResult.nextCursor as string, "--json"],
    host.socketPath,
    project,
  );
  expect(wrongRunCursor.exitCode).toBe(4);
  expect(JSON.parse(wrongRunCursor.stdout).error.code).toBe("execution-trace-cursor-run-mismatch");

  const followedTrace = await runKojoCli(
    ["trace", "follow", firstResult.run.runId, "--json"],
    host.socketPath,
    project,
  );
  expect(followedTrace.exitCode, `${followedTrace.stdout}${followedTrace.stderr}`).toBe(0);
  const followedEvents = followedTrace.stdout
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line).result.event as { readonly kind: string; readonly sequence: number },
    );
  expect(followedEvents.map((event) => event.kind)).toContain("run.accepted");
  expect(followedEvents.map((event) => event.kind)).toContain("run.completed");
  expect(new Set(followedEvents.map((event) => event.sequence)).size).toBe(followedEvents.length);

  const failedTrace = await runKojoCli(
    ["trace", "show", failedRunIds[0] as string, "--json"],
    host.socketPath,
    project,
  );
  expect(failedTrace.exitCode, `${failedTrace.stdout}${failedTrace.stderr}`).toBe(0);
  expect(JSON.parse(failedTrace.stdout).result.page).toMatchObject({
    final: true,
    runState: "failed",
    events: expect.arrayContaining([expect.objectContaining({ kind: "run.failed" })]),
  });
});

it("bounds trace follow transport retries and reports an unavailable Host", async () => {
  const directory = await makeTemporaryDirectory("kojo-trace-follow-retry-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);
  const proxy = await startTraceProxy(join(directory.path, "trace-proxy.sock"), host.socketPath, {
    dropImmediately: new Set([1, 2, 3, 4, 5]),
  });
  cleanups.push(proxy.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const followed = await runKojoCli(
    ["trace", "follow", Bun.randomUUIDv7(), "--json"],
    join(directory.path, "trace-proxy.sock"),
    project,
  );

  expect(followed.exitCode).toBe(3);
  expect(JSON.parse(followed.stdout).error.code).toBe("host-unavailable");
  expect(proxy.connections).toBeGreaterThanOrEqual(1);
  expect(proxy.droppedConnections).toBe(proxy.connections);
  expect(proxy.socketState).toMatchObject({
    liveUpstreamSockets: 0,
    maximumOpenDownstreamSockets: expect.any(Number),
    maximumOpenUpstreamSockets: 0,
  });
});

it("follows history first, resumes after one lost transport request, and never duplicates evidence", async () => {
  const directory = await makeTemporaryDirectory("kojo-trace-follow-resume-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);
  const proxyPath = join(directory.path, "trace-proxy.sock");
  const proxy = await startTraceProxy(proxyPath, host.socketPath, {
    dropAfterSubscriptionChunk: new Set([1]),
  });
  cleanups.push(proxy.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "slow", "--input", '{"message":"follow"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = JSON.parse(started.stdout).result.run.runId as string;
  const followed = startKojoCli(["trace", "follow", runId, "--json"], proxyPath, project);
  await followed.waitForStdout('"sequence":1');
  const result = await finishKojoCliWithin(followed, 6_000, "trace follow after a lost request");

  expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
  expect(proxy.droppedConnections).toBe(1);
  expect(proxy.droppedSubscriptionChunks).toBe(1);
  // The first lost live subscription has one Host-facing connection. The
  // assertion records the moment of loss; it does not assume any survivor
  // count once the CLI reconnects.
  expect(proxy.subscriptionLossSocketState).toMatchObject({
    liveDownstreamSockets: 1,
    liveUpstreamSockets: 1,
  });
  const events = result.stdout
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line).result.event as { readonly kind: string; readonly sequence: number },
    );
  expect(events.map((event) => event.kind)).toContain("run.accepted");
  expect(events.map((event) => event.kind)).toContain("run.completed");
  expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length);
  expect(events.map((event) => event.sequence)).toEqual(
    [...events].map((event) => event.sequence).sort((a, b) => a - b),
  );
  await proxy.stop();
  cleanups.splice(cleanups.lastIndexOf(proxy.stop), 1);
  expect(proxy.socketState).toMatchObject({
    liveDownstreamSockets: 0,
    liveUpstreamSockets: 0,
    stopped: true,
  });
  await completeWithin(host.stop(), 8_000, "Host stop after lost subscription transport");
  cleanups.splice(cleanups.lastIndexOf(host.stop), 1);
}, 10_000);

it("retries a lost acknowledgement response without falsely advancing trace progress", async () => {
  const directory = await makeTemporaryDirectory("kojo-trace-follow-ack-loss-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);
  const proxyPath = join(directory.path, "trace-proxy.sock");
  const proxy = await startTraceProxy(proxyPath, host.socketPath, {
    dropAcknowledgementResponse: new Set([1]),
  });
  cleanups.push(proxy.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "slow", "--input", '{"message":"acknowledge"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = JSON.parse(started.stdout).result.run.runId as string;
  const followed = startKojoCli(["trace", "follow", runId, "--json"], proxyPath, project);
  await followed.waitForStdout('"sequence":1');
  const result = await finishKojoCliWithin(
    followed,
    6_000,
    "trace follow after a lost acknowledgement response",
  );

  expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
  expect(proxy.droppedAcknowledgementResponses).toBe(1);
  // The acknowledgement response is lost while the subscription remains
  // connected, exercising a multi-connection fault without assuming those
  // sockets survive the protocol teardown.
  expect(proxy.acknowledgementResponseLossSocketState).toMatchObject({
    liveDownstreamSockets: expect.any(Number),
    liveUpstreamSockets: expect.any(Number),
    maximumOpenDownstreamSockets: expect.any(Number),
    maximumOpenUpstreamSockets: expect.any(Number),
  });
  expect(
    proxy.acknowledgementResponseLossSocketState?.liveDownstreamSockets,
  ).toBeGreaterThanOrEqual(2);
  expect(proxy.acknowledgementResponseLossSocketState?.liveUpstreamSockets).toBeGreaterThanOrEqual(
    2,
  );
  const events = result.stdout
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line).result.event as { readonly kind: string; readonly sequence: number },
    );
  expect(events.map((event) => event.kind)).toContain("run.completed");
  expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length);
  const diagnostics = (await readFile(host.diagnosticPath, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { readonly operation?: string; readonly outcome?: string });
  expect(
    diagnostics.filter(
      (event) =>
        event.operation === "AcknowledgeControlSubscription" && event.outcome === "success",
    ),
  ).toHaveLength(2);
  await proxy.stop();
  cleanups.splice(cleanups.lastIndexOf(proxy.stop), 1);
  expect(proxy.socketState).toMatchObject({
    liveDownstreamSockets: 0,
    liveUpstreamSockets: 0,
    stopped: true,
  });
  await completeWithin(host.stop(), 8_000, "Host stop after lost acknowledgement response");
  cleanups.splice(cleanups.lastIndexOf(host.stop), 1);
}, 15_000);

it("reloads and resumes a running Trace after the Host requires resync without duplicates", async () => {
  const directory = await makeTemporaryDirectory("kojo-trace-follow-resync-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);
  const proxyPath = join(directory.path, "trace-proxy.sock");
  const proxy = await startTraceProxy(proxyPath, host.socketPath, {
    // The first delivery remains unacknowledged while the running Workflow
    // produces more than 16 Events before a durable barrier. This exercises
    // the real Host delivery window rather than fabricating resync at the CLI
    // boundary, and the barrier keeps the Run non-final until reconnection.
    delayAcknowledgementRequest: new Map([[1, 250]]),
  });
  cleanups.push(proxy.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "trace-burst", "--input", '{"message":"resync"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = JSON.parse(started.stdout).result.run.runId as string;
  const followed = startKojoCli(["trace", "follow", runId, "--json"], proxyPath, project);
  await followed.waitForStdout('"sequence":1');
  await waitForCondition("Host resync-required delivery", () => proxy.resyncRequiredUpdates > 0);
  await waitForCondition("the post-resync subscription", () => proxy.subscriptionRequests >= 2);
  let suspended:
    | {
        readonly suspension?: { readonly completionToken?: string; readonly kind?: string };
      }
    | undefined;
  await waitForCondition("the durable trace-burst barrier", async () => {
    const shown = await runKojoCli(["run", "show", runId, "--json"], host.socketPath, project);
    if (shown.exitCode !== 0) return false;
    suspended = JSON.parse(shown.stdout).result.run;
    return suspended?.suspension?.kind === "deferred";
  });
  const completionToken = suspended?.suspension?.completionToken;
  expect(completionToken).toEqual(expect.any(String));
  const released = await runKojoCli(
    [
      "run",
      "deferred",
      "complete",
      runId,
      completionToken as string,
      "--value",
      '"released"',
      "--request-key",
      "release-trace-burst",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(released.exitCode, `${released.stdout}${released.stderr}`).toBe(0);
  const result = await finishKojoCliWithin(followed, 6_000, "trace follow after Host resync");

  expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
  const events = result.stdout
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line).result.event as { readonly kind: string; readonly sequence: number },
    );
  expect(events.length).toBeGreaterThan(16);
  // The terminal resync ends one stream successfully; the CLI then opens a
  // second subscription from its durable high-water sequence before release.
  expect(proxy.resyncRequiredUpdates).toBeGreaterThanOrEqual(1);
  expect(proxy.subscriptionRequests).toBeGreaterThanOrEqual(2);
  expect(events.map((event) => event.kind)).toContain("run.completed");
  expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length);
  expect(events.map((event) => event.sequence)).toEqual(
    [...events].map((event) => event.sequence).sort((left, right) => left - right),
  );
}, 15_000);

it("runs Commands in a durable logical Sandbox and records safe Artifact-backed trace evidence", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-sandbox-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await commitInitialGitState(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), sandboxConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "sandbox-command", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = JSON.parse(started.stdout).result.run.runId as string;
  const completed = await waitForFinalRun(host.socketPath, project, runId);

  expect(completed).toMatchObject({
    outcome: {
      kind: "completed",
      value: { exitCode: 0, stdout: expect.stringContaining("present:") },
    },
    state: "completed",
  });
  const trace = completed.sandboxTrace as ReadonlyArray<Record<string, unknown>>;
  expect(trace).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "sandbox.acquired", providerKind: "unsafe-host" }),
      expect.objectContaining({ kind: "command.completed", exitCode: 0 }),
    ]),
  );
  const commandTrace = trace.find((entry) => entry.kind === "command.completed");
  const artifactId = (commandTrace?.artifactIds as ReadonlyArray<string> | undefined)?.[0];
  expect(artifactId).toEqual(expect.any(String));
  expect(
    await readFile(join(project, ".kojo", "artifacts", runId, `${artifactId}.json`), "utf8"),
  ).toContain("present");

  const nonZero = await runKojoCli(
    ["run", "start", "sandbox-non-zero", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  const nonZeroRun = await waitForFinalRun(
    host.socketPath,
    project,
    JSON.parse(nonZero.stdout).result.run.runId as string,
  );
  expect(nonZeroRun).toMatchObject({
    outcome: { kind: "completed", value: { exitCode: 7 } },
    state: "completed",
  });

  const timedOut = await runKojoCli(
    ["run", "start", "sandbox-timeout", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  const timedOutRun = await waitForFinalRun(
    host.socketPath,
    project,
    JSON.parse(timedOut.stdout).result.run.runId as string,
  );
  expect(timedOutRun).toMatchObject({ state: "failed" });
  expect(timedOutRun.sandboxTrace).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "command.timed-out" })]),
  );
});

it.skipIf(!dockerAvailable)(
  "runs Commands through the local isolated Docker Provider",
  async () => {
    const directory = await makeTemporaryDirectory("kojo-workflow-sandbox-docker-");
    cleanups.push(directory.cleanup);
    const imageBuild = await makeTemporaryDirectory("kojo-workflow-sandbox-image-");
    cleanups.push(imageBuild.cleanup);
    await buildDockerTestImage(imageBuild.path);
    cleanups.push(removeDockerTestImage);
    const project = join(directory.path, "project");
    await initializeGit(project);
    await commitInitialGitState(project);
    await installWorkflowDependencies(project);
    await writeFile(join(project, "kojo.config.ts"), sandboxConfiguration);
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);

    expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
    const started = await runKojoCli(
      ["run", "start", "sandbox-docker", "--input", '{"message":"hello"}', "--json"],
      host.socketPath,
      project,
    );
    expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
    const completed = await waitForFinalRun(
      host.socketPath,
      project,
      JSON.parse(started.stdout).result.run.runId as string,
    );
    expect(completed).toMatchObject({
      outcome: {
        kind: "completed",
        value: { exitCode: 0, stdout: expect.stringContaining("present:") },
      },
      state: "completed",
    });
    expect(completed.sandboxTrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "sandbox.acquired", providerKind: "docker" }),
        expect.objectContaining({ kind: "command.completed", providerKind: "docker" }),
      ]),
    );
  },
  30_000,
);

it("runs a custom Provider through the same logical Sandbox contract", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-sandbox-custom-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), sandboxConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "sandbox-custom", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const completed = await waitForFinalRun(
    host.socketPath,
    project,
    JSON.parse(started.stdout).result.run.runId as string,
  );
  expect(completed).toMatchObject({
    outcome: { kind: "completed", value: { stdout: "custom:echo-environment" } },
    state: "completed",
  });
  expect(completed.sandboxTrace).toEqual(
    expect.arrayContaining([expect.objectContaining({ providerKind: "custom" })]),
  );
});

it("runs durable Agent Activities with explicit Session continuation and protected credentials", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-agent-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), sandboxConfiguration);
  const previousCredential = process.env.KOJO_TEST_AGENT_CREDENTIAL;
  process.env.KOJO_TEST_AGENT_CREDENTIAL = "agent-secret-from-environment";
  const host = await startKojoHostProcess();
  if (previousCredential === undefined) delete process.env.KOJO_TEST_AGENT_CREDENTIAL;
  else process.env.KOJO_TEST_AGENT_CREDENTIAL = previousCredential;
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "agent-continuation", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = JSON.parse(started.stdout).result.run.runId as string;
  const completed = await waitForFinalRun(host.socketPath, project, runId);
  const trace = completed.agentTrace as ReadonlyArray<Record<string, unknown>>;
  expect(completed).toMatchObject({
    state: "completed",
    outcome: { kind: "completed", value: { session: { _tag: "sensitive-value-masked" } } },
  });
  expect(trace).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "agent.started", providerKind: "custom" }),
      expect.objectContaining({ kind: "agent.replayed" }),
      expect.objectContaining({ kind: "agent.session-continued" }),
      expect.objectContaining({ kind: "agent.completed" }),
    ]),
  );
  expect(JSON.stringify(completed)).not.toContain("agent-secret-from-environment");
  expect(await readFile(join(project, ".kojo", "kojo.sqlite"), "utf8")).not.toContain(
    "agent-secret-from-environment",
  );
  expect(await readFile(host.diagnosticPath, "utf8")).not.toContain(
    "agent-secret-from-environment",
  );

  const unsupported = await runKojoCli(
    ["run", "start", "agent-unsupported-continuation", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  const unsupportedRun = await waitForFinalRun(
    host.socketPath,
    project,
    JSON.parse(unsupported.stdout).result.run.runId as string,
  );
  expect(unsupportedRun).toMatchObject({ state: "failed", agentTrace: [] });
  expect(
    (
      unsupportedRun.activityTrace as {
        readonly attempts: ReadonlyArray<{ readonly activityName: string }>;
      }
    ).attempts.filter((attempt) => attempt.activityName.startsWith("Run Agent")),
  ).toEqual([]);

  const interrupted = await runKojoCli(
    [
      "run",
      "start",
      "agent-interrupted-without-session",
      "--input",
      '{"message":"hello"}',
      "--json",
    ],
    host.socketPath,
    project,
  );
  const interruptedRun = await waitForFinalRun(
    host.socketPath,
    project,
    JSON.parse(interrupted.stdout).result.run.runId as string,
  );
  const interruptedTrace = interruptedRun.agentTrace as ReadonlyArray<Record<string, unknown>>;
  expect(interruptedRun).toMatchObject({ state: "failed" });
  expect(interruptedTrace).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "agent.started" }),
      expect.objectContaining({ kind: "agent.failed" }),
    ]),
  );
  expect(interruptedTrace).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "agent.session-continued" })]),
  );
});

it("rejects conflicting Sandbox acquisition under one Durable Operation Key", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-sandbox-conflict-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await commitInitialGitState(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), sandboxConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "sandbox-key-conflict", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = JSON.parse(started.stdout).result.run.runId as string;
  const failed = await waitForFinalRun(host.socketPath, project, runId);
  expect(failed).toMatchObject({ state: "failed" });
  expect(
    (failed.sandboxTrace as ReadonlyArray<Record<string, unknown>>).filter(
      (entry) => entry.kind === "sandbox.acquired",
    ),
  ).toHaveLength(1);
});

it("recreates a provider session after a Host crash while retaining Sandbox worktree and Artifact evidence", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-sandbox-recovery-");
  cleanups.push(directory.cleanup);
  const hostStore = await makeTemporaryDirectory("kojo-workflow-sandbox-host-");
  cleanups.push(hostStore.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await commitInitialGitState(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), sandboxConfiguration);
  const firstHost = await startKojoHostProcess({ storePath: hostStore.path });
  cleanups.push(firstHost.stop);

  expect((await runKojoCli(["init", project], firstHost.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "sandbox-recovery", "--input", '{"message":"hello"}', "--json"],
    firstHost.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = JSON.parse(started.stdout).result.run.runId as string;
  let interruptedCommandStarted = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const shown = await runKojoCli(["run", "show", runId, "--json"], firstHost.socketPath, project);
    if (shown.exitCode === 0) {
      const run = JSON.parse(shown.stdout).result.run as {
        readonly activityTrace: {
          readonly attempts: ReadonlyArray<{
            readonly durableOperationKey: string;
            readonly state: string;
          }>;
        };
      };
      if (
        run.activityTrace.attempts.some(
          (entry) => entry.durableOperationKey === "after-restart" && entry.state === "started",
        )
      ) {
        interruptedCommandStarted = true;
        break;
      }
    }
    await Bun.sleep(25);
  }
  expect(interruptedCommandStarted).toBe(true);
  await firstHost.crash();

  // Let the abandoned runner lease expire before the replacement Host activates the Project.
  await Bun.sleep(1_100);
  const secondHost = await startKojoHostProcess({ storePath: hostStore.path });
  cleanups.push(secondHost.stop);
  const initialized = await runKojoCli(["init", project], secondHost.socketPath);
  expect(initialized.exitCode, `${initialized.stdout}${initialized.stderr}`).toBe(0);
  const completed = await waitForFinalRun(secondHost.socketPath, project, runId);
  expect(completed).toMatchObject({ state: "completed" });
  const trace = completed.sandboxTrace as ReadonlyArray<Record<string, unknown>>;
  expect(trace).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "sandbox.acquired" }),
      expect.objectContaining({ kind: "sandbox.session-recreated" }),
      expect.objectContaining({ kind: "command.completed" }),
    ]),
  );
  const completedCommand = trace.find((entry) => entry.kind === "command.completed");
  expect(
    (completedCommand?.artifactIds as ReadonlyArray<string> | undefined)?.length ?? 0,
  ).toBeGreaterThan(0);
  const afterRestartAttempts = (
    completed.activityTrace as {
      readonly attempts: ReadonlyArray<{
        readonly durableOperationKey: string;
        readonly invocationNumber: number;
        readonly state: string;
      }>;
    }
  ).attempts.filter((attempt) => attempt.durableOperationKey === "after-restart");
  expect(afterRestartAttempts).toEqual([
    expect.objectContaining({ invocationNumber: 1, state: "started" }),
    expect.objectContaining({ invocationNumber: 2, state: "engine-confirmed" }),
  ]);
}, 30_000);

it("runs, inspects, and filters a durable Child Workflow Run", async () => {
  const directory = await makeTemporaryDirectory("kojo-child-workflow-runs-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), childConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);
  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "parent", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const parent = await waitForFinalRun(
    host.socketPath,
    project,
    JSON.parse(started.stdout).result.run.runId,
  );
  expect(parent).toMatchObject({ state: "completed", outcome: { value: "child:hello" } });
  const children = await runKojoCli(
    ["run", "list", "--parent-run", parent.runId as string, "--json"],
    host.socketPath,
    project,
  );
  expect(children.exitCode, `${children.stdout}${children.stderr}`).toBe(0);
  expect(JSON.parse(children.stdout).result).toMatchObject([
    { parentRunId: parent.runId, childInvocationKey: "child", workflowKey: "child" },
  ]);
});

it("lets a parent handle a failed Child Workflow Run", async () => {
  const directory = await makeTemporaryDirectory("kojo-handled-child-workflow-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), childConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);
  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "parent-handles-child-failure", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const parent = await waitForFinalRun(
    host.socketPath,
    project,
    JSON.parse(started.stdout).result.run.runId,
  );
  expect(parent).toMatchObject({ state: "completed", outcome: { value: "handled" } });
});

it("keeps a parent non-final while a Child Workflow Run is active", async () => {
  const directory = await makeTemporaryDirectory("kojo-active-child-workflow-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), childConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);
  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "parent-waits-for-child", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const parentRunId = JSON.parse(started.stdout).result.run.runId as string;
  const listed = await runKojoCli(
    ["run", "list", "--parent-run", parentRunId, "--json"],
    host.socketPath,
    project,
  );
  expect(listed.exitCode, `${listed.stdout}${listed.stderr}`).toBe(0);
  const parent = await runKojoCli(["run", "show", parentRunId, "--json"], host.socketPath, project);
  expect(parent.exitCode, `${parent.stdout}${parent.stderr}`).toBe(0);
  expect(JSON.parse(parent.stdout).result.run.state).not.toMatch(/completed|failed/);
  const final = await waitForFinalRun(host.socketPath, project, parentRunId);
  expect(final).toMatchObject({ state: "completed", outcome: { value: "slow:hello" } });
});

it("isolates Child Workflow Run identities and reuses the same invocation", async () => {
  const directory = await makeTemporaryDirectory("kojo-child-workflow-outcomes-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), childConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);
  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);

  const startAndWait = async (workflowKey: string, requestKey?: string) => {
    const started = await runKojoCli(
      [
        "run",
        "start",
        workflowKey,
        "--input",
        '{"message":"hello"}',
        ...(requestKey === undefined ? [] : ["--request-key", requestKey]),
        "--json",
      ],
      host.socketPath,
      project,
    );
    expect(started.exitCode, `${workflowKey}: ${started.stdout}${started.stderr}`).toBe(0);
    return waitForFinalRun(host.socketPath, project, JSON.parse(started.stdout).result.run.runId);
  };
  const childrenOf = async (parentRunId: string) => {
    const listed = await runKojoCli(
      ["run", "list", "--parent-run", parentRunId, "--json"],
      host.socketPath,
      project,
    );
    expect(listed.exitCode, listed.stderr).toBe(0);
    return JSON.parse(listed.stdout).result as Array<Record<string, unknown>>;
  };

  const firstParent = await startAndWait("parent", "first-parent");
  const firstChild = (await childrenOf(firstParent.runId as string))[0];
  expect(firstChild).toMatchObject({
    state: "completed",
    workflowKey: "child",
    workflowRevision: "1",
    parentRunId: firstParent.runId,
    childInvocationKey: "child",
  });
  const firstChildId = firstChild?.runId;
  if (typeof firstChildId !== "string")
    throw new Error("The first parent did not start a Child Workflow Run");
  const childDetails = await runKojoCli(
    ["run", "show", firstChildId as string, "--json"],
    host.socketPath,
    project,
  );
  expect(childDetails.exitCode, childDetails.stderr).toBe(0);
  expect(JSON.parse(childDetails.stdout).result.run).toMatchObject({
    startSnapshot: {
      workflow: { workflowKey: "child", workflowRevision: "1" },
      trigger: { kind: "child", parentRunId: firstParent.runId, invocationKey: "child" },
      input: { message: "hello" },
    },
  });
  const childText = await runKojoCli(
    ["run", "show", firstChildId as string],
    host.socketPath,
    project,
  );
  expect(childText.exitCode, childText.stderr).toBe(0);
  expect(childText.stdout).toContain(`Run Identity: ${firstChildId}`);
  expect(childText.stdout).toContain(`Parent Run Identity: ${firstParent.runId}`);
  expect(childText.stdout).toContain("Child Invocation Key: child");

  const secondParent = await startAndWait("parent", "second-parent");
  const secondChild = (await childrenOf(secondParent.runId as string))[0];
  expect(secondChild?.runId).toEqual(expect.any(String));
  expect(secondChild?.runId).not.toBe(firstChildId);

  const replayed = await startAndWait("parent-reuses-child");
  expect(replayed).toMatchObject({
    state: "completed",
    outcome: { value: "child:hello,child:hello" },
  });
  expect(await childrenOf(replayed.runId as string)).toMatchObject([
    { childInvocationKey: "reused", workflowKey: "child", parentRunId: replayed.runId },
  ]);

  const database = new Database(join(project, ".kojo", "kojo.sqlite"), {
    readonly: true,
    strict: true,
  });
  try {
    const childEvents = database
      .query("SELECT kind FROM kojo_execution_events WHERE run_id = ? ORDER BY sequence")
      .all(firstChildId) as ReadonlyArray<{ readonly kind: string }>;
    const parentEvents = database
      .query(
        "SELECT kind, child_run_id FROM kojo_execution_events WHERE run_id = ? ORDER BY sequence",
      )
      .all(firstParent.runId as string) as ReadonlyArray<{
      readonly kind: string;
      readonly child_run_id: string | null;
    }>;
    expect(childEvents.map((event) => event.kind)).toContain("run.accepted");
    expect(childEvents.map((event) => event.kind)).toContain("run.completed");
    expect(parentEvents).toContainEqual({ kind: "child.requested", child_run_id: firstChildId });
  } finally {
    database.close();
  }
});

it("fails a parent when a Child Workflow invocation key is reused with different input", async () => {
  const directory = await makeTemporaryDirectory("kojo-conflicted-child-workflow-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), childConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);
  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "parent-conflicts-child", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const parent = await waitForFinalRun(
    host.socketPath,
    project,
    JSON.parse(started.stdout).result.run.runId,
  );
  expect(parent.state).toBe("failed");
});

it("fails a parent that leaves a Child Workflow failure unhandled", async () => {
  const directory = await makeTemporaryDirectory("kojo-unhandled-child-workflow-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), childConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);
  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "parent-propagates-child-failure", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const parent = await waitForFinalRun(
    host.socketPath,
    project,
    JSON.parse(started.stdout).result.run.runId,
  );
  expect(parent.state).toBe("failed");
});

it("rejects undeclared Child Workflow targets and empty invocation keys", async () => {
  const directory = await makeTemporaryDirectory("kojo-child-workflow-failures-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), childConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);
  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);

  const startAndWait = async (workflowKey: string) => {
    const started = await runKojoCli(
      ["run", "start", workflowKey, "--input", '{"message":"hello"}', "--json"],
      host.socketPath,
      project,
    );
    expect(started.exitCode, `${workflowKey}: ${started.stdout}${started.stderr}`).toBe(0);
    return waitForFinalRun(host.socketPath, project, JSON.parse(started.stdout).result.run.runId);
  };
  const childrenOf = async (parentRunId: string) => {
    const listed = await runKojoCli(
      ["run", "list", "--parent-run", parentRunId, "--json"],
      host.socketPath,
      project,
    );
    expect(listed.exitCode, listed.stderr).toBe(0);
    return JSON.parse(listed.stdout).result as Array<Record<string, unknown>>;
  };

  const undeclared = await startAndWait("parent-without-child-declaration");
  const emptyKey = await startAndWait("parent-without-invocation-key");
  expect(undeclared.state).toBe("failed");
  expect(emptyKey.state).toBe("failed");
  expect(await childrenOf(undeclared.runId as string)).toEqual([]);
  expect(await childrenOf(emptyKey.runId as string)).toEqual([]);
});
it("retries interrupted Agent work with the durable Activity identity and no uncaptured Session", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-agent-recovery-");
  cleanups.push(directory.cleanup);
  const hostStore = await makeTemporaryDirectory("kojo-workflow-agent-host-");
  cleanups.push(hostStore.cleanup);
  const project = join(directory.path, "project");
  const proofPath = join(directory.path, "agent-proof.txt");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), agentRecoveryConfiguration(proofPath));
  const firstHost = await startKojoHostProcess({ storePath: hostStore.path });
  cleanups.push(firstHost.stop);

  expect((await runKojoCli(["init", project], firstHost.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "agent-recovery", "--input", '{"message":"hello"}', "--json"],
    firstHost.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = JSON.parse(started.stdout).result.run.runId as string;
  await waitForProof(proofPath, "agent");
  await firstHost.crash();

  // The runner lease must expire before another Host may activate this Project.
  await Bun.sleep(1_100);
  const secondHost = await startKojoHostProcess({ storePath: hostStore.path });
  cleanups.push(secondHost.stop);
  const initialized = await runKojoCli(["init", project], secondHost.socketPath);
  expect(initialized.exitCode, `${initialized.stdout}${initialized.stderr}`).toBe(0);
  const completed = await waitForFinalRun(secondHost.socketPath, project, runId);
  const proof = await waitForProof(proofPath, "agent", 2);
  const trace = completed.agentTrace as ReadonlyArray<Record<string, unknown>>;
  const attempts = (
    completed.activityTrace as {
      readonly attempts: ReadonlyArray<{
        readonly activityIdempotencyKey: string;
        readonly activityName: string;
      }>;
    }
  ).attempts.filter((attempt) => attempt.activityName.startsWith("Run Agent"));

  expect(completed).toMatchObject({
    state: "completed",
    outcome: { kind: "completed", value: { session: { _tag: "sensitive-value-masked" } } },
  });
  expect(new Set(proof.map((line) => line.slice("agent:".length)))).toHaveLength(1);
  expect(attempts.length).toBeGreaterThanOrEqual(2);
  expect(new Set(attempts.map((attempt) => attempt.activityIdempotencyKey))).toHaveLength(1);
  expect(trace.filter((entry) => entry.kind === "agent.started").length).toBeGreaterThanOrEqual(2);
  expect(trace).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "agent.completed" })]),
  );
  expect(trace).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "agent.session-continued" })]),
  );
  const cluster = new Database(join(project, ".kojo", "kojo.sqlite"), { readonly: true });
  try {
    expect(
      cluster
        .query(
          `SELECT entity_id FROM cluster_messages
           WHERE entity_type = ? AND processed = FALSE`,
        )
        .all("Workflow/Kojo/agent-recovery/1"),
    ).toEqual([]);
  } finally {
    cluster.close();
  }
}, 30_000);

it("reconciles a non-final Workflow Run after the Host restarts", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-runs-restart-");
  cleanups.push(directory.cleanup);
  const hostStore = await makeTemporaryDirectory("kojo-workflow-runs-host-");
  cleanups.push(hostStore.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const firstHost = await startKojoHostProcess({ storePath: hostStore.path });
  cleanups.push(firstHost.stop);
  const initialized = await runKojoCli(["init", project], firstHost.socketPath);
  expect(initialized.exitCode, `${initialized.stdout}${initialized.stderr}`).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "slow", "--input", '{"message":"after-restart"}', "--json"],
    firstHost.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  expect(JSON.parse(started.stdout).result.run.state).toBe("running");
  await firstHost.stop();

  const secondHost = await startKojoHostProcess({ storePath: hostStore.path });
  cleanups.push(secondHost.stop);
  const listed = await runKojoCli(["run", "list", "--json"], secondHost.socketPath, project);
  expect(listed.exitCode, `${listed.stdout}${listed.stderr}`).toBe(0);
  const recovered = JSON.parse(listed.stdout).result.find(
    (run: { readonly workflowKey: string }) => run.workflowKey === "slow",
  );
  expect(recovered?.state).toMatch(/^(running|completed)$/);
  const shown = await runKojoCli(
    ["run", "show", JSON.parse(started.stdout).result.run.runId, "--json"],
    secondHost.socketPath,
    project,
  );
  expect(shown.exitCode, `${shown.stdout}${shown.stderr}`).toBe(0);
  expect(JSON.parse(shown.stdout).result.run).toMatchObject({
    state: "completed",
    outcome: { kind: "completed", value: "echo:after-restart" },
  });
});

it("records typed Activity attempts, stable retry identity, and safe trace evidence", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-activities-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "activity-retry", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const run = JSON.parse(started.stdout).result.run;
  expect(run).toMatchObject({
    state: "completed",
    activitySummary: {
      invocationAttempts: 2,
      incompleteAttempts: 1,
      retries: 1,
      durableCompletions: 1,
      replayReuses: 0,
    },
    activityTrace: {
      attempts: [
        {
          durableOperationKey: "send-message",
          activityName: "Send message",
          effectRetryNumber: 1,
          invocationNumber: 1,
          state: "result-observed",
          outcomeCode: "failure",
        },
        {
          durableOperationKey: "send-message",
          effectRetryNumber: 2,
          invocationNumber: 2,
          state: "engine-confirmed",
          outcomeCode: "success",
        },
      ],
    },
  });
  expect(run.activityTrace.attempts[0].activityIdempotencyKey).toBe(
    run.activityTrace.attempts[1].activityIdempotencyKey,
  );
  expect(run.outcome.value.idempotencyKey).toBe(
    run.activityTrace.attempts[1].activityIdempotencyKey,
  );

  const database = new Database(join(project, ".kojo", "kojo.sqlite"), {
    readonly: true,
    strict: true,
  });
  try {
    const events = database
      .query(
        "SELECT kind, payload_json FROM kojo_execution_events WHERE run_id = ? ORDER BY sequence",
      )
      .all(run.runId) as ReadonlyArray<{ readonly kind: string; readonly payload_json: string }>;
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "activity.attempt-started",
        "activity.result-observed",
        "activity.result-confirmed",
      ]),
    );
    for (const event of events.filter((event) => event.kind.startsWith("activity."))) {
      expect(JSON.parse(event.payload_json)).not.toHaveProperty("value");
    }
  } finally {
    database.close();
  }
});

it("uses a distinct external key for each per-retry Activity invocation", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-activity-per-retry-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "activity-per-retry", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const run = JSON.parse(started.stdout).result.run;
  const attempts = run.activityTrace.attempts as ReadonlyArray<Record<string, unknown>>;
  expect(run).toMatchObject({
    state: "completed",
    activitySummary: {
      invocationAttempts: 2,
      incompleteAttempts: 1,
      retries: 1,
      durableCompletions: 1,
    },
  });
  expect(attempts).toHaveLength(2);
  expect(attempts.map((attempt) => attempt.effectRetryNumber)).toEqual([1, 2]);
  expect(attempts[0]?.activityIdempotencyKey).not.toBe(attempts[1]?.activityIdempotencyKey);
  expect(run.outcome.value.idempotencyKey).toBe(attempts[1]?.activityIdempotencyKey);
});

it("fails a Run before external work when a Durable Operation Key is reused differently", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-activity-key-conflict-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "activity-key-conflict", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const run = JSON.parse(started.stdout).result.run;
  expect(run).toMatchObject({
    state: "failed",
    outcome: { kind: "failed" },
    activitySummary: {
      invocationAttempts: 1,
      durableCompletions: 1,
    },
    activityTrace: {
      attempts: [
        {
          durableOperationKey: "conflicting-operation",
          activityName: "First operation",
          state: "engine-confirmed",
        },
      ],
    },
  });
  expect(run.activityTrace.attempts).toHaveLength(1);
});

it("recovers a completed external Activity whose success was not observed before a Host crash", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-activity-crash-");
  cleanups.push(directory.cleanup);
  const hostStore = await makeTemporaryDirectory("kojo-workflow-activity-host-");
  cleanups.push(hostStore.cleanup);
  const project = join(directory.path, "project");
  const proofPath = join(directory.path, "external-activity-proof.txt");
  const releasePath = join(directory.path, "complete-activity.txt");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(
    join(project, "kojo.config.ts"),
    crashWindowConfiguration(proofPath, releasePath),
  );

  const firstHost = await startKojoHostProcess({ storePath: hostStore.path });
  cleanups.push(firstHost.stop);
  expect((await runKojoCli(["init", project], firstHost.socketPath)).exitCode).toBe(0);
  const crashStarted = await runKojoCli(
    ["run", "start", "activity-crash-window", "--input", '{"message":"hello"}', "--json"],
    firstHost.socketPath,
    project,
  );
  expect(crashStarted.exitCode, `${crashStarted.stdout}${crashStarted.stderr}`).toBe(0);
  const crashRunId = JSON.parse(crashStarted.stdout).result.run.runId;
  await waitForProof(proofPath, "crash");
  await writeFile(releasePath, "complete");
  await firstHost.crash();
  const interruptedDatabase = new Database(join(project, ".kojo", "kojo.sqlite"), {
    readonly: true,
    strict: true,
  });
  try {
    expect(
      interruptedDatabase
        .query(
          `SELECT state, result_observed_at_ms
           FROM kojo_workflow_activity_attempts
           WHERE run_id = ?
           ORDER BY invocation_number`,
        )
        .all(crashRunId),
    ).toEqual([{ state: "started", result_observed_at_ms: null }]);
  } finally {
    interruptedDatabase.close();
  }
  // Let the abandoned local runner lease expire before the replacement Host activates the Project.
  await Bun.sleep(1_100);

  const secondHost = await startKojoHostProcess({ storePath: hostStore.path });
  cleanups.push(secondHost.stop);
  const secondInitialization = await runKojoCli(["init", project], secondHost.socketPath);
  expect(
    secondInitialization.exitCode,
    `${secondInitialization.stdout}${secondInitialization.stderr}`,
  ).toBe(0);
  const crashedRun = await waitForFinalRun(secondHost.socketPath, project, crashRunId);
  const crashAttempts = (
    crashedRun.activityTrace as {
      readonly attempts: ReadonlyArray<Record<string, unknown>>;
    }
  ).attempts;
  expect(crashAttempts).toHaveLength(2);
  expect(crashAttempts.map((attempt) => attempt.state)).toEqual(["started", "engine-confirmed"]);
  expect(crashAttempts[0]?.activityIdempotencyKey).toBe(crashAttempts[1]?.activityIdempotencyKey);
  expect(crashedRun.activitySummary as Record<string, unknown>).toMatchObject({
    invocationAttempts: 2,
    incompleteAttempts: 1,
    durableCompletions: 1,
    replayReuses: 0,
  });
  const cluster = new Database(join(project, ".kojo", "kojo.sqlite"), { readonly: true });
  try {
    expect(
      cluster
        .query(
          `SELECT entity_id FROM cluster_messages
           WHERE entity_type = ? AND processed = FALSE`,
        )
        .all("Workflow/Kojo/activity-crash-window/1"),
    ).toEqual([]);
  } finally {
    cluster.close();
  }
  const crashProofs = await waitForProof(proofPath, "crash", 2);
  expect(crashProofs).toHaveLength(2);
  expect([...new Set(crashProofs.map((line) => line.split(":").at(-1)))]).toHaveLength(1);
}, 45_000);

it("masks marked payloads by default, fails closed for an invalid map, and reveals once with warnings", async () => {
  const directory = await makeTemporaryDirectory("kojo-sensitive-workflow-runs-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), sensitiveConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    [
      "run",
      "start",
      "sensitive-echo",
      "--input",
      '{"credentials":{"token":"top-secret-input"},"message":"hello"}',
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  expect(started.stdout).not.toContain("top-secret-input");
  const run = JSON.parse(started.stdout).result.run;
  expect(run.startSnapshot.input).toEqual({
    credentials: { _tag: "sensitive-value-masked" },
    message: "hello",
  });
  expect(run.outcome).toEqual({
    kind: "completed",
    value: { result: "echo:hello", token: { _tag: "sensitive-value-masked" } },
  });

  const database = new Database(join(project, ".kojo", "kojo.sqlite"));
  const maps = database
    .query(
      `SELECT payload_sensitivity_map_json
       FROM kojo_execution_events WHERE run_id = ? ORDER BY sequence`,
    )
    .all(run.runId) as ReadonlyArray<{ readonly payload_sensitivity_map_json: string }>;
  expect(JSON.parse(maps[0]?.payload_sensitivity_map_json ?? "null")).toEqual([
    "input.credentials",
  ]);
  database.exec("DROP TRIGGER kojo_execution_events_immutable");
  database
    .query(
      "UPDATE kojo_execution_events SET payload_sensitivity_map_version = 2 WHERE run_id = ? AND sequence = 1",
    )
    .run(run.runId);
  database.close();

  const failedClosed = await runKojoCli(
    ["run", "show", run.runId, "--json"],
    host.socketPath,
    project,
  );
  expect(failedClosed.exitCode, `${failedClosed.stdout}${failedClosed.stderr}`).toBe(0);
  expect(JSON.parse(failedClosed.stdout).result.run.startSnapshot).toEqual({
    _tag: "sensitive-value-masked",
  });

  const revealed = await runKojoCli(
    ["run", "show", run.runId, "--reveal", "--json"],
    host.socketPath,
    project,
  );
  expect(revealed.exitCode, `${revealed.stdout}${revealed.stderr}`).toBe(0);
  const revealedResult = JSON.parse(revealed.stdout);
  expect(revealedResult.result.run.startSnapshot.input.credentials.token).toBe("top-secret-input");
  expect(revealedResult.warnings).toEqual([
    expect.objectContaining({ code: "sensitive-content-not-scanned" }),
  ]);

  const humanReveal = await runKojoCli(
    ["run", "show", run.runId, "--reveal"],
    host.socketPath,
    project,
  );
  expect(humanReveal.exitCode, `${humanReveal.stdout}${humanReveal.stderr}`).toBe(0);
  expect(humanReveal.stderr).toContain("Revealed content may contain arbitrary secrets");

  const policyDatabase = new Database(join(project, ".kojo", "kojo.sqlite"), { readonly: true });
  try {
    expect(policyDatabase.query("SELECT * FROM kojo_retention_policy").all()).toEqual([]);
  } finally {
    policyDatabase.close();
  }

  const diagnostics = (await readFile(host.diagnosticPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        eventKind: "host-request.completed",
        operation: "RevealWorkflowRun",
        outcome: "success",
      }),
      expect.objectContaining({
        eventKind: "project-runtime.activation.completed",
        operation: "ProjectRuntimeActivate",
      }),
      expect.objectContaining({
        eventKind: "workflow-run.reconciliation.completed",
        operation: "ReconcileWorkflowRun",
      }),
    ]),
  );
  expect(JSON.stringify(diagnostics)).not.toContain("top-secret-input");
});

it("keeps manual resume and Workflow Deferred completion distinct and validates their values", async () => {
  const directory = await makeTemporaryDirectory("kojo-durable-waits-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), durableWaitConfiguration);
  const hostStore = join(directory.path, "host");
  const host = await startKojoHostProcess({ storePath: hostStore });

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const manualStart = await runKojoCli(
    ["run", "start", "manual-wait", "--input", '{"message":"manual"}', "--json"],
    host.socketPath,
    project,
  );
  expect(manualStart.exitCode, `${manualStart.stdout}${manualStart.stderr}`).toBe(0);
  const manual = JSON.parse(manualStart.stdout).result.run;
  expect(manual).toMatchObject({
    state: "suspended",
    suspension: { kind: "manual", operationKey: "approval" },
  });

  await host.stop();
  const restartedHost = await startKojoHostProcess({ storePath: hostStore });
  cleanups.push(restartedHost.stop);
  const afterRestart = await runKojoCli(
    ["run", "show", manual.runId, "--json"],
    restartedHost.socketPath,
    project,
  );
  expect(afterRestart.exitCode, `${afterRestart.stdout}${afterRestart.stderr}`).toBe(0);
  expect(JSON.parse(afterRestart.stdout).result.run).toMatchObject({
    state: "suspended",
    suspension: { kind: "manual", operationKey: "approval" },
  });

  const rejectedResume = await runKojoCli(
    ["run", "resume", manual.runId, "--value", "42", "--json"],
    restartedHost.socketPath,
    project,
  );
  expect(rejectedResume.exitCode, `${rejectedResume.stdout}${rejectedResume.stderr}`).toBe(4);
  expect(JSON.parse(rejectedResume.stdout).error.code).toBe("workflow-deferred-value-invalid");

  await writeFile(join(project, "approval.json"), '"approved"');

  const resumed = await runKojoCli(
    [
      "run",
      "resume",
      manual.runId,
      "--value-file",
      "approval.json",
      "--request-key",
      "resume-manual-wait",
      "--json",
    ],
    restartedHost.socketPath,
    project,
  );
  expect(resumed.exitCode, `${resumed.stdout}${resumed.stderr}`).toBe(0);
  expect(JSON.parse(resumed.stdout).result.run).toMatchObject({ state: "running" });
  const resumeRedelivery = await runKojoCli(
    [
      "run",
      "resume",
      manual.runId,
      "--value",
      '"approved"',
      "--request-key",
      "resume-manual-wait",
      "--json",
    ],
    restartedHost.socketPath,
    project,
  );
  expect(resumeRedelivery.exitCode, `${resumeRedelivery.stdout}${resumeRedelivery.stderr}`).toBe(0);
  expect(JSON.parse(resumeRedelivery.stdout).result.alreadyApplied).toBe(true);
  const finalResume = await runKojoCli(
    [
      "run",
      "resume",
      manual.runId,
      "--value",
      '"approved"',
      "--request-key",
      "resume-final-run",
      "--json",
    ],
    restartedHost.socketPath,
    project,
  );
  expect(finalResume.exitCode).toBe(4);
  expect(JSON.parse(finalResume.stdout).error.code).toBe("run-not-suspended");
});

it("completes a Workflow Deferred only with its token and a schema-valid value", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-deferred-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), durableWaitConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const deferredStart = await runKojoCli(
    ["run", "start", "deferred-wait", "--input", '{"message":"deferred"}', "--json"],
    host.socketPath,
    project,
  );
  expect(deferredStart.exitCode, `${deferredStart.stdout}${deferredStart.stderr}`).toBe(0);
  const deferred = JSON.parse(deferredStart.stdout).result.run;
  expect(deferred).toMatchObject({
    state: "suspended",
    suspension: {
      kind: "deferred",
      operationKey: "approval",
      completionToken: expect.any(String),
    },
  });

  const forbiddenResume = await runKojoCli(
    ["run", "resume", deferred.runId, "--value", '"approved"', "--json"],
    host.socketPath,
    project,
  );
  expect(forbiddenResume.exitCode).toBe(4);
  expect(JSON.parse(forbiddenResume.stdout).error.code).toBe("run-resume-not-allowed");

  const rejectedDeferred = await runKojoCli(
    [
      "run",
      "deferred",
      "complete",
      deferred.runId,
      deferred.suspension.completionToken,
      "--value",
      "42",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(rejectedDeferred.exitCode).toBe(4);
  expect(JSON.parse(rejectedDeferred.stdout).error.code).toBe("workflow-deferred-value-invalid");

  const completedDeferred = await runKojoCli(
    [
      "run",
      "deferred",
      "complete",
      deferred.runId,
      deferred.suspension.completionToken,
      "--value",
      '"approved"',
      "--request-key",
      "complete-deferred-wait",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(completedDeferred.exitCode, `${completedDeferred.stdout}${completedDeferred.stderr}`).toBe(
    0,
  );
  expect(JSON.parse(completedDeferred.stdout).result.run).toMatchObject({ state: "running" });
  const deferredRedelivery = await runKojoCli(
    [
      "run",
      "deferred",
      "complete",
      deferred.runId,
      deferred.suspension.completionToken,
      "--value",
      '"approved"',
      "--request-key",
      "complete-deferred-wait",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(
    deferredRedelivery.exitCode,
    `${deferredRedelivery.stdout}${deferredRedelivery.stderr}`,
  ).toBe(0);
  expect(JSON.parse(deferredRedelivery.stdout).result.alreadyApplied).toBe(true);
  let final = await runKojoCli(["run", "show", deferred.runId, "--json"], host.socketPath, project);
  for (
    let attempt = 0;
    attempt < 20 && JSON.parse(final.stdout).result.run.state !== "completed";
    attempt += 1
  ) {
    await Bun.sleep(50);
    final = await runKojoCli(["run", "show", deferred.runId, "--json"], host.socketPath, project);
  }
  expect(final.exitCode, `${final.stdout}${final.stderr}`).toBe(0);
  expect(JSON.parse(final.stdout).result.run, final.stdout).toMatchObject({
    state: "completed",
    outcome: { kind: "completed", value: "deferred:approved" },
  });
});

it("durably stops a running Run before interruption, rejects restart controls, and survives redelivery", async () => {
  const directory = await makeTemporaryDirectory("kojo-stop-running-run-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const hostStore = join(directory.path, "host");
  const host = await startKojoHostProcess({ storePath: hostStore });

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "slow", "--input", '{"message":"stop"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = JSON.parse(started.stdout).result.run.runId as string;
  const stopped = await runKojoCli(
    ["run", "stop", runId, "--request-key", "stop-running-run", "--json"],
    host.socketPath,
    project,
  );
  expect(stopped.exitCode, `${stopped.stdout}${stopped.stderr}`).toBe(0);
  expect(JSON.parse(stopped.stdout).result).toMatchObject({
    alreadyApplied: false,
    run: { state: "stopped", outcome: { kind: "stopped" }, allowedActions: [] },
  });

  const redelivered = await runKojoCli(
    ["run", "stop", runId, "--request-key", "stop-running-run", "--json"],
    host.socketPath,
    project,
  );
  expect(redelivered.exitCode, `${redelivered.stdout}${redelivered.stderr}`).toBe(0);
  expect(JSON.parse(redelivered.stdout).result.alreadyApplied).toBe(true);

  const rejectedResume = await runKojoCli(
    ["run", "resume", runId, "--value", '"ignored"', "--json"],
    host.socketPath,
    project,
  );
  expect(rejectedResume.exitCode).toBe(4);
  expect(JSON.parse(rejectedResume.stdout).error.code).toBe("run-not-suspended");
  const rejectedStop = await runKojoCli(
    ["run", "stop", runId, "--request-key", "second-stop", "--json"],
    host.socketPath,
    project,
  );
  expect(rejectedStop.exitCode).toBe(4);
  expect(JSON.parse(rejectedStop.stdout).error.code).toBe("run-stop-not-allowed");

  const database = new Database(join(project, ".kojo", "kojo.sqlite"), { readonly: true });
  try {
    const events = database
      .query("SELECT kind FROM kojo_execution_events WHERE run_id = ? ORDER BY sequence")
      .all(runId) as ReadonlyArray<{ readonly kind: string }>;
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["run.stop-requested", "run.stopped"]),
    );
  } finally {
    database.close();
  }

  await host.stop();
  const restarted = await startKojoHostProcess({ storePath: hostStore });
  cleanups.push(restarted.stop);
  const afterRestart = await runKojoCli(
    ["run", "show", runId, "--json"],
    restarted.socketPath,
    project,
  );
  expect(afterRestart.exitCode, `${afterRestart.stdout}${afterRestart.stderr}`).toBe(0);
  expect(JSON.parse(afterRestart.stdout).result.run).toMatchObject({ state: "stopped" });
});

it("stops a suspended Run without requiring a resume value", async () => {
  const directory = await makeTemporaryDirectory("kojo-stop-suspended-run-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), durableWaitConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "manual-wait", "--input", '{"message":"stop"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = JSON.parse(started.stdout).result.run.runId as string;
  let shown = await runKojoCli(["run", "show", runId, "--json"], host.socketPath, project);
  for (
    let attempt = 0;
    attempt < 100 && JSON.parse(shown.stdout).result.run.state !== "suspended";
    attempt += 1
  ) {
    await Bun.sleep(25);
    shown = await runKojoCli(["run", "show", runId, "--json"], host.socketPath, project);
  }
  expect(JSON.parse(shown.stdout).result.run).toMatchObject({
    state: "suspended",
    allowedActions: expect.arrayContaining(["resume", "stop"]),
  });

  const stopped = await runKojoCli(["run", "stop", runId, "--json"], host.socketPath, project);
  expect(stopped.exitCode, `${stopped.stdout}${stopped.stderr}`).toBe(0);
  expect(JSON.parse(stopped.stdout).result.run).toMatchObject({
    state: "stopped",
    outcome: { kind: "stopped" },
    allowedActions: [],
  });
});

it("detaches a trace-follow client on SIGTERM without stopping the Host Run", async () => {
  const directory = await makeTemporaryDirectory("kojo-stop-interrupted-cli-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "slow", "--input", '{"message":"keep-running"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = JSON.parse(started.stdout).result.run.runId as string;
  const followingClient = startKojoCli(
    ["trace", "follow", runId, "--json"],
    host.socketPath,
    project,
  );
  await followingClient.waitForStdout('"sequence":1');
  followingClient.child.kill("SIGTERM");
  const detached = await followingClient.result;
  expect(detached.exitCode, `${detached.stdout}${detached.stderr}`).toBe(0);

  const shown = await runKojoCli(["run", "show", runId, "--json"], host.socketPath, project);
  expect(shown.exitCode, `${shown.stdout}${shown.stderr}`).toBe(0);
  expect(JSON.parse(shown.stdout).result.run).toMatchObject({ state: "running" });
});

it("propagates stop to non-final Child Workflow Runs before finalizing the parent", async () => {
  const directory = await makeTemporaryDirectory("kojo-stop-child-tree-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), childConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "parent-waits-for-child", "--input", '{"message":"stop"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const parentRunId = JSON.parse(started.stdout).result.run.runId as string;
  let children: ReadonlyArray<Record<string, unknown>> = [];
  for (let attempt = 0; attempt < 100 && children.length === 0; attempt += 1) {
    const listed = await runKojoCli(
      ["run", "list", "--parent-run", parentRunId, "--json"],
      host.socketPath,
      project,
    );
    expect(listed.exitCode, `${listed.stdout}${listed.stderr}`).toBe(0);
    children = JSON.parse(listed.stdout).result;
    if (children.length === 0) await Bun.sleep(25);
  }
  expect(children).toHaveLength(1);
  const childRunId = children[0]?.runId;
  if (typeof childRunId !== "string") throw new Error("Child Workflow Run was not accepted");

  const stopped = await runKojoCli(
    ["run", "stop", parentRunId, "--json"],
    host.socketPath,
    project,
  );
  expect(stopped.exitCode, `${stopped.stdout}${stopped.stderr}`).toBe(0);
  expect(JSON.parse(stopped.stdout).result.run).toMatchObject({ state: "stopped" });
  const child = await runKojoCli(["run", "show", childRunId, "--json"], host.socketPath, project);
  expect(child.exitCode, `${child.stdout}${child.stderr}`).toBe(0);
  expect(JSON.parse(child.stdout).result.run).toMatchObject({ state: "stopped" });
});
