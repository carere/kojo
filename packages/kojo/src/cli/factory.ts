import { Duration, Effect, FileSystem, Layer, Path, type PlatformError } from "effect";
import type { Migrator, SqlError } from "effect/unstable/sql";
import type { WorkflowEngine } from "effect/unstable/workflow";
import * as AbsentAgentInvoker from "../contexts/agent/adapters/AbsentAgentInvoker.ts";
import type { AgentInvoker } from "../contexts/agent/ports/AgentInvoker.ts";
import * as RecordingGate from "../contexts/gate/adapters/RecordingGate.ts";
import * as SqliteGateRepository from "../contexts/gate/adapters/SqliteGateRepository.ts";
import type { GateStoreError } from "../contexts/gate/models/GateStoreError.ts";
import type { Gate } from "../contexts/gate/ports/Gate.ts";
import type { GateRepository } from "../contexts/gate/ports/GateRepository.ts";
import * as BindMountWorkspace from "../contexts/sandbox/adapters/BindMountWorkspace.ts";
import * as SandcastleSandboxSource from "../contexts/sandbox/adapters/SandcastleSandboxSource.ts";
import type { SandboxSource } from "../contexts/sandbox/ports/SandboxSource.ts";
import type { Workspace } from "../contexts/sandbox/ports/Workspace.ts";
import * as SqliteDatabase from "../contexts/shared/adapters/SqliteDatabase.ts";
import type { RecordedTrace } from "../contexts/trace/adapters/InMemoryTracer.ts";
import * as RecordingTracer from "../contexts/trace/adapters/RecordingTracer.ts";
import * as SqliteTracer from "../contexts/trace/adapters/SqliteTracer.ts";
import type { Tracer } from "../contexts/trace/ports/Tracer.ts";
import * as SingleNodeEngine from "../contexts/workflow/adapters/SingleNodeEngine.ts";
import * as SqliteRunnerRepository from "../contexts/workflow/adapters/SqliteRunnerRepository.ts";
import type { RunnerRepository } from "../contexts/workflow/ports/RunnerRepository.ts";

/**
 * How long a run waits before it notices an answer another process wrote.
 *
 * The cluster's default is ten seconds, which is the right answer for a factory watching itself and
 * the wrong one for a command a person is standing in front of: `kojo gate answer` is *also* the
 * runner that applies the answer, so the default would make every answer sit for ten seconds before
 * the run it belongs to moved.
 */
const pollInterval = Duration.millis(250);

/** Everything one `kojo` invocation needs, minus the workflow bodies. */
export type Factory =
  | WorkflowEngine.WorkflowEngine
  | Tracer
  | RecordedTrace
  | Gate
  | GateRepository
  | SandboxSource
  | Workspace
  | AgentInvoker;

/**
 * The layers of one command, over one database file.
 *
 * Built here and provided inside the handler rather than through `Command.provide`, because the
 * path is a flag: the layer cannot exist before the command line is parsed.
 *
 * `provideMerge` rather than `provide` all the way down, for the reason `SqliteDatabase` insists on:
 * the engine's storage, the askings and the trace are three schemas on **one** file, so they must be
 * handed one client value. Two calls to the database layer are two `bun:sqlite` handles with two
 * independent write serializers — and with two of those, `kojo watch` and `kojo run` starting
 * together is a coin flip rather than a wait.
 *
 * **The trace is the durable one, and it is wrapped rather than replaced.** `SqliteTracer` is what
 * makes a run readable by `kojo ui` from another process days later; `RecordingTracer` keeps, in
 * this process, the records it passed on, and that in-process copy is what a command prints. The two
 * are different questions — what the factory has done, and what *this invocation* executed — and the
 * second is the cheapest replay witness there is: a resumed run prints only the phases it actually
 * ran.
 *
 * **The sandbox source and the agent invoker are here, not in `run`.** A factory's own workflow
 * enters a sandbox and calls an agent, and it does so on *every* command that carries a runner:
 * `kojo gate answer` resumes a suspended run by replaying its body, which re-enters the sandbox
 * scope and rebuilds the container from the branch. A build that offered them only where a run is
 * started would answer a gate and then die on a missing service.
 *
 * The invoker is `AbsentAgentInvoker`, which refuses every call and says why. Read its own comment
 * before replacing it: refusing is the honest state of a build with no agent provider in it, and the
 * alternative is not a working agent but a `Service not found` defect.
 *
 * **The workspace here is the host's — the repository this command was launched in.** It is the one
 * a phase acts through *outside* a sandbox scope, and the merge is the phase that needs it: inside
 * the scope `sandboxed` shadows this with the sandbox's own workspace, which is the worktree the
 * run's branch is checked out in, and a merge there would be a branch into itself. So the boundary
 * of architecture.md D2 — setup on the host, risk inside, merge on the host — is drawn by one layer
 * stack rather than by an author remembering. Without it a stamped workflow that merges dies on a
 * missing service *after* the agent has been paid for and the human has answered.
 */
export const factory = (
  database: string,
): Layer.Layer<
  Factory,
  SqlError.SqlError | GateStoreError | Migrator.MigrationError,
  SandcastleSandboxSource.HostServices
> =>
  Layer.mergeAll(
    // `provide`, never a merge: a merge would leave the two tracers competing for one tag, and the
    // in-process copy would be the trace nothing durable ever saw.
    RecordingTracer.layer.pipe(Layer.provide(SqliteTracer.layer)),
    RecordingGate.layer.pipe(Layer.provideMerge(SqliteGateRepository.layer)),
    SandcastleSandboxSource.layer,
    // The process's own directory, which is the repository a person ran `kojo` in. `sandboxed`
    // provides its own `Workspace` over the top for the region inside it, so this is only ever what
    // a phase outside a scope acts through.
    BindMountWorkspace.layer({ root: process.cwd() }),
    AbsentAgentInvoker.layer,
    SingleNodeEngine.layer({
      shardingConfig: {
        entityMessagePollInterval: pollInterval,
        entityReplyPollInterval: pollInterval,
        refreshAssignmentsInterval: pollInterval,
      },
    }),
  ).pipe(Layer.provideMerge(SqliteDatabase.layer({ path: database })));

/**
 * The registration table alone, with no engine over it.
 *
 * Every runner registers at the same address by default,
 * so a process that built the engine first would find its **own** row and report itself as somebody
 * else. `kojo watch` reads this before it becomes a runner, which is the only moment the answer is
 * about anybody but itself.
 */
export const runners = (database: string): Layer.Layer<RunnerRepository, SqlError.SqlError> =>
  SqliteRunnerRepository.layer.pipe(Layer.provide(SqliteDatabase.layer({ path: database })));

/**
 * Every schema the factory's file holds, and nothing that executes.
 *
 * The three writers of that file, over one client: Kojo's own ledger and tables (`SqliteTracer`),
 * the askings (`SqliteGateRepository`) and the cluster's five (`SingleNodeEngine`). Building the
 * engine here is heavier than reaching for the cluster's migrators directly, and it is the honest
 * weight: a migration this list forgets is a migration that runs later, in whichever process got
 * there first, with the others alongside it — which is the fault being fixed. Building the whole
 * engine layer cannot forget one. It also leaves nothing behind: the runner it registers is
 * unregistered when the scope closes, so the file this produces holds schema and ledger rows only.
 */
const schema = (
  database: string,
): Layer.Layer<
  Tracer | GateRepository | WorkflowEngine.WorkflowEngine,
  SqlError.SqlError | GateStoreError | Migrator.MigrationError
> =>
  Layer.mergeAll(SqliteTracer.layer, SqliteGateRepository.layer, SingleNodeEngine.layer()).pipe(
    Layer.provide(SqliteDatabase.layer({ path: database })),
  );

/**
 * Creates and migrates the factory's database once, before any command opens it.
 *
 * Called by every command that writes — `run`, `watch` and `gate answer` — immediately after
 * `readyFor`, and the pairing is the point: one makes the directory, the other makes the file.
 * Both are cheap to the point of invisibility on a factory that has already started once, and
 * neither can be left out of a new command without the race coming back, so they read as one step.
 *
 * See `SqliteDatabase.firstRun` for what it guards against and why nothing else can.
 */
export const created = (
  database: string,
): Effect.Effect<
  void,
  SqlError.SqlError | GateStoreError | Migrator.MigrationError | PlatformError.PlatformError,
  FileSystem.FileSystem
> => SqliteDatabase.firstRun({ path: database, schema });

/**
 * Makes sure the directory the database lives in exists.
 *
 * The driver creates the file and not the folder, so `--database .kojo/kojo.db` on a fresh repo
 * fails on the folder rather than on anything the user did wrong. A failure here is swallowed on
 * purpose: whatever is really wrong with the path, SQLite says it better than `mkdir` does, and it
 * says it about the file the user named.
 */
export const readyFor = (
  database: string,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = path.dirname(database);
    if (directory === "" || directory === ".") return;
    yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.ignore);
  });
