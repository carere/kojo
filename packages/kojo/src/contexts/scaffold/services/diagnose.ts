import { Cause, Effect, FileSystem, Path, Result, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as YamlRoster from "../../agent/adapters/YamlRoster.ts";
import { invisibleChecks } from "../../agent/guards/invisibleChecks.ts";
import { spendFrom, spendVariable } from "../../agent/models/AgentSpend.ts";
import { Roster } from "../../agent/ports/Roster.ts";
import { decodeUnknown } from "../../shared/lib/decode.ts";
import {
  enginePackage,
  factoryDirectory,
  workflowExtension,
  workflowsDirectory,
} from "../../shared/models/FactoryLayout.ts";
import { installedPackage } from "../../shared/services/resolvePackage.ts";
import type { LoadedWorkflow } from "../../workflow/services/factoryWorkflows.ts";
import { loadWorkflow, namesInFactory } from "../../workflow/services/factoryWorkflows.ts";
import { buildsAnImage, type SandboxChoice } from "../models/FactoryChoices.ts";
import { type Finding, skipped } from "../models/Finding.ts";
import { detectPackageManager } from "./detectPackageManager.ts";
import {
  binaryOf,
  type CommandsRead,
  commandsFinding,
  containerCommand,
  containerFinding,
  credentialFinding,
  dependencyFinding,
  type EnvelopesRead,
  envelopeContractFinding,
  factoryFinding,
  imageFinding,
  imageNamed,
  noContainer,
  type PayloadProbe,
  type Probed,
  payloadFinding,
  payloadSample,
  repositoryFinding,
  rosterFinding,
  runtimeFinding,
  sandboxesNamed,
  sandboxFinding,
  sandboxOf,
  spendFinding,
  survivorsIn,
  toolchainFinding,
  workflowsFinding,
} from "./readiness.ts";
import { engineDependency } from "./resolveEngine.ts";

/** Everything the checks below need to look at something. */
export type Examiner = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

/** What one examination came to. */
export interface Examination {
  /** The repository that was looked at, absolute. */
  readonly root: string;
  /** In the order they were looked at, which is the order a person reads them. */
  readonly findings: ReadonlyArray<Finding>;
  /**
   * Whether every workflow module loaded.
   *
   * The dry run is assembled over the workflow bodies, so it is only honest to attempt it when the
   * bodies exist. `kojo doctor` reads this and skips rather than reporting a second failure about
   * the first one.
   */
  readonly loadable: boolean;
}

/**
 * Run one command on the host and keep what it said.
 *
 * `ran: false` is not the same answer as a non-zero exit, and the two are kept apart all the way to
 * the findings: *docker is not installed* and *the daemon is not running* have different remedies,
 * and a doctor that printed one sentence for both would send half its readers to the wrong place.
 */
const probe = (argv: ReadonlyArray<string>): Effect.Effect<Probed, never, Examiner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [head, ...rest] = argv;
    const handle = yield* spawner.spawn(ChildProcess.make(head ?? "", rest, { extendEnv: true }));

    // Both pipes at once, for the reason `DockerImageBuilder` gives: a child that fills the pipe
    // nobody is reading blocks forever.
    const [stdout, stderr] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      ],
      { concurrency: 2 },
    );
    const exitCode = yield* handle.exitCode;

    return {
      ran: true,
      exitCode,
      output: (stdout.trim() === "" ? stderr : stdout).trim(),
    };
  }).pipe(
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.succeed<Probed>({ ran: false, exitCode: -1, output: describeCause(cause) }),
    ),
  );

/** One line out of whatever went wrong, because a probe's failure is printed beside its subject. */
const describeCause = (cause: Cause.Cause<unknown>): string => {
  const message = String(Cause.squash(cause));
  return (message.split("\n").find((line) => line.trim() !== "") ?? message).trim();
};

/** What a probe said on its last line, or nothing when it said nothing useful. */
const spoke = (probed: Probed): string | undefined =>
  probed.ran && probed.exitCode === 0 && probed.output !== "" ? probed.output : undefined;

/**
 * The subjects that have nothing to say when there is no factory to look at.
 *
 * Skipped rather than failed, and in the order they would have been looked at, because a repository
 * nobody has stamped has **one** thing wrong with it. Eight failures all saying `run kojo init`
 * would bury the one line that matters under seven repetitions of it.
 */
const remaining = [
  "dependencies",
  "commands",
  "credentials",
  "roster",
  "workflows",
  "payload",
  "sandbox",
  "container",
  "image",
  "toolchain",
] as const;

/**
 * Look at this repository and decide whether its factory can run.
 *
 * **It never fails.** Every fault is a finding, because a doctor that gives up at the first problem
 * reports one thing wrong with a factory that has four — and the person then runs it four times.
 * The command's exit code comes from the findings, not from this effect.
 *
 * Nothing here writes: no database is opened, no file is created, no run is started. The one thing
 * it executes is a container that prints where a binary is, which is edge 7 and cannot be answered
 * any other way.
 */
export const diagnose = (options: {
  readonly root: string;
  /** Overrides what the workflows say about where this factory runs. */
  readonly sandbox?: SandboxChoice | undefined;
  /** Overrides the image tag read out of the workflows. */
  readonly image?: string | undefined;
}): Effect.Effect<Examination, never, Examiner> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(options.root);
    const at = (...parts: ReadonlyArray<string>) => path.join(root, factoryDirectory, ...parts);

    const exists = (target: string) =>
      fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
    const read = (target: string) =>
      fileSystem.readFileString(target).pipe(Effect.orElseSucceed(() => undefined));

    // --- the host ------------------------------------------------------------------------------
    // `spend` sits with the runtime rather than with the factory, and is reported even when there
    // is no factory here at all: it is a fact about *this process*, and the person who most needs
    // to read it is the one whose agent phase is being refused for a reason no file explains.
    const findings: Array<Finding> = [
      runtimeFinding(process.versions.bun),
      spendFinding(
        spendFrom({
          declared: process.env[spendVariable],
          attended: process.stdin.isTTY === true,
        }),
      ),
    ];

    const git = yield* probe(["git", "--version"]);
    const insideWorkTree = yield* probe(["git", "-C", root, "rev-parse", "--is-inside-work-tree"]);
    const head = yield* probe(["git", "-C", root, "rev-parse", "--short", "HEAD"]);
    findings.push(
      repositoryFinding({
        git: spoke(git),
        insideWorkTree: spoke(insideWorkTree) === "true",
        head: spoke(head),
      }),
    );

    // --- the factory on disk -------------------------------------------------------------------
    const directory = yield* exists(at());
    const workflows = namesInFactory(root);
    findings.push(
      factoryFinding({
        directory,
        config: yield* exists(at("kojo.config.yaml")),
        commands: yield* exists(at("commands.ts")),
        workflows,
      }),
    );

    if (!directory) {
      return {
        root,
        // True even with no factory here, and deliberately: there is nothing of this repository's
        // to assemble, and the dry run over the built-in demos still proves that the engine, the
        // askings, the trace and the sandbox source build on *this* machine. That is a real answer
        // to give somebody whose `kojo init` has not happened yet.
        loadable: true,
        findings: [
          ...findings,
          ...remaining.map((subject) =>
            skipped(subject, `there is no ${factoryDirectory}/ here to look at`),
          ),
        ],
      };
    }

    // --- the two dependencies every stamped file imports ---------------------------------------
    // Before the commands, because a factory that resolves the wrong `effect` loads its commands
    // and its workflows perfectly well, and then fails at the first payload. This is the line that
    // names the cause; every line under it would otherwise name a symptom or say nothing at all.
    const engine = yield* Effect.sync(engineDependency);
    const toolchain = yield* detectPackageManager(root);
    const dependencies = dependencyFinding({
      engine,
      kojo: installedPackage(at(), enginePackage),
      effect: installedPackage(at(), "effect"),
      manager: toolchain.manager,
    });
    findings.push(dependencies);

    // Two copies of one package is a fault that makes every answer below it meaningless rather than
    // merely worse — the modules load, and what they build cannot be used. Reported once, and the
    // checks that would repeat it in weaker words are skipped, which is the rule the container
    // checks already follow.
    const split = dependencies.standing === "failed";
    const because = `the \`dependencies\` line above says why, and it is the same fault`;

    // --- the commands, and the placeholders among them -----------------------------------------
    const commands = split
      ? ({ _tag: "unreadable", reason: because } as const)
      : yield* readCommands(at("commands.ts"));
    findings.push(
      split
        ? skipped("commands", `nothing imported ${factoryDirectory}/commands.ts — ${because}`)
        : commandsFinding(commands),
    );

    // --- credentials ---------------------------------------------------------------------------
    const environment = yield* read(at(".env"));
    findings.push(
      credentialFinding({
        present: environment !== undefined,
        text: environment ?? "",
        exported: (name) => (process.env[name] ?? "") !== "",
      }),
    );

    // --- the rules the agent is never shown ----------------------------------------------------
    // Ticket 58. After the commands and before the roster, because it is a question about the
    // *factory's own files* rather than about this machine, and it is answered by importing one of
    // them exactly as the commands check does.
    findings.push(
      envelopeContractFinding(
        split ? { _tag: "unreadable", reason: because } : yield* readEnvelopes(at("envelopes.ts")),
      ),
    );

    // --- the roster, decoded and its prompts read ----------------------------------------------
    // Exactly what a run does: `YamlRoster` is a layer that fails while it is being built, so this
    // is the same decode and the same prompt reads, with nothing built on top of them.
    const roster = yield* Effect.map(Roster, (loaded) => ({ names: loaded.names })).pipe(
      Effect.provide(YamlRoster.layer({ config: at("kojo.config.yaml") })),
      Effect.result,
    );
    findings.push(
      rosterFinding(
        Result.isSuccess(roster)
          ? roster.success
          : { reason: `${roster.failure.source}: ${roster.failure.reason}` },
      ),
    );

    // --- the workflows -------------------------------------------------------------------------
    // Serial, so the first broken file is the one reported rather than whichever import settled
    // last — the same reason `everything` gives.
    const loaded = split
      ? undefined
      : yield* Effect.forEach(workflows, (name) => loadWorkflow(name, { root }), {
          concurrency: 1,
        }).pipe(Effect.result);
    findings.push(
      loaded === undefined
        ? skipped("workflows", `no workflow module was imported — ${because}`)
        : workflowsFinding(
            Result.isSuccess(loaded)
              ? { loaded: loaded.success.map((workflow) => workflow.name) }
              : { reason: loaded.failure.describe },
          ),
    );

    // --- a payload, built ------------------------------------------------------------------------
    findings.push(
      loaded === undefined
        ? skipped("payload", `nothing was loaded to build a payload from — ${because}`)
        : Result.isSuccess(loaded)
          ? payloadFinding(yield* Effect.forEach(loaded.success, probePayload))
          : skipped("payload", "a workflow did not load, so there was nothing to build one from"),
    );

    // --- where the work runs -------------------------------------------------------------------
    const sources = yield* Effect.forEach(workflows, (name) =>
      read(path.join(at(workflowsDirectory), `${name}${workflowExtension}`)),
    );
    const present = sources.filter((source): source is string => source !== undefined);

    const named = sandboxesNamed(present);
    findings.push(sandboxFinding({ chosen: options.sandbox, named }));

    const sandbox = sandboxOf({ chosen: options.sandbox, named });
    findings.push(
      ...(yield* container({
        sandbox,
        image: options.image ?? imageNamed(present),
        install: commands._tag === "read" ? commands.install : undefined,
      })),
    );

    return { root, findings, loadable: loaded !== undefined && Result.isSuccess(loaded) };
  });

/**
 * One workflow's payload, built and keyed — which is what `Workflow.execute` does first.
 *
 * Three steps, and each of them is a step a real run takes before anything spawns: `kojo run`
 * decodes the word a person typed against the payload schema, `execute` calls `make` on the result,
 * and the engine hashes `idempotencyKey(payload)` into the run id. The third is the line the
 * reported failure died on.
 *
 * `Effect.suspend` and `Effect.try` are not decoration here. A `Schema` from another copy of
 * `effect` makes the *parser* throw while it is being built, before any effect is running, and the
 * user's own `idempotencyKey` throws when it interpolates a value that turned into a symbol. Both
 * are defects rather than failures, so the whole attempt is caught by its cause.
 */
const probePayload = (loaded: LoadedWorkflow): Effect.Effect<PayloadProbe> => {
  const schema = loaded.definition.payloadSchema;
  const fields = Object.keys(schema.fields);
  const only = fields[0];
  if (fields.length !== 1 || only === undefined) {
    return Effect.succeed({ _tag: "unfillable", workflow: loaded.name, fields });
  }

  return Effect.suspend(() => decodeUnknown(schema)({ [only]: payloadSample })).pipe(
    Effect.flatMap((decoded) => Effect.try(() => schema.make(decoded))),
    Effect.flatMap((payload) => Effect.try(() => loaded.definition.idempotencyKey(payload))),
    Effect.map(
      (key): PayloadProbe =>
        typeof key === "string"
          ? { _tag: "built", workflow: loaded.name, key }
          : {
              _tag: "refused",
              workflow: loaded.name,
              reason: `its idempotency key came back as a ${typeof key}, not a string`,
            },
    ),
    Effect.catchCause((cause) =>
      Effect.succeed<PayloadProbe>({
        _tag: "refused",
        workflow: loaded.name,
        reason: onOneLine(Cause.squash(cause)),
      }),
    ),
  );
};

/**
 * Whatever refused, on one line and whole.
 *
 * Not `describeCause`, which keeps the first line. A `SchemaError` puts the expectation on one line
 * and what it got on the next, and half of that reads as an unfinished sentence — `SchemaError(
 * Expected number` — which is exactly the kind of message a person cannot act on.
 */
const onOneLine = (failure: unknown): string =>
  String(failure)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ")
    .slice(0, 300);

/**
 * The three checks about the container: the runtime, the image, and the toolchain inside it.
 *
 * Each one depends on the one before it having answered — there is no point inspecting an image on
 * a machine with no daemon, and no point running a container from an image that is not there — so a
 * check whose predecessor failed comes back `skipped` rather than failing a second time about the
 * same fact.
 */
const container = (options: {
  readonly sandbox: SandboxChoice | undefined;
  readonly image: string | undefined;
  readonly install: string | undefined;
}): Effect.Effect<ReadonlyArray<Finding>, never, Examiner> =>
  Effect.gen(function* () {
    if (options.sandbox === undefined || !buildsAnImage(options.sandbox)) {
      return [
        noContainer("container", options.sandbox),
        noContainer("image", options.sandbox),
        noContainer("toolchain", options.sandbox),
      ];
    }

    const command = containerCommand(options.sandbox);
    const daemon = containerFinding({
      command,
      probed: yield* probe([command, "version", "--format", "{{.Server.Version}}"]),
    });
    if (daemon.standing !== "ok") {
      return [
        daemon,
        skipped("image", `nothing asked ${command}, because it did not answer`),
        skipped("toolchain", `nothing asked ${command}, because it did not answer`),
      ];
    }

    if (options.image === undefined) {
      return [
        daemon,
        skipped(
          "image",
          `no workflow here names an image — \`${command}()\` was called with none. Pass --image to check one`,
        ),
        skipped("toolchain", "no image was identified, so nothing was run in one"),
      ];
    }

    const image = imageFinding({
      command,
      image: options.image,
      probed: yield* probe([command, "image", "inspect", "--format", "{{.Id}}", options.image]),
    });
    if (image.standing !== "ok") {
      return [daemon, image, skipped("toolchain", "there is no image to run the toolchain in")];
    }

    const manager = options.install === undefined ? undefined : binaryOf(options.install);
    if (manager === undefined) {
      return [
        daemon,
        image,
        skipped("toolchain", `${factoryDirectory}/commands.ts declares no \`install\` to check`),
      ];
    }

    // Edge 7, asked of the image itself. `--entrypoint` is not optional: the stamped Dockerfile
    // ends in `ENTRYPOINT ["sleep", "infinity"]`, because Sandcastle execs into a container that has
    // to still be alive — so a bare `run` here would sleep forever instead of answering.
    return [
      daemon,
      image,
      toolchainFinding({
        manager,
        image: options.image,
        probed: yield* probe([
          command,
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          options.image,
          "-c",
          `command -v ${manager}`,
        ]),
      }),
    ];
  });

/**
 * A target repository's own `commands.ts`, imported.
 *
 * The real import, from the real file, under Bun — the same one `loadWorkflow` performs on a
 * workflow, and for the same reason: the question is what that module *exports*, and nothing that
 * reads it as text can answer that. See `survivorsIn` for why a text scan is not merely weaker here
 * but actively wrong.
 */
const readCommands = (source: string): Effect.Effect<CommandsRead, never, Examiner> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const there = yield* fileSystem.exists(source).pipe(Effect.orElseSucceed(() => false));
    if (!there) return { _tag: "unreadable", reason: "no such file" } as const;

    const module = yield* Effect.tryPromise({
      try: () => import(source) as Promise<unknown>,
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.result);

    if (Result.isFailure(module)) {
      return { _tag: "unreadable", reason: module.failure } as const;
    }

    const surviving = survivorsIn(module.success);
    if (surviving === undefined) return { _tag: "unrecognised" } as const;

    return { _tag: "read", surviving, install: installOf(module.success) } as const;
  });

/**
 * A target repository's own `envelopes.ts`, imported, and every schema it exports weighed against
 * what the rendered contract shows — ticket 58.
 *
 * Imported rather than parsed, for the reason `readCommands` is: the question is what the *module*
 * exports, and a factory that cannot be imported is a factory that cannot run either. Every export
 * that is a schema is graded and everything else is ignored — an author's helper function beside
 * their envelopes is not a fault.
 */
const readEnvelopes = (source: string): Effect.Effect<EnvelopesRead, never, Examiner> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const there = yield* fileSystem.exists(source).pipe(Effect.orElseSucceed(() => false));
    if (!there) return { _tag: "none" } as const;

    const module = yield* Effect.tryPromise({
      try: () => import(source) as Promise<unknown>,
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.result);

    if (Result.isFailure(module)) {
      return { _tag: "unreadable", reason: module.failure } as const;
    }
    if (module.success === null || typeof module.success !== "object") {
      return { _tag: "read", envelopes: [] } as const;
    }

    const envelopes = Object.entries(module.success as Record<string, unknown>)
      .filter(([, value]) => Schema.isSchema(value as never))
      .map(([name, value]) => ({ name, invisible: invisibleChecks(value as never) }));

    return { _tag: "read", envelopes } as const;
  });

/** The `install` entry of a loaded `commands.ts`, which names the binary the image must carry. */
const installOf = (module: unknown): string | undefined => {
  if (module === null || typeof module !== "object") return undefined;
  const commands = (module as Record<string, unknown>).commands;
  if (commands === null || typeof commands !== "object") return undefined;
  const install = (commands as Record<string, unknown>).install;
  return typeof install === "string" ? install : undefined;
};
