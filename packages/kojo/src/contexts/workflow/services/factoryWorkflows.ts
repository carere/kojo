import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Effect, Layer, type Schema } from "effect";
import type { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import type { AgentInvoker } from "../../agent/ports/AgentInvoker.ts";
import type { Gate } from "../../gate/ports/Gate.ts";
import type { GateRepository } from "../../gate/ports/GateRepository.ts";
import type { SandboxSource } from "../../sandbox/ports/SandboxSource.ts";
import {
  factoryDirectory,
  workflowExtension,
  workflowsDirectory,
} from "../../shared/models/FactoryLayout.ts";
import { describeSplit } from "../../shared/models/ResolvedPackage.ts";
import { splitEffect } from "../../shared/services/resolvePackage.ts";
import type { Tracer } from "../../trace/ports/Tracer.ts";
import { WorkflowLoadError } from "../models/WorkflowLoadError.ts";

/**
 * Everything a workflow body may ask this build for.
 *
 * A workflow loaded from a repository is typed as a program **there**, against the same engine this
 * process holds, so what it needs is what these six ports offer. Naming the set once is what lets
 * the boundary below be one documented cast rather than one per call site.
 *
 * `GateRepository` sits beside `Gate` because a gate settles as well as asks: the run itself writes
 * an expiry down where the queue reads, or an expired asking would wait in it forever.
 */
export type FactoryServices =
  | WorkflowEngine.WorkflowEngine
  | Tracer
  | Gate
  | GateRepository
  | SandboxSource
  | AgentInvoker;

/**
 * A workflow with its four type parameters erased.
 *
 * The parameters are gone because a dynamic import returns `unknown`: nothing about a file read at
 * run time is known to the compiler that typechecked this one. They are erased to `unknown` payload,
 * success and error **with no decoding services**, which is the honest reading — a workflow whose
 * schemas needed a service to decode could not be started by a CLI that has never heard of it — and
 * it is what keeps `start`, `status` and `runFor` usable here without a cast at each of them.
 */
type Erased = Schema.Codec<unknown, unknown, never, never>;
interface ErasedPayload extends Erased {
  readonly fields: Schema.Struct.Fields;
}
export type ErasedWorkflow = Workflow.Workflow<string, ErasedPayload, Erased, Erased>;

/** One workflow of a factory, loaded: where it came from, what it is called, and how to run it. */
export interface LoadedWorkflow {
  /** The file it came from. Absolute, so every message carrying it names something openable. */
  readonly source: string;
  /** What `kojo run` calls it — the workflow's own tag, proven equal to its file name. */
  readonly name: string;
  readonly definition: ErasedWorkflow;
  readonly layer: Layer.Layer<never, never, FactoryServices>;
}

/** The shape a workflow module exports: what `workflow()` returns, definition and body layer. */
interface WorkflowBundle {
  readonly definition: ErasedWorkflow;
  readonly layer: Layer.Layer<never, never, FactoryServices>;
}

/** Where this repository's own workflows live. Absolute; the root defaults to the process's own. */
export const workflowsIn = (root?: string): string =>
  join(root === undefined ? process.cwd() : resolve(root), factoryDirectory, workflowsDirectory);

/** The file one name means. The name is the file name — see `FactoryLayout`. */
export const sourceOf = (name: string, root?: string): string =>
  join(workflowsIn(root), `${name}${workflowExtension}`);

/**
 * The names this repository's factory offers, read straight off the directory.
 *
 * **Synchronous, and deliberately so.** It answers one question — what does `kojo run --help` list —
 * and the help text has to exist before the parser does, which is while the module graph is still
 * loading. Nothing is imported to answer it: the file name *is* the name, and {@link loadWorkflow}
 * refuses a module that disagrees, so a listing costs one `readdir` rather than the evaluation of
 * every workflow a factory has.
 *
 * It cannot fail. A repository with no `.kojo/workflows/` is not an error, it is a repository with
 * no factory — and `kojo run` still has its built-in demos to offer.
 */
export const namesInFactory = (root?: string): ReadonlyArray<string> => {
  try {
    return (
      readdirSync(workflowsIn(root), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(workflowExtension))
        .map((entry) => entry.name.slice(0, -workflowExtension.length))
        // A declaration file is the type of a module, never a module. It ends in `.ts` like
        // everything else here, so it has to be dropped by name or a factory grows a phantom
        // workflow the moment somebody generates one.
        .filter((name) => name !== "" && !name.endsWith(".d"))
        .sort()
    );
  } catch {
    return [];
  }
};

/**
 * Anything with properties on it.
 *
 * **A workflow definition is a `function`, not an object**, and that is not a detail anybody would
 * guess: `Workflow.make` builds `function Workflow() {}`, sets a prototype on it and assigns the
 * fields, so `typeof definition` is `"function"`. A predicate written the obvious way rejects every
 * real workflow ever written and reports the factory's own product as "not a workflow" — which is
 * measured, not imagined: it is what the first run of this loader did.
 */
const hasProperties = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === "object" || typeof value === "function");

/**
 * Is this value a workflow definition?
 *
 * Duck-typed, because the engine's own `TypeId` is module-private — `Workflow.ts` declares it
 * `const TypeId`, not `export const TypeId`, and there is no `isWorkflow` beside it. So the test is
 * the members this build actually calls on a definition, `payloadSchema.fields` included, because
 * that is what the command line fills from the word a person types. It is a guard against a module
 * that exports something else entirely, not a proof of provenance; the compiler already made that
 * proof on the target repository's side, and `stampedFactory.test.ts` grades it.
 */
const isDefinition = (value: unknown): value is ErasedWorkflow => {
  if (!hasProperties(value)) return false;
  return (
    typeof value.execute === "function" &&
    typeof value.poll === "function" &&
    typeof value.idempotencyKey === "function" &&
    typeof value._tag === "string" &&
    hasProperties(value.payloadSchema) &&
    hasProperties(value.payloadSchema.fields)
  );
};

const isBundle = (value: unknown): value is WorkflowBundle =>
  hasProperties(value) && isDefinition(value.definition) && Layer.isLayer(value.layer);

const refuse = (options: {
  readonly source: string;
  readonly fault: WorkflowLoadError["fault"];
  readonly reason: string;
  readonly cause?: unknown;
}): Effect.Effect<never, WorkflowLoadError> =>
  Effect.fail(
    new WorkflowLoadError({
      source: options.source,
      fault: options.fault,
      reason: options.reason,
      cause: options.cause,
    }),
  );

/**
 * One of a factory's own workflows, loaded and proven to be one.
 *
 * **Every refusal names a path, and every refusal happens before anything spawns.** That is the
 * standard `YamlRoster` already sets for `kojo.config.yaml`: a factory that cannot run says so while
 * it is being read. A loader that fell back to something else when a file was wrong would be the
 * defect this whole ticket exists to remove — a run that succeeds while running the wrong program.
 *
 * The import is the real one, under Bun, from the target repository's own file. The stamped module
 * resolves `kojo/...` through that repository's `node_modules`, which is a link to this package, so
 * the ports it names and the ports this process provides are the same keys.
 */
export const loadWorkflow = (
  name: string,
  options?: { readonly root?: string | undefined },
): Effect.Effect<LoadedWorkflow, WorkflowLoadError> =>
  Effect.gen(function* () {
    const directory = workflowsIn(options?.root);
    if (!existsSync(directory)) {
      return yield* refuse({
        source: directory,
        fault: "no-factory",
        reason: "no factory here — `kojo init` stamps one",
      });
    }

    const source = sourceOf(name, options?.root);
    if (!existsSync(source)) {
      const offered = namesInFactory(options?.root);
      return yield* refuse({
        source,
        fault: "missing",
        reason:
          offered.length === 0
            ? "this factory has no workflows in it"
            : `no such workflow. This factory has: ${offered.join(", ")}`,
      });
    }

    // **Before the import, because the import is what succeeds.** A workflow that resolves a second
    // copy of `effect` loads, and every schema it built is then a type the engine cannot read. The
    // first thing to touch both is `Workflow.execute`, minutes later and inside the framework, so
    // the fault is caught here instead — where a refusal names both copies and names this file.
    const split = splitEffect(directory);
    if (split !== undefined) {
      return yield* refuse({
        source,
        fault: "duplicated",
        reason:
          `${describeSplit(split)}. Two copies are two \`Schema\` modules, so this workflow's ` +
          "payload and the engine's reading of it are different types. This repository has to " +
          "declare the first of those two — `kojo doctor` prints the exact `package.json` line, " +
          "and `kojo init` writes it.",
      });
    }

    // An absolute path, always. A bare specifier would be resolved against *this* package rather
    // than against the repository the workflow lives in, which is how a loader ends up importing
    // its own demo and calling it the factory's.
    const specifier = isAbsolute(source) ? source : resolve(source);
    const module = yield* Effect.tryPromise({
      try: () => import(specifier) as Promise<Record<string, unknown>>,
      // The thrown value carries the whole of what went wrong — a specifier that does not resolve, a
      // `workflow()` that refused at module evaluation — and its message is what a person needs. It
      // is kept whole in `cause` as well, because a message is a summary of a stack.
      catch: (cause) =>
        new WorkflowLoadError({
          source,
          fault: "unloadable",
          reason: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    const bundles = Object.entries(module).filter((entry): entry is [string, WorkflowBundle] =>
      isBundle(entry[1]),
    );
    if (bundles.length === 0) {
      return yield* refuse({
        source,
        fault: "malformed",
        reason:
          "nothing here is a workflow. A workflow module exports what `workflow(...)` returns — " +
          "for example `export const review = workflow({ … }, …)`",
      });
    }
    if (bundles.length > 1) {
      return yield* refuse({
        source,
        fault: "malformed",
        reason: `two or more workflows in one file (${bundles
          .map(([exported]) => exported)
          .join(", ")}). One file is one \`kojo run\` name`,
      });
    }

    const bundle = bundles[0]?.[1] as WorkflowBundle;
    if (bundle.definition._tag !== name) {
      return yield* refuse({
        source,
        fault: "misnamed",
        reason: `this file declares the workflow \`${bundle.definition._tag}\`. The file name is the run name, so rename one of the two`,
      });
    }

    return { source, name, definition: bundle.definition, layer: bundle.layer };
  });
