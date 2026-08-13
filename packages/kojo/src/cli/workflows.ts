import type { Cause, Option } from "effect";
import { Effect, Layer } from "effect";
import type { WorkflowEngine } from "effect/unstable/workflow";
import { decodeUnknown } from "../contexts/shared/lib/decode.ts";
import type { RunId } from "../contexts/shared/models/RunId.ts";
import type { Driven } from "../contexts/trigger/models/Driven.ts";
import { runFor } from "../contexts/trigger/services/drive.ts";
import type { WorkflowLoadError } from "../contexts/workflow/models/WorkflowLoadError.ts";
import {
  type FactoryServices,
  type LoadedWorkflow,
  loadWorkflow,
  namesInFactory,
} from "../contexts/workflow/services/factoryWorkflows.ts";
import { failure, start, status } from "../contexts/workflow/services/run.ts";
import { type CommandFailed, commandFailed } from "./CommandFailed.ts";
import { hello } from "./hello.ts";
import { review } from "./review.ts";

/** What a workflow is started from on the command line. One optional word, and one switch. */
export interface RunRequest {
  readonly payload: string;
  /** `demo-hello` only. It is here rather than on the workflow because the parser owns the flags. */
  readonly fail: boolean;
}

/**
 * One workflow the CLI can run, with its generic parameters erased.
 *
 * `Workflow.Workflow<Tag, Payload, Success, Error>` differs in four type parameters per workflow, so
 * a list of them has nothing usable in common. What every command actually needs is four things
 * that do not vary: the layer that registers the body, a way to start it from a person's arguments,
 * a way to start it from a trigger's event, and a way to ask where it got to. The last two are
 * `Driven`, which the watcher holds a whole list of. Erasing here rather than casting at each call
 * site keeps the casts at zero.
 *
 * **The layer is what makes `kojo gate answer` able to resume anything.** Recording a verdict is a
 * write to the engine's storage and needs no body; *applying* it needs the runner in that process to
 * have the workflow registered. A CLI that answered without registering the workflow would record a
 * real verdict and leave the run exactly where it was.
 *
 * The layer's requirement is `FactoryServices` rather than the three ports a demo needs, because a
 * factory's own workflow is a real one: it enters a sandbox and it calls an agent.
 */
export interface Runnable extends Driven {
  readonly description: string;
  readonly layer: Layer.Layer<never, never, FactoryServices>;
  readonly start: (
    request: RunRequest,
  ) => Effect.Effect<RunId, CommandFailed, WorkflowEngine.WorkflowEngine>;
  /**
   * Why the run failed, when it did.
   *
   * Here rather than on `Driven`, because a watcher does not need it and the fakes that implement
   * `Driven` should not have to carry it. `kojo run` is the one caller: it reports one run to one
   * person, and *the reason* is the thing that run has to be able to say.
   */
  readonly failure: (
    runId: RunId,
  ) => Effect.Effect<Option.Option<Cause.Cause<unknown>>, never, WorkflowEngine.WorkflowEngine>;
}

const helloRunnable: Runnable = {
  name: "demo-hello",
  description: "Two code phases and a typed failure. Never waits on anybody.",
  layer: hello.layer,
  start: (request) =>
    start(hello.definition, { who: request.payload || "world", fail: request.fail }),
  driven: (event) => runFor(hello.definition, event),
  status: (runId) => status(hello.definition, runId),
  failure: (runId) => failure(hello.definition, runId),
};

const reviewRunnable: Runnable = {
  name: "demo-review",
  description: "Draft, ask a human, land. Suspends until somebody answers.",
  layer: review.layer,
  start: (request) => start(review.definition, { subject: request.payload || "the change" }),
  driven: (event) => runFor(review.definition, event),
  status: (runId) => status(review.definition, runId),
  failure: (runId) => failure(review.definition, runId),
};

/**
 * The workflows Kojo itself ships, and the reason they are all called `demo-something`.
 *
 * They are demonstrations of the engine, not products of a factory, and until this ticket they were
 * called `hello` and `review` — which is to say the second of them had the same name **and the same
 * idempotency key** as the `review` that `kojo init` stamps. In a stamped repository
 * `kojo run review "the change"` therefore ran two code phases, succeeded in milliseconds, called no
 * agent, entered no sandbox, and looked exactly like a working factory.
 *
 * **The fix is a rename, not a precedence rule**, and the difference is what the two guarantee. A
 * rule that says the factory wins leaves the collision in place and resolves it correctly wherever
 * the rule is applied; a prefix means no factory workflow can be shadowed in the first place,
 * because none of a factory's names can be one of these. The precedence in {@link resolve} is still
 * there — a factory may legitimately stamp a `demo-review` of its own — but it now decides between
 * two things a person deliberately named the same, rather than papering over one this build shipped.
 */
export const demos: ReadonlyArray<Runnable> = [helloRunnable, reviewRunnable];

/**
 * What a person may type, as one line.
 *
 * Pure, and separated from the directory reading below, because it is the sentence `--help` prints
 * and the sentence a refusal ends with, and those two must not be able to drift.
 */
export const describeChoices = (
  own: ReadonlyArray<string>,
  builtIn: ReadonlyArray<string>,
): string =>
  own.length === 0
    ? `no \`.kojo/workflows/\` here, so the built-in demos only: ${builtIn.join(", ")}`
    : `this factory: ${own.join(", ")}. Built-in demos: ${builtIn.join(", ")}`;

/** The same sentence, about the repository the command is being run in. */
export const choices = (root?: string): string =>
  describeChoices(
    namesInFactory(root),
    demos.map((runnable) => runnable.name),
  );

/**
 * The payload one typed word means to one workflow.
 *
 * **One field, filled from the positional argument.** `kojo run review "the auth bug"` is the whole
 * command line a stamped README teaches, and the workflows a factory stamps take exactly one string
 * — `subject`, `fault`. A workflow with a wider payload is not refused, it is *told where to go*:
 * the inbox carries a whole JSON payload, and `kojo watch` decodes it against this same schema.
 */
const payloadFor = (
  loaded: LoadedWorkflow,
  text: string,
): Effect.Effect<unknown, CommandFailed> => {
  const fields = Object.keys(loaded.definition.payloadSchema.fields);
  const only = fields[0];
  if (fields.length !== 1 || only === undefined) {
    return commandFailed(
      `\`${loaded.name}\` takes a payload of ${fields.length} fields (${fields.join(", ")}), and ` +
        "`kojo run` fills exactly one from the word you type. Drop a JSON event in the inbox and " +
        "run `kojo watch` instead, or give this workflow a single-field payload.",
    );
  }

  return decodeUnknown(loaded.definition.payloadSchema)({ [only]: text }).pipe(
    Effect.catch(() =>
      commandFailed(`\`${loaded.name}\` does not take "${text}" as its \`${only}\``),
    ),
  );
};

/** A loaded workflow as the command line sees it. */
const runnableFrom = (loaded: LoadedWorkflow): Runnable => ({
  name: loaded.name,
  description: `Your own workflow, from ${loaded.source}`,
  layer: loaded.layer,
  start: (request) =>
    Effect.flatMap(payloadFor(loaded, request.payload), (payload) =>
      start(loaded.definition, payload),
    ),
  driven: (event) => runFor(loaded.definition, event),
  status: (runId) => status(loaded.definition, runId),
  failure: (runId) => failure(loaded.definition, runId),
});

/** A load fault, said the way a person can act on it: the path, then what is wrong with it. */
const refused = (error: WorkflowLoadError): Effect.Effect<never, CommandFailed> =>
  commandFailed(error.describe);

const loadRunnable = (name: string, root?: string): Effect.Effect<Runnable, CommandFailed> =>
  loadWorkflow(name, { root }).pipe(Effect.map(runnableFrom), Effect.catch(refused));

/**
 * The workflow that name means **here**.
 *
 * **A factory's own workflow always wins.** The directory is consulted first, and a name it holds is
 * loaded from it — including when loading fails. There is no fallback to a built-in of the same
 * name, and that absence is the point: a fallback is precisely how `kojo run review` came to run a
 * demo in a repository that had a real `review` sitting in `.kojo/workflows/`.
 *
 * Nothing is imported to decide this. The listing is file names, the loader proves the module agrees
 * with its file name, so choosing costs one `readdir` and importing happens once, for the one
 * workflow that was chosen.
 */
export const resolve = (name: string, root?: string): Effect.Effect<Runnable, CommandFailed> => {
  if (namesInFactory(root).includes(name)) return loadRunnable(name, root);

  const demo = demos.find((runnable) => runnable.name === name);
  return demo === undefined
    ? commandFailed(`unknown workflow: ${name}. Known workflows — ${choices(root)}`)
    : Effect.succeed(demo);
};

/**
 * Every workflow this process can run here: the factory's own, then the demos it did not shadow.
 *
 * **What a long-lived process needs and a one-shot command does not.** `kojo run` and
 * `kojo gate answer` are each about one workflow and resolve that one. A watcher adopts runs it
 * never started — a suspended run from a previous instance may belong to any workflow — and applying
 * an answer needs the body in *this* process, so it loads them all. Which also means a watcher is
 * where a broken workflow file is found: one bad module refuses the whole watch, by path, at start.
 */
export const everything = (root?: string): Effect.Effect<ReadonlyArray<Runnable>, CommandFailed> =>
  Effect.gen(function* () {
    // Serial, so the first broken file is the one reported rather than whichever import settled
    // last, and in the listing's own order so two machines report the same one.
    const own = yield* Effect.forEach(namesInFactory(root), (name) => loadRunnable(name, root), {
      concurrency: 1,
    });
    const taken = new Set(own.map((runnable) => runnable.name));
    return [...own, ...demos.filter((runnable) => !taken.has(runnable.name))];
  });

/**
 * Every workflow body in one layer.
 *
 * Folded from the list rather than written out, so a workflow that reaches the list cannot be
 * forgotten here.
 */
export const bodiesOf = (
  runnables: ReadonlyArray<Runnable>,
): Layer.Layer<never, never, FactoryServices> =>
  runnables.reduce<Layer.Layer<never, never, FactoryServices>>(
    (all, runnable) => Layer.merge(all, runnable.layer),
    Layer.empty,
  );
