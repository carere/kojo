import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  RunDocument,
  StartRunResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  type RunningDaemon,
  startDaemon,
} from "../../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { captureWorkflowRevision } from "../../../../src/contexts/workflow/services/captureRevision.ts";
import { publishConsoleRelease } from "../../../support/daemon/consoleRelease.ts";
import { linkEngine } from "../../../support/linkEngine.ts";
import { findProcessAncestor, type ProcessRow } from "../../../support/processTree.ts";

const roots: string[] = [];
const daemons: RunningDaemon[] = [];
const packageRoot = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");

const pathsFor = (root: string): DaemonPaths => {
  const installationRoot = join(root, "installation");
  const paths = {
    installationRoot,
    dataRoot: join(root, "data"),
    configurationRoot: join(root, "config"),
    cacheRoot: join(root, "cache"),
    runtimeRoot: join(root, "runtime"),
    serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
    managedCli: join(installationRoot, "bin", "kojo"),
    managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
  };
  publishConsoleRelease(paths);
  return paths;
};

const controlledProject = (root: string, events: string, agentExecutable: string): string => {
  const location = join(root, "project");
  const factory = join(location, ".kojo");
  mkdirSync(join(factory, "workflows"), { recursive: true });
  mkdirSync(join(factory, "prompts", "controlled"), { recursive: true });
  linkEngine({ root: location, packageRoot });
  writeFileSync(
    join(location, "package.json"),
    JSON.stringify({ name: "resource-daemon-fixture", private: true, type: "module" }),
  );
  writeFileSync(
    join(factory, "factory.json"),
    JSON.stringify({
      formatVersion: 1,
      assets: ["kojo.config.yaml", "prompts/controlled/system.md", "prompts/controlled/user.md"],
    }),
  );
  writeFileSync(
    join(factory, "kojo.config.yaml"),
    "agents:\n  controlled:\n    purpose: Prove the Resource boundary\n    model: controlled\n",
  );
  writeFileSync(join(factory, "prompts", "controlled", "system.md"), "Controlled fixture.\n");
  writeFileSync(join(factory, "prompts", "controlled", "user.md"), "{{task}}\n");
  writeFileSync(
    join(factory, "workflows", "resource.ts"),
    `import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import type { AgentProvider } from "@ai-hero/sandcastle";
import { Duration, Effect, Schema } from "effect";
import * as SandcastleAgentInvoker from "@carere/kojo-runtime/contexts/agent/adapters/SandcastleAgentInvoker";
import { fail } from "@carere/kojo-runtime/contexts/gate/models/OnExpiry";
import { noSandbox } from "@carere/kojo-runtime/contexts/sandbox/adapters/providers";
import { CurrentRun } from "@carere/kojo-runtime/contexts/workflow/services/CurrentRun";
import { agent } from "@carere/kojo-runtime/contexts/workflow/services/phase/agent";
import { gate } from "@carere/kojo-runtime/contexts/workflow/services/phase/gate";
import { sandboxed } from "@carere/kojo-runtime/contexts/workflow/services/sandboxed";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";

const event = (value: unknown) => appendFileSync(${JSON.stringify(events)}, JSON.stringify(value) + "\\n");
const released = (path: string, key: string, identity: string, kind: string, locator: string) => {
  const staging = path + ".provider";
  writeFileSync(staging, JSON.stringify({ registryVersion: 1, acquisitionKey: key, providerIdentity: identity, kind, state: "released", locator }) + "\\n");
  renameSync(staging, path);
};
const sandboxProvider = () => {
  const base = noSandbox();
  const actual = base.sandcastle as typeof base.sandcastle & { create: (options: any) => Promise<any> };
  return {
    ...base,
    sandcastle: {
      ...actual,
      create: async (options: any) => {
        const handle = await actual.create(options);
        event({ event: "sandbox-acquired", key: options.env.KOJO_RESOURCE_ACQUISITION_KEY });
        event({ event: "worktree-acquired", key: options.env.KOJO_WORKTREE_ACQUISITION_KEY });
        return {
          ...handle,
          close: async () => {
            await handle.close();
            released(options.env.KOJO_RESOURCE_INSPECTION_FILE, options.env.KOJO_RESOURCE_ACQUISITION_KEY, options.env.KOJO_RESOURCE_PROVIDER_IDENTITY, "sandbox", handle.worktreePath);
            released(options.env.KOJO_WORKTREE_INSPECTION_FILE, options.env.KOJO_WORKTREE_ACQUISITION_KEY, options.env.KOJO_WORKTREE_PROVIDER_IDENTITY, "worktree", handle.worktreePath);
            event({ event: "sandbox-released", key: options.env.KOJO_RESOURCE_ACQUISITION_KEY });
            event({ event: "worktree-released", key: options.env.KOJO_WORKTREE_ACQUISITION_KEY });
          },
        };
      },
    },
  };
};
const provider = (): AgentProvider => ({
  name: "controlled-executable",
  env: {},
  captureSessions: false,
  buildPrintCommand: ({ prompt }) => ({ command: ${JSON.stringify(`${process.execPath} ${agentExecutable}`)}, stdin: prompt }),
  parseStreamLine: (line) => line.startsWith("@session ")
    ? [{ type: "session_id", sessionId: line.slice(9) }]
    : line.trim() === "" ? [] : [{ type: "text", text: line + "\\n" }],
});
const agents = SandcastleAgentInvoker.fromConfig({ config: ".kojo/kojo.config.yaml", provider });
const Answer = Schema.Struct({ answer: Schema.String });

export const resource = workflow(
  { name: "resource", payload: Schema.Struct({ gate: Schema.Boolean }), success: Schema.String, error: Schema.Unknown, idempotencyKey: () => "resource-daemon-run" },
  (payload) => Effect.gen(function* () {
    const run = yield* CurrentRun;
    const invoke = (name: string) => agent({ name, description: "Run only the controlled executable", agent: "controlled", prompt: "answer", envelope: Answer }).pipe(
      Effect.map((answer) => answer.answer),
      Effect.tapError((cause) => Effect.sync(() => event({ event: "agent-fault", cause }))),
    );
    const lane = <A, E, R>(body: Effect.Effect<A, E, R>) => sandboxed(
      { name: "controlled", branch: "kojo/resource-" + run.runId, provider: sandboxProvider(), cwd: ${JSON.stringify(location)}, hidden: [] },
      body.pipe(Effect.provide(agents)),
    );
    if (!payload.gate) return yield* lane(invoke("controlled-agent"));
    return yield* lane(Effect.gen(function* () {
      yield* invoke("controlled-agent-before");
      yield* gate({
        name: "continue",
        description: "Continue with a second physical Resource acquisition?",
        actor: "fixture-reviewer",
        choices: ["continue", "stop"],
        deadline: Duration.hours(1),
        onExpiry: fail(),
      });
      return yield* invoke("controlled-agent-after");
    }));
  }),
);
`,
  );
  execFileSync("git", ["init", "--initial-branch=main", location]);
  execFileSync("git", ["-C", location, "config", "user.email", "test@kojo.local"]);
  execFileSync("git", ["-C", location, "config", "user.name", "Kojo Test"]);
  execFileSync("git", ["-C", location, "add", "."]);
  execFileSync("git", ["-C", location, "commit", "-m", "test: controlled Resource fixture"]);
  return realpathSync(location);
};

const call = (daemon: RunningDaemon, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://localhost${path}`, {
    unix: daemon.endpoint.socketPath,
    ...init,
  } as RequestInit & { readonly unix: string });

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("real Daemon Resource lifecycle", () => {
  it.each([
    ["without a lost reply", undefined, false],
    ["after a lost acquisition-intent reply", "BeginResourceAcquisition", false],
    ["after a lost acquired-provider reply", "ConfirmResourceAcquired", false],
    ["after a lost release reply", "ConfirmResourceReleased", false],
    ["until a crash preserves dirty provider state", undefined, "dirty"],
    ["until a crash preserves unreadable provider state", undefined, "unreadable"],
    ["after restart at the durable termination boundary", undefined, "restart"],
    ["after bounded recovery exceeds 256 Resources", undefined, "bounded"],
    ["across a Gate suspension and resume", undefined, "gate"],
  ] as const)(
    "runs one controlled sandbox and agent through the private Runner %s",
    async (_case, lostKind, crashMode) => {
      const root = mkdtempSync(join(process.cwd(), ".kojo-resource-daemon-"));
      roots.push(root);
      const paths = pathsFor(root);
      const events = join(root, "provider-events.jsonl");
      const executable = join(root, "controlled-agent.ts");
      const crashEvidence = join(root, "crash-evidence.json");
      const crashes =
        crashMode === "dirty" ||
        crashMode === "unreadable" ||
        crashMode === "restart" ||
        crashMode === "bounded";
      writeFileSync(
        executable,
        `import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const key = process.env.KOJO_RESOURCE_ACQUISITION_KEY as string;
const identity = process.env.KOJO_RESOURCE_PROVIDER_IDENTITY as string;
const registry = process.env.KOJO_RESOURCE_INSPECTION_FILE as string;
appendFileSync(${JSON.stringify(events)}, JSON.stringify({ event: "agent-acquired", key }) + "\\n");
if (${JSON.stringify(crashes)}) {
  writeFileSync("dirty-provider-state.txt", "preserve me\\n");
  writeFileSync("captured-session.json", JSON.stringify({ sessionId: "controlled-session", key }));
  writeFileSync(${JSON.stringify(crashEvidence)}, JSON.stringify({ pid: process.pid, parent: process.ppid, cwd: process.cwd(), key }));
  const held = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(held, 0, 0, 60_000);
  process.exit(90);
}
const staging = registry + ".controlled";
writeFileSync(staging, JSON.stringify({ registryVersion: 1, acquisitionKey: key, providerIdentity: identity, kind: "agent", state: "released", locator: "controlled-session" }) + "\\n");
renameSync(staging, registry);
appendFileSync(${JSON.stringify(events)}, JSON.stringify({ event: "agent-released", key }) + "\\n");
console.log("@session controlled-session");
console.log(JSON.stringify({ answer: "controlled" }));
`,
      );
      const location = controlledProject(root, events, executable);
      mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
      const captured = captureWorkflowRevision({
        project: location,
        dataRoot: paths.dataRoot,
        workflowName: "resource",
      });
      const databasePath = join(paths.dataRoot, "kojo.db");
      const database = new Database(databasePath, { create: true, strict: true });
      database.run(
        "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
      );
      const projects = new SqliteProjectRepository(database);
      const registered = await Effect.runPromise(
        projects.register({
          requestId: "seed-resource-project",
          requestBody: "seed-resource-project",
          dataIdentity: "seed-data",
          location,
          observedAt: "2026-09-01T00:00:00.000Z",
          factory: {
            state: "available",
            refreshState: "current",
            workflows: [
              {
                workflowName: "resource",
                availability: "available",
                source: join(location, ".kojo", "workflows", "resource.ts"),
                revision: captured,
              },
            ],
          },
        }),
      );
      database.close(false);
      chmodSync(databasePath, 0o600);

      const isolatedPath = join(root, "bin");
      mkdirSync(isolatedPath);
      for (const name of ["git", "sh", "env"] as const) {
        const resolved = execFileSync("which", [name], { encoding: "utf8" }).trim();
        symlinkSync(resolved, join(isolatedPath, name));
      }
      const priorPath = process.env.PATH;
      process.env.PATH = isolatedPath;
      let dropped = false;
      let recoveryPaused = false;
      try {
        const daemon = startDaemon(paths, {
          automaticRefresh: false,
          runnerIdleMillis: 50,
          ...(lostKind === undefined
            ? {}
            : {
                resourceMutationFault: (mutation) => {
                  if (dropped || mutation.kind !== lostKind) return undefined;
                  dropped = true;
                  return "after-commit" as const;
                },
              }),
          ...(crashMode === "restart" || crashMode === "bounded"
            ? {
                resourceRecoveryBoundary: () =>
                  Effect.sync(() => {
                    recoveryPaused = true;
                  }).pipe(Effect.andThen(Effect.never)),
              }
            : {}),
        });
        daemons.push(daemon);
        const response = await call(
          daemon,
          `/api/v1/projects/${registered.project.projectId}/workflows/resource/actions/start`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              requestId: "start-resource",
              dataIdentity: daemon.endpoint.dataIdentity,
              payload: { gate: crashMode === "gate" },
            }),
          },
        );
        expect(response.status, await response.clone().text()).toBe(202);
        const admitted = (await response.json()) as StartRunResult;
        if (crashMode === "gate") {
          const askingDeadline = Date.now() + 10_000;
          let token: string | undefined;
          while (token === undefined && Date.now() < askingDeadline) {
            const snapshot = (await (await call(daemon, "/api/v1/askings")).json()) as {
              readonly askings: ReadonlyArray<{ readonly token: string; readonly state: string }>;
            };
            token = snapshot.askings.find((asking) => asking.state === "unanswered")?.token;
            if (token === undefined) await Bun.sleep(20);
          }
          expect(token).toBeDefined();
          const answered = await call(daemon, "/api/v1/gate-answers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              requestId: "answer-resource-gate",
              dataIdentity: daemon.endpoint.dataIdentity,
              token,
              choice: "continue",
              reason: "prove the next physical acquisition",
            }),
          });
          expect(answered.status, await answered.clone().text()).toBe(200);
        }
        if (crashes) {
          const evidenceDeadline = Date.now() + 10_000;
          while (!existsSync(crashEvidence) && Date.now() < evidenceDeadline) await Bun.sleep(10);
          expect(existsSync(crashEvidence)).toBe(true);
          const evidence = JSON.parse(readFileSync(crashEvidence, "utf8")) as {
            readonly pid: number;
            readonly parent: number;
            readonly cwd: string;
            readonly key: string;
          };
          const processes: ReadonlyArray<ProcessRow> = execFileSync(
            "/bin/ps",
            ["-axo", "pid=,ppid=,command="],
            {
              encoding: "utf8",
            },
          )
            .trim()
            .split("\n")
            .map((line) => {
              const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
              return match === null
                ? undefined
                : { pid: Number(match[1]), parent: Number(match[2]), command: match[3] ?? "" };
            })
            .filter((row) => row !== undefined);
          const runner = findProcessAncestor(processes, evidence.parent, (process) =>
            process.command.includes("runner/main"),
          );
          expect(
            runner,
            JSON.stringify({
              evidence,
              processes: processes.filter(
                (process) => process.pid === evidence.pid || process.pid === evidence.parent,
              ),
            }),
          ).toBeDefined();
          if (runner === undefined) throw new Error("the Project Runner ancestor is absent");
          expect(runner.command).toContain("runner/main");
          if (crashMode === "unreadable") {
            renameSync(join(evidence.cwd, ".git"), join(evidence.cwd, ".git-preserved"));
            const anchor = join(evidence.cwd, "..", "..", "..");
            renameSync(join(anchor, ".git"), join(anchor, ".git-preserved"));
          }
          process.kill(runner.pid, "SIGKILL");
          if (crashMode === "restart" || crashMode === "bounded") {
            const pauseDeadline = Date.now() + 10_000;
            while (!recoveryPaused && Date.now() < pauseDeadline) await Bun.sleep(10);
            expect(recoveryPaused).toBe(true);
            await Effect.runPromise(daemon.stop);
            daemons.splice(daemons.indexOf(daemon), 1);
            if (crashMode === "bounded") {
              const seeding = new Database(databasePath, { strict: true });
              const template = seeding
                .query<
                  {
                    readonly project_id: string;
                    readonly run_id: string;
                    readonly revision_id: string;
                    readonly runner_instance_id: string;
                    readonly claim_generation: number;
                  },
                  []
                >(
                  `SELECT project_id, run_id, revision_id, runner_instance_id, claim_generation
                   FROM project_resource_leases LIMIT 1`,
                )
                .get();
              expect(template).not.toBeNull();
              if (template === null) throw new Error("the bounded recovery fixture has no lease");
              for (let index = 0; index < 254; index += 1) {
                seeding.run(
                  `INSERT INTO project_resource_leases (
                   lease_id, project_id, run_id, revision_id, runner_instance_id,
                   claim_generation, resource_kind, acquisition_key, state, requested_at,
                   detail_json, provider_identity, inspection_locator
                 ) VALUES (?, ?, ?, ?, ?, ?, 'agent', ?, 'acquisition-intent', ?, '{}', ?, ?)`,
                  [
                    `bounded-${index}`,
                    template.project_id,
                    template.run_id,
                    template.revision_id,
                    template.runner_instance_id,
                    template.claim_generation,
                    `bounded/${index}`,
                    new Date(index).toISOString(),
                    `kojo-resource:bounded-${index}`,
                    join(root, `missing-provider-${index}.json`),
                  ],
                );
              }
              seeding.close(false);
            }
            const replacement = startDaemon(paths, {
              automaticRefresh: false,
              runnerIdleMillis: 50,
            });
            daemons.push(replacement);
          }
          const holdDeadline = Date.now() + 10_000;
          let recovery: { readonly state: string; readonly safety: string } | null = null;
          while (Date.now() < holdDeadline) {
            const recoveryObserver = new Database(databasePath, { readonly: true, strict: true });
            recovery = recoveryObserver
              .query<{ readonly state: string; readonly safety: string }, []>(
                "SELECT state, safety FROM project_runner_recovery LIMIT 1",
              )
              .get();
            recoveryObserver.close(false);
            if (recovery?.state === "held") break;
            await Bun.sleep(20);
          }
          expect(recovery).toEqual({ state: "held", safety: "uncertain" });
          expect(readFileSync(join(evidence.cwd, "dirty-provider-state.txt"), "utf8")).toBe(
            "preserve me\n",
          );
          expect(
            JSON.parse(readFileSync(join(evidence.cwd, "captured-session.json"), "utf8")),
          ).toEqual({
            sessionId: "controlled-session",
            key: evidence.key,
          });
          expect(
            execFileSync(
              "git",
              ["-C", location, "branch", "--list", `kojo/resource-${admitted.runId}`],
              {
                encoding: "utf8",
              },
            ).trim(),
          ).toContain(`kojo/resource-${admitted.runId}`);
          await Bun.sleep(500);
          const crashEvents = readFileSync(events, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { readonly event: string });
          expect(crashEvents.filter((event) => event.event === "agent-acquired")).toHaveLength(1);
          expect(crashEvents.filter((event) => event.event === "sandbox-acquired")).toHaveLength(1);
          const heldObserver = new Database(databasePath, { readonly: true, strict: true });
          const heldLeases = heldObserver
            .query<
              {
                readonly resource_kind: string;
                readonly state: string;
                readonly reason: string | null;
              },
              []
            >(
              "SELECT resource_kind, state, reason FROM project_resource_leases ORDER BY resource_kind",
            )
            .all();
          heldObserver.close(false);
          if (crashMode === "bounded") {
            expect(heldLeases).toHaveLength(257);
          } else {
            expect(heldLeases).toContainEqual(
              expect.objectContaining({ resource_kind: "worktree", state: "preserved" }),
            );
            expect(heldLeases.some((lease) => lease.state === "unresolved")).toBe(true);
          }
          if (crashMode === "unreadable") {
            expect(
              heldLeases.find((lease) => lease.resource_kind === "worktree")?.reason,
            ).toContain("unreadable worktree");
          }
          return;
        }
        const deadline = Date.now() + 20_000;
        let run: RunDocument | undefined;
        while (Date.now() < deadline) {
          run = (await (
            await call(daemon, `/api/v1/runs/${admitted.runId}`)
          ).json()) as RunDocument;
          if (run.state === "succeeded" || run.state === "failed" || run.state === "held") break;
          await Bun.sleep(20);
        }
        const diagnostic = existsSync(events) ? readFileSync(events, "utf8") : "no provider events";
        const liveObserver = new Database(databasePath, { readonly: true, strict: true });
        const resourceDiagnostic = liveObserver
          .query<Record<string, unknown>, []>(
            "SELECT lease_id, resource_kind, state, reason, evidence FROM project_resource_leases",
          )
          .all();
        liveObserver.close(false);
        expect(
          run,
          `${JSON.stringify(run, null, 2)}\n${diagnostic}\n${JSON.stringify(resourceDiagnostic)}`,
        ).toMatchObject({
          runId: admitted.runId,
          state: "succeeded",
        });
        const acquisitions = crashMode === "gate" ? 2 : 1;
        expect(run?.sandboxes).toHaveLength(acquisitions);
        expect(run?.sandboxes?.map((sandbox) => sandbox.outcome).sort()).toEqual(
          crashMode === "gate" ? ["interrupted", "released"] : ["released"],
        );
        expect(
          run?.sandboxes?.every((sandbox) => sandbox.environment.KOJO_RUN_ID === admitted.runId),
        ).toBe(true);
        expect(run?.gates).toHaveLength(crashMode === "gate" ? 1 : 0);
        if (crashMode === "gate") {
          expect(run?.gates?.[0]).toMatchObject({
            gate: "continue",
            actor: "fixture-reviewer",
            outcome: "answered",
            choice: "continue",
            reason: "prove the next physical acquisition",
          });
        }
        expect(dropped).toBe(lostKind !== undefined);
      } finally {
        process.env.PATH = priorPath;
      }

      expect(existsSync(events)).toBe(true);
      const actual = readFileSync(events, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { readonly event: string; readonly key: string });
      const acquisitions = crashMode === "gate" ? 2 : 1;
      for (const event of [
        "agent-acquired",
        "agent-released",
        "sandbox-acquired",
        "sandbox-released",
        "worktree-acquired",
        "worktree-released",
      ]) {
        expect(actual.filter((record) => record.event === event)).toHaveLength(acquisitions);
      }
      expect(new Set(actual.map((event) => `${event.event}:${event.key}`)).size).toBe(
        acquisitions * 6,
      );

      const observer = new Database(databasePath, { readonly: true, strict: true });
      const leases = observer
        .query<
          {
            readonly lease_id: string;
            readonly resource_kind: string;
            readonly state: string;
            readonly locator: string | null;
          },
          []
        >(
          "SELECT lease_id, resource_kind, state, locator FROM project_resource_leases ORDER BY resource_kind",
        )
        .all();
      observer.close(false);
      expect(leases).toHaveLength(acquisitions * 3);
      expect(leases.every((lease) => /^resource_[a-f0-9]{64}$/.test(lease.lease_id))).toBe(true);
      expect(leases.every((lease) => lease.state === "released")).toBe(true);
      expect(
        leases
          .find((lease) => lease.resource_kind === "worktree")
          ?.locator?.startsWith(join(paths.dataRoot, "worktrees")),
      ).toBe(true);
    },
    30_000,
  );
});
