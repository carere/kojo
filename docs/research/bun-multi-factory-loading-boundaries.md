# Bun boundaries for loading many factories

## Question

What boundaries can a long-lived Kojo daemon use when it loads project-owned TypeScript from
several registered projects? What limits do Bun and Effect put on a later execution-boundary
decision?

This note uses Bun 1.3.14 and Effect 4.0.0-beta.106, which are the versions in this repository. It
uses only Bun documentation and Effect source as external evidence. It does not choose the
execution architecture.

## Result

Bun gives Kojo three relevant levels of separation:

| Level | Module and dependency state | Working directory | Failure boundary | Control channel |
| --- | --- | --- | --- | --- |
| One JavaScript instance | One live module graph in the daemon | One process working directory | Effect can contain Effect failures and defects. It cannot contain process exit, a blocked JavaScript thread, or a runtime crash. | Direct calls and Effect fibers |
| Bun `Worker` | A new JavaScript instance on another thread | No per-Worker `cwd` option is documented | A Worker can exit without stopping the main thread, but it is still in the daemon process. Worker termination is experimental. | `postMessage` and structured clone |
| Bun subprocess | A new operating-system process and module graph | Explicit `cwd` and `env` for each process | The daemon can observe, signal, and replace the subprocess. | Bun IPC, stdin, stdout, and stderr |

An Effect fiber is a lifetime boundary. It is not a dependency, JavaScript-thread, or process
boundary. A Worker is a JavaScript-instance and thread boundary. It is not an operating-system
process boundary. A subprocess supplies the process boundary.

## Module cache and reload

Bun supports dynamic `import()` for TypeScript. It resolves bare package imports by scanning up the
file system for `node_modules`. Therefore, a workflow module can resolve dependencies from its own
project when Kojo imports it by absolute path. See [Bun module resolution](https://bun.sh/docs/runtime/module-resolution#importing-packages).

An evaluated module stays in the JavaScript instance's module cache. Bun's official test
documentation says that an imported module has already run its side effects and that module mocks
update both the ESM and CommonJS caches. See [Bun module mock cache behavior](https://bun.sh/docs/test/mocks#module-mock-best-practices)
and [Bun cache implementation details](https://bun.sh/docs/test/mocks#cache-interaction).

Bun documents no production API that unloads an ESM graph. `mock.module` is a test API, not a
daemon reload mechanism. Thus, a repeated import in one JavaScript instance is not a clean factory
reload. It can keep old module state and old transitive dependencies. A new Worker or a new
subprocess creates a new JavaScript instance and can load a new graph.

The later decision must specify what event makes changed workflow source effective. It must not
treat a second dynamic import as a clean restart.

## Current-working-directory behavior

The Bun runtime has one process working directory. Its `--cwd` option changes that process working
directory. See [Bun runtime `--cwd`](https://bun.sh/docs/runtime#global-configuration-context).
Mutating it while several factories run would change process-relative behavior for all work in the
same process.

A Bun Worker has options for `argv`, `env`, `preload`, lifetime, and heap size mode. It has no
documented `cwd` option. See [Bun `WorkerOptions`](https://bun.sh/reference/bun/WorkerOptions).
Code in a Worker must not depend on a per-project process working directory unless Kojo supplies a
different mechanism.

`Bun.spawn` has an explicit `cwd` and `env` for each subprocess. See [Bun subprocess
configuration](https://bun.sh/docs/runtime/child-process#spawn-a-process-bunspawn). Bun Shell also
has a per-command `.cwd()`, but its default can be changed for the complete Bun Shell instance. See
[Bun Shell working directories](https://bun.sh/docs/runtime/shell#changing-the-working-directory).

Bun's automatic install fallback also examines the working directory when it decides whether to
use Bun-style package installation. See [Bun automatic install](https://bun.sh/docs/runtime/auto-install).
The later design must define install behavior. It must not let the daemon working directory select
dependencies by accident.

## Dependency and Effect-instance isolation

Different absolute package paths can give one JavaScript instance different physical copies of a
dependency. Bun's resolution rules permit this because each bare import scans upward from its
importer. A module cache keeps each resolved graph live.

Effect does not define a compatibility contract for passing Effects, Schemas, Layers, or services
between different Effect versions. Effect service identity also uses a string key. The Effect
source warns that two services with the same string key occupy the same `Context` slot. See
[Effect `Context.Service`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Context.ts#L151-L170).
This permits unwanted identity overlap in one JavaScript instance. It does not make different
Effect versions compatible.

A new Worker or subprocess isolates the dependency graph that it loads. However, this separation
also prevents Kojo from passing a live workflow definition, `Effect`, `Layer`, or service instance
through the control channel. Worker messages use the structured clone algorithm. Bun subprocess
IPC uses JSC serialization with structured-clone support, or JSON. Neither channel is a
function-call channel. See [Worker messages](https://bun.sh/docs/runtime/workers#messages-with-postmessage)
and [subprocess IPC serialization](https://bun.sh/docs/runtime/child-process#inter-process-communication-ipc).

Thus, a boundary that owns a factory must load the workflow in that boundary. Messages across the
boundary must be data with an explicit schema. Kojo must not send a live Effect value across it.

## Failure containment

Effect converts a JavaScript exception thrown while a fiber evaluates an Effect into a defect in
that fiber. See the `try` and `catch` in the [Effect fiber run loop](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/internal/effect.ts#L653-L697).
Kojo can observe that `Exit` and keep other fibers alive.

This containment has limits:

- Module evaluation happens before Kojo has a workflow Effect unless Kojo wraps the dynamic import
  in an Effect constructor.
- A CPU-bound or blocking operation can stop progress on its JavaScript thread.
- Effect cannot intercept `process.exit()`, an out-of-memory stop, or a Bun process crash.
- Effect interruption is cooperative. It does not force uninterruptible work to stop. See [Effect
  fiber interruption](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Fiber.ts#L304-L340).

A Bun Worker uses a new JavaScript instance on a separate thread, but it shares I/O resources with
the main thread and stays in the same Bun process. Bun says that a Worker's `process.exit()` does
not stop the main thread. Bun also says that the Worker API is experimental, especially termination.
See [Bun Workers](https://bun.sh/docs/runtime/workers) and [Worker termination](https://bun.sh/docs/runtime/workers#terminating-a-worker).
The documented Worker options do not include resource limits. Therefore, a Worker can contain a
factory exit and a blocked JavaScript thread, but the Bun documentation does not promise process
failure containment.

A subprocess reports exit through `onExit` and `Subprocess.exited`. The parent can send a signal
with `kill()`. See [Bun subprocess exit handling](https://bun.sh/docs/runtime/child-process#exit-handling).
This gives the daemon an observable process failure boundary.

## IPC limits

Worker IPC uses `postMessage`, message events, and structured clone. Bun can transfer or clone the
supported data types. This channel cannot preserve functions, open Effect services, or Layer
lifetimes.

Bun-to-Bun subprocess IPC provides `Subprocess.send()`, `process.send()`, and message handlers. Its
default `advanced` mode uses JSC serialization and cannot transfer object ownership. Its `json`
mode uses JSON and is required for Bun-to-Node IPC. Subprocess stdin, stdout, and stderr are also
available as streams. See [Bun subprocess IPC](https://bun.sh/docs/runtime/child-process#inter-process-communication-ipc)
and [Bun subprocess streams](https://bun.sh/docs/runtime/child-process#output-streams).

All boundary protocols need request identity, result identity, error encoding, and protocol-version
checks. Structured clone alone does not supply these rules.

## Cancellation and cleanup

Effect can group factory fibers in a `FiberSet`. Closing its Scope interrupts all fibers and waits
for their cleanup. See [Effect `FiberSet`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/FiberSet.ts#L166-L210).
A `ManagedRuntime` owns a Scope for its Layer resources. `dispose` closes that Scope, and the runtime
cannot be used after disposal. See [Effect `ManagedRuntime`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/ManagedRuntime.ts#L260-L355).

Effect cancellation remains cooperative. An asynchronous adapter stops only if it observes the
`AbortSignal` that Effect aborts on interruption. See [Effect Promise cancellation](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Effect.ts#L1250-L1335).

For a Worker, `terminate()` requests exit as soon as possible. The `close` event reports when Bun
has marked it terminated. Bun warns that complete termination can take time. See [Worker close and
termination](https://bun.sh/docs/runtime/workers#close).

For a subprocess, Bun supports an `AbortSignal`, a timeout, a chosen kill signal, and direct
`kill()`. See [subprocess cancellation](https://bun.sh/docs/runtime/child-process#using-abortsignal)
and [subprocess timeouts](https://bun.sh/docs/runtime/child-process#using-timeout-and-killsignal).
These APIs name the direct subprocess. The documentation does not promise that `kill()` cleans up
every descendant process that a workflow started. The later design must define descendant and
sandbox cleanup.

## Restart behavior

None of these APIs supplies a factory supervisor.

- An in-process factory has no clean module restart. Kojo can dispose its Effect Scope, but that
  does not unload its JavaScript modules.
- A closed Worker can be replaced with a new Worker. The parent must detect `error` or `close`,
  create the replacement, and restore factory state.
- An exited subprocess can be replaced with a new subprocess. The parent must apply retry limits,
  delay, health checks, and state restoration.

A replacement Worker or subprocess starts with new volatile memory. Durable runs, askings, trace,
and trigger positions must come from storage or an explicit recovery protocol. The boundary API
does not provide this recovery.

## Constraints for the later decision

The execution-boundary decision must respect these constraints:

1. It must state whether project code shares the daemon JavaScript instance, only the daemon
   process, or neither.
2. It must define the exact Kojo and Effect version contract inside each JavaScript instance.
3. It must load each workflow in the boundary that runs it. Cross-boundary messages must contain
   data, not Effects, Layers, or services.
4. It must define the project working directory and install behavior. Concurrent factories must
   not compete through `process.chdir()`.
5. It must define when workflow edits become active. A repeated import is not a clean reload.
6. It must separate graceful Effect interruption from forced Worker or process termination.
7. It must define cleanup for child processes, sandboxes, and other resources after forced stop.
8. It must define who detects boundary exit, when it restarts, and how durable factory state is
   restored.
9. It must state which failures are allowed to stop the complete Kojo daemon.
10. If it uses Workers, it must accept Bun's experimental termination contract and the absence of
    documented per-Worker `cwd` and resource limits, or add another mechanism for those needs.
