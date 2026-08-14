/**
 * Every decision `kojo doctor` makes, as pure functions of what was observed.
 *
 * The split is `detectPackageManager`'s, for the same reason and at ten times the size: the looking
 * needs a process spawner, a filesystem, a container daemon and a target repository, and the
 * *deciding* needs a record. So the deciding is here, graded by a table of cases, and `diagnose.ts`
 * holds the one effect that goes and looks.
 *
 * Two rules hold over everything below, and they are what make this command worth running:
 *
 * - **Nothing here guesses.** A question that cannot be answered comes back `skipped` with the flag
 *   that would answer it, never `ok`. Edge 6 is about a scaffolder that guesses a test command; a
 *   doctor that guesses a container runtime is the same mistake wearing the same disguise.
 * - **Every failure carries a remedy**, because `failed` takes one as an argument.
 */

import type { AgentSpend } from "../../agent/models/AgentSpend.ts";
import { describeSpend, spendVariable } from "../../agent/models/AgentSpend.ts";
import { factoryDirectory, workflowsDirectory } from "../../shared/models/FactoryLayout.ts";
import type { ResolvedPackage } from "../../shared/models/ResolvedPackage.ts";
import { describeSplit, identify } from "../../shared/models/ResolvedPackage.ts";
import type { Declared, EngineDependency } from "../models/EngineDependency.ts";
import {
  buildsAnImage,
  type FactoryChoices,
  type SandboxChoice,
  sandboxChoices,
} from "../models/FactoryChoices.ts";
import { type Finding, failed, ok, skipped } from "../models/Finding.ts";
import { firstInstall, toolchainFor } from "../models/PackageManager.ts";
import { isPlaceholder } from "../models/Placeholder.ts";
import { providerSource } from "../templates/starter.ts";

/** What running one command on the host came to. */
export interface Probed {
  /** False when the binary is not on the PATH at all — a different fault from a non-zero exit. */
  readonly ran: boolean;
  readonly exitCode: number;
  /** stdout when there is any, else stderr. Trimmed, and short enough to put on one line. */
  readonly output: string;
}

/** The last line of output, which is where a runtime puts the reason it said no. */
const lastLine = (output: string): string => {
  const lines = output.trim().split("\n");
  return (lines[lines.length - 1] ?? "").trim();
};

// --- what this process may spend ---------------------------------------------------------------

/**
 * Which spend mode this process is in — reported, never judged.
 *
 * `ok` in all three cases, and that is the deliberate reading: refusing to spend is not a fault of
 * the factory, and a `failed` here would make `kojo doctor` call a perfectly good factory unready
 * for having a guard switched on. What the line is *for* is that a person can see which mode they
 * are in before they wonder why their run stopped at its agent phase — which, before ticket 49, was
 * a question nothing on this machine could answer.
 *
 * The detail carries the way out, because there is no `remedy` on an `ok` finding and the reader
 * who needs this line most is the one whose runs are all being refused.
 */
export const spendFinding = (spend: AgentSpend): Finding =>
  ok(
    "spend",
    spend._tag === "Refuse"
      ? `${describeSpend(spend)}. Set ${spendVariable}=allow to make real calls`
      : describeSpend(spend),
  );

// --- the runtime -------------------------------------------------------------------------------

/**
 * The runtime this command is running on.
 *
 * Bun is not a preference. A workflow of a factory is a TypeScript file loaded at run time by
 * `loadWorkflow`, and the trace and the engine's storage are opened with `bun:sqlite` — an import
 * that is `ERR_UNSUPPORTED_ESM_URL_SCHEME` under Node. So a `kojo` on the wrong runtime does not
 * degrade, it dies at the first import, and it is worth one line to say so before anything else.
 */
export const runtimeFinding = (bun: string | undefined): Finding =>
  bun === undefined
    ? failed(
        "runtime",
        "not running under Bun",
        "Kojo loads `.kojo/workflows/*.ts` at run time and opens its database with `bun:sqlite`, " +
          "neither of which Node can do. Install Bun (https://bun.sh) and run `kojo` with it.",
      )
    : ok("runtime", `bun ${bun}`);

// --- the repository ----------------------------------------------------------------------------

/** What the target directory says about being a repository. */
export interface RepositoryEvidence {
  /** What `git --version` printed, or nothing when git could not be run at all. */
  readonly git: string | undefined;
  readonly insideWorkTree: boolean;
  /** The commit `HEAD` names, or nothing when nothing has been committed here yet. */
  readonly head: string | undefined;
}

/**
 * Whether a run could cut its branch here.
 *
 * **The branch is the durable state** (architecture.md §4): a `sandboxed` scope forks a branch from
 * `HEAD` before the first phase, so a repository with no git, or with no commit, is a factory whose
 * every run fails at the same place — after the layers are built, which is far enough in to look
 * like something else.
 */
export const repositoryFinding = (evidence: RepositoryEvidence): Finding => {
  if (evidence.git === undefined) {
    return failed(
      "repository",
      "`git` is not on the PATH",
      "Every run cuts a branch and reads the worktree with host git, whatever the sandbox is. " +
        "Install git.",
    );
  }
  if (!evidence.insideWorkTree) {
    return failed(
      "repository",
      "this directory is not inside a git work tree",
      "A run's branch has to fork from something. Run `git init` here, or run `kojo doctor " +
        "--root <the repository>`.",
    );
  }
  if (evidence.head === undefined) {
    return failed(
      "repository",
      "this repository has no commit yet, so `HEAD` names nothing",
      "Make one commit — `git add --all && git commit --message 'first'` — and a run will have " +
        "somewhere to fork its branch from.",
    );
  }
  return ok("repository", `${evidence.git}, HEAD ${evidence.head}`);
};

// --- the factory itself ------------------------------------------------------------------------

/** Which parts of a stamped factory are on disk. */
export interface FactoryEvidence {
  readonly directory: boolean;
  readonly config: boolean;
  readonly commands: boolean;
  readonly workflows: ReadonlyArray<string>;
}

/** `kojo init` stamps all four. Whichever is missing is named, and the answer is the same command. */
export const factoryFinding = (evidence: FactoryEvidence): Finding => {
  if (!evidence.directory) {
    return failed(
      "factory",
      `no \`${factoryDirectory}/\` here`,
      "There is no factory in this repository. Run `kojo init` to stamp one.",
    );
  }

  const missing = [
    ...(evidence.config ? [] : ["kojo.config.yaml"]),
    ...(evidence.commands ? [] : ["commands.ts"]),
    ...(evidence.workflows.length === 0 ? [`${workflowsDirectory}/ holds no workflow`] : []),
  ];

  return missing.length === 0
    ? ok(
        "factory",
        `${factoryDirectory}/ — ${evidence.workflows.length} workflow${
          evidence.workflows.length === 1 ? "" : "s"
        } (${evidence.workflows.join(", ")}), kojo.config.yaml, commands.ts`,
      )
    : failed(
        "factory",
        `${factoryDirectory}/ is missing ${missing.join(" and ")}`,
        "Run `kojo init` again. It creates what is missing and keeps every file you have edited.",
      );
};

// --- the two dependencies every stamped file imports ---------------------------------------------

/** What this repository resolves for the two packages, against what this engine resolves. */
export interface DependencyEvidence {
  /** What the `kojo` doing the looking is, and what it resolves. Absent when it cannot say. */
  readonly engine: EngineDependency | undefined;
  /** What `${factoryDirectory}/` resolves `kojo` to, or nothing when it resolves none. */
  readonly kojo: ResolvedPackage | undefined;
  /** What `${factoryDirectory}/` resolves `effect` to, or nothing when it resolves none. */
  readonly effect: ResolvedPackage | undefined;
  /** The manager whose install command a remedy tells a person to run. */
  readonly manager: Parameters<typeof firstInstall>[0];
}

/**
 * Whether this factory and this engine are holding the **same** `effect`, and the same `kojo`.
 *
 * **This is the check that was missing**, and the reason it is worth a whole subject of its own is
 * that everything downstream of it passes without it. A factory with two copies of `effect` loads
 * its commands, loads its workflows, and assembles its layers — `kojo doctor` called such a factory
 * ready — and then the first run dies with `TypeError: Cannot convert a symbol to a string` inside
 * the framework, pointing at a line of the person's own workflow that has nothing wrong with it.
 *
 * The comparison is on the **directory**, not the version, because that is what a module instance
 * is. Two directories holding byte-identical copies of one version are two `Schema` modules and
 * therefore two sets of symbol keys. The message names the version *and* the directory of each,
 * because the versions are usually equal and it is the paths that say what to do.
 */
export const dependencyFinding = (evidence: DependencyEvidence): Finding => {
  const subject = "dependencies";
  const install = firstInstall(evidence.manager);

  if (evidence.engine === undefined) {
    return skipped(
      subject,
      "this `kojo` cannot say where it is installed, so it has nothing to compare against",
    );
  }

  const here = { kojo: evidence.kojo, effect: evidence.effect };
  const missing = [
    ...(here.kojo === undefined ? ["kojo"] : []),
    ...(here.effect === undefined ? ["effect"] : []),
  ];
  if (here.kojo === undefined || here.effect === undefined) {
    return failed(
      subject,
      `${factoryDirectory}/ cannot resolve ${missing.join(" or ")}`,
      `Every file in ${factoryDirectory}/ imports both, so not one of them loads. \`kojo init\` ` +
        `declares them in package.json at the repository root — run \`${install}\`, and run ` +
        "`kojo init` again first if package.json does not name them.",
    );
  }

  // `effect` first: when both are wrong it is the one whose failure is unreadable.
  const pairs: ReadonlyArray<readonly [Declared, ResolvedPackage]> = [
    [evidence.engine.effect, here.effect],
    [evidence.engine.kojo, here.kojo],
  ];
  const split = pairs.find(([mine, theirs]) => mine.directory !== theirs.directory);

  if (split !== undefined) {
    const [mine, theirs] = split;
    return failed(
      subject,
      // The same sentence the loader refuses with, from the same function, so the two cannot drift.
      describeSplit({ mine, theirs }),
      mine.name === "effect"
        ? "Two copies of `effect` are two `Schema` modules, so the payload your workflow declares " +
            "and the payload the engine reads are different types. A run dies with `TypeError: " +
            "Cannot convert a symbol to a string` inside the framework. Declare " +
            `\`"effect": "${mine.specifier}"\` in package.json — the exact version this engine was ` +
            `built against — and run \`${install}\` so one copy serves both.`
        : "The factory would import a different engine from the one running this command, so its " +
            "ports are different services and no layer can satisfy them. Declare " +
            `\`"kojo": "${mine.specifier}"\` in package.json and run \`${install}\`.`,
    );
  }

  return ok(
    subject,
    `${identify(evidence.engine.kojo)} and ${evidence.engine.effect.name} ` +
      `${evidence.engine.effect.version} — one copy of each`,
  );
};

// --- the payload, actually built ------------------------------------------------------------------

/** The word a payload is built out of. Any word does; what is being proven is that it can be. */
export const payloadSample = "kojo doctor";

/** What building one workflow's payload came to. */
export type PayloadProbe =
  | { readonly _tag: "built"; readonly workflow: string; readonly key: string }
  | { readonly _tag: "refused"; readonly workflow: string; readonly reason: string }
  | {
      readonly _tag: "unfillable";
      readonly workflow: string;
      readonly fields: ReadonlyArray<string>;
    };

/**
 * The check that loading a workflow is not: **a payload, built and keyed.**
 *
 * `kojo doctor` loaded every workflow module and called that enough. It is not enough, and the gap
 * is exactly one import: a module that imports a second `effect` still *loads*, because importing
 * is all that loading does. The first thing that touches both schemas at once is
 * `Workflow.execute`, which makes the payload and hashes its idempotency key — and that is the line
 * the run died on. So this does the same two things, over the workflows this factory holds, with
 * nothing started and nothing written.
 *
 * A payload of more than one field is `unfillable` rather than failed, and says so: `kojo run`
 * declines the same shape for the same reason, and a workflow driven from the inbox is entitled to
 * a wider payload than one word can fill.
 */
export const payloadFinding = (probes: ReadonlyArray<PayloadProbe>): Finding => {
  const subject = "payload";
  if (probes.length === 0) {
    return skipped(subject, "no workflow loaded here, so there was no payload to build");
  }

  const refused = probes.filter((probe) => probe._tag === "refused");
  if (refused.length > 0) {
    return failed(
      subject,
      refused.map((probe) => `${probe.workflow}: ${probe.reason}`).join(" · "),
      "A payload that cannot be built is a run that cannot start. When the `dependencies` line " +
        "above names two copies of `effect`, that is the cause and this is the symptom — fix that " +
        "one. Otherwise the payload schema in the workflow named above is what refused.",
    );
  }

  const built = probes.filter((probe) => probe._tag === "built");
  if (built.length === 0) {
    return skipped(
      subject,
      probes
        .map(
          (probe) =>
            `${probe.workflow} takes ${
              probe._tag === "unfillable" ? probe.fields.length : 0
            } payload fields, and one word fills exactly one`,
        )
        .join(" · "),
    );
  }

  return ok(
    subject,
    `${built.map((probe) => probe.workflow).join(", ")} — built and keyed against this engine`,
  );
};

// --- which sandbox this factory runs in ---------------------------------------------------------

/** The one `FactoryChoices` field {@link providerSource} reads, with the rest filled in to compile. */
const asIfStamped = (sandbox: SandboxChoice): FactoryChoices => {
  const nothing: Declared = { name: "", specifier: "", version: "", directory: "" };
  return {
    agent: "pi",
    model: "",
    sandbox,
    template: "review",
    toolchain: toolchainFor("npm"),
    imageName: "",
    engine: { reach: "published", kojo: nothing, effect: nothing },
  };
};

/**
 * The symbol each provider is imported under, taken from the function that writes the import.
 *
 * **Not a second table.** `providerSource` is what `kojo init` stamps the import line with, so
 * asking it here means a provider renamed in one place is recognised here without a second edit.
 * A hand-written map of five names would be the same lie as a hand-written copy of a test command.
 */
export const providerSymbols: ReadonlyArray<readonly [string, SandboxChoice]> = sandboxChoices.map(
  (sandbox) => [providerSource(asIfStamped(sandbox)).symbol, sandbox] as const,
);

/**
 * Which providers a factory's workflows import.
 *
 * Read off the import line rather than off a key in `kojo.config.yaml`, and that is deliberate: the
 * provider **is** code — a provider is built per run because `CreateSandboxOptions` carries no
 * `env` — so the workflow is the only place the answer honestly lives. A YAML key naming a provider
 * would be a second statement of one fact, free to drift from the one that runs.
 *
 * It reads the import and not every mention of the word, so `docker` in a comment is not an answer.
 */
export const sandboxesNamed = (sources: ReadonlyArray<string>): ReadonlyArray<SandboxChoice> => {
  const pattern = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*sandbox\/adapters\/providers["']/g;
  const found = new Set<SandboxChoice>();

  for (const source of sources) {
    for (const match of source.matchAll(pattern)) {
      const imported = (match[1] ?? "")
        .split(",")
        .map((name) => (name.trim().split(/\s+/)[0] ?? "").trim());
      for (const [symbol, sandbox] of providerSymbols) {
        if (imported.includes(symbol)) found.add(sandbox);
      }
    }
  }

  return [...found];
};

/**
 * The one this doctor aims the container checks at.
 *
 * A container provider wins when a factory has more than one, because it is the only kind with
 * something on this machine that can be missing. `undefined` means nobody said, and everything
 * downstream of it skips rather than assuming.
 */
export const sandboxOf = (options: {
  readonly chosen?: SandboxChoice | undefined;
  readonly named: ReadonlyArray<SandboxChoice>;
}): SandboxChoice | undefined =>
  options.chosen ?? options.named.find(buildsAnImage) ?? options.named[0];

/** What the sandbox line says. It never fails: not knowing is a skip with the flag that fixes it. */
export const sandboxFinding = (options: {
  readonly chosen?: SandboxChoice | undefined;
  readonly named: ReadonlyArray<SandboxChoice>;
}): Finding => {
  if (options.chosen !== undefined) return ok("sandbox", `${options.chosen} — from --sandbox`);
  if (options.named.length === 0) {
    return skipped(
      "sandbox",
      `no workflow under ${factoryDirectory}/${workflowsDirectory}/ imports a sandbox provider, ` +
        "so the three checks below cannot be aimed. Pass --sandbox to aim them",
    );
  }
  const aimed = sandboxOf(options);
  return ok(
    "sandbox",
    options.named.length === 1
      ? `${aimed} — named by ${factoryDirectory}/${workflowsDirectory}/`
      : `${options.named.join(", ")} — checking ${aimed}, the one with an image`,
  );
};

/**
 * The image tag a workflow asks its provider for.
 *
 * `docker()` takes a default of its own, so a factory that names no tag is a factory whose image
 * this command cannot identify — which comes back as nothing, and reads downstream as a skip.
 */
export const imageNamed = (sources: ReadonlyArray<string>): string | undefined => {
  for (const source of sources) {
    const match = /imageName\s*:\s*["']([^"']+)["']/.exec(source);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
};

/** Which command line speaks to this provider. Both take `build`, `version`, `run` alike. */
export const containerCommand = (sandbox: SandboxChoice | undefined): "docker" | "podman" =>
  sandbox === "podman" ? "podman" : "docker";

/** The line the three container checks print when this factory has no container to check. */
export const noContainer = (subject: string, sandbox: SandboxChoice | undefined): Finding =>
  sandbox === undefined
    ? skipped(subject, "nothing said which sandbox this factory uses")
    : skipped(subject, `this factory runs with \`${sandbox}\`, which builds no image here`);

// --- the container runtime, the image, and the toolchain inside it -------------------------------

/** Is there a daemon to talk to? Not installed and not running are two different sentences. */
export const containerFinding = (options: {
  readonly command: "docker" | "podman";
  readonly probed: Probed;
}): Finding => {
  if (!options.probed.ran) {
    return failed(
      "container",
      `\`${options.command}\` could not be run: ${lastLine(options.probed.output)}`,
      `Every phase of this factory runs inside a container. Install ${options.command} and put it ` +
        "on the PATH, or re-stamp with `kojo init --sandbox none` to run the phases on this machine.",
    );
  }
  if (options.probed.exitCode !== 0) {
    return failed(
      "container",
      `\`${options.command} version\` exited ${options.probed.exitCode}: ${lastLine(options.probed.output)}`,
      `The client is installed and the daemon did not answer. Start it — \`colima start\`, ` +
        "`open -a Docker`, or `systemctl start docker` — and run this again.",
    );
  }
  return ok("container", `${options.command} server ${lastLine(options.probed.output)}`);
};

/** The `docker build …` line a person can paste. The same one `.kojo/README.md` carries. */
export const buildCommand = (command: string, image: string): string =>
  `${command} build --file ${factoryDirectory}/sandbox/Dockerfile --tag ${image} ` +
  `--build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) ${factoryDirectory}/sandbox`;

/** Is the image the workflow names actually on this machine? */
export const imageFinding = (options: {
  readonly command: "docker" | "podman";
  readonly image: string;
  readonly probed: Probed;
}): Finding =>
  options.probed.ran && options.probed.exitCode === 0
    ? // The probe asks for `{{.Id}}`, so what came back is `sha256:<64 hex>` — shortened here to
      // what a person recognises an image by, which is the same twelve characters `docker images`
      // prints.
      ok(
        "image",
        `${options.image} — ${lastLine(options.probed.output)
          .replace(/^sha256:/, "")
          .slice(0, 12)}`,
      )
    : failed(
        "image",
        `no image tagged ${options.image} on this machine`,
        `The workflow asks its provider for it by name, so a run fails at the first phase. ` +
          `Build it: \`${buildCommand(options.command, options.image)}\`.`,
      );

/**
 * Edge 7, measured rather than assumed.
 *
 * Code phases run **in the sandbox**, so `bun install` needs bun *there*. `kojo init` renders the
 * Dockerfile block and the `install` command from one `Toolchain` value so the two cannot be
 * stamped out of step — but both files belong to the person who owns the repository, and an edit to
 * one of them is exactly how the two come apart afterwards. This asks the image itself.
 */
export const toolchainFinding = (options: {
  readonly manager: string;
  readonly image: string;
  readonly probed: Probed;
}): Finding =>
  options.probed.ran && options.probed.exitCode === 0
    ? ok("toolchain", `${options.manager} is in ${options.image}`)
    : failed(
        "toolchain",
        `${options.image} carries no \`${options.manager}\`, and ${factoryDirectory}/commands.ts runs it`,
        `A code phase that calls a tool the image does not carry fails inside the container, ` +
          `minutes into a run and nowhere near the file that was wrong. Add it to ` +
          `${factoryDirectory}/sandbox/Dockerfile and rebuild, or change \`install\` in ` +
          `${factoryDirectory}/commands.ts.`,
      );

/** The binary a command line calls, which is its first word. */
export const binaryOf = (command: string): string | undefined =>
  command.trim().split(/\s+/)[0] || undefined;

// --- credentials -------------------------------------------------------------------------------

/**
 * Every variable a `.env` sets, in order.
 *
 * Commented lines are not settings — `kojo init` stamps `# ANTHROPIC_API_KEY=` under Claude Code's
 * OAuth token as the alternative a person may switch to, and reading that as an unfilled credential
 * would make a correctly filled factory fail forever.
 */
export const credentialsIn = (
  text: string,
): ReadonlyArray<{ readonly name: string; readonly value: string }> =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .flatMap((line) => {
      const at = line.indexOf("=");
      if (at <= 0) return [];
      return [{ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() }];
    });

/**
 * Whether the agent has a key to read.
 *
 * The names come out of the file rather than out of a table of agents, because the file is where
 * `kojo init` wrote the name the chosen agent actually reads — and because the person owns the file
 * and may have switched agents since. A variable already exported in the environment counts as
 * filled: that is how CI supplies one, and failing a CI job for an empty `.env` it never had would
 * be a check nobody could satisfy.
 */
export const credentialFinding = (options: {
  readonly present: boolean;
  readonly text: string;
  readonly exported: (name: string) => boolean;
}): Finding => {
  const file = `${factoryDirectory}/.env`;
  if (!options.present) {
    return failed(
      "credentials",
      `no ${file}`,
      `Write ${file} with the one variable your agent reads — CLAUDE_CODE_OAUTH_TOKEN for Claude ` +
        "Code, ANTHROPIC_API_KEY for the API — or export that variable in the environment this " +
        "factory runs in, which is how CI supplies one. Do not run `kojo init` again to get the " +
        "file: `init` keeps what you edited, but it also stamps the starter files a hand-written " +
        "factory deliberately does not have, and the extra workflow it adds fails the `workflows` " +
        "check.",
    );
  }

  const set = credentialsIn(options.text);
  if (set.length === 0) {
    return failed(
      "credentials",
      `${file} sets no variable`,
      "An agent phase authenticates with the key this file names. `kojo init` stamps the right " +
        "variable for the agent you chose — restore that line and fill it in.",
    );
  }

  const empty = set.filter((entry) => entry.value === "" && !options.exported(entry.name));
  return empty.length === 0
    ? ok("credentials", `${set.map((entry) => entry.name).join(", ")} — set`)
    : failed(
        "credentials",
        `${empty.map((entry) => entry.name).join(", ")} ${empty.length === 1 ? "is" : "are"} empty`,
        `Fill in the value in ${file}, or export it in the environment this factory runs in. ` +
          "Until then every agent phase fails on authentication, inside the container.",
      );
};

// --- the commands, and the placeholders among them -----------------------------------------------

/**
 * The survivors, read out of a target repository's own `commands.ts`.
 *
 * **One predicate, and this is it.** The module is asked for `survivingPlaceholders()` — which
 * `kojo init` stamps as a call to Kojo's own `isPlaceholder` — and when a person has deleted that
 * export the `commands` record is walked with the very same function. There is deliberately no
 * second definition of what a placeholder is: two of them would drift, and a half-edited command
 * would pass one and fail the other.
 *
 * Reading the file as text and asking `isPlaceholder` of the whole of it is the wrong answer, and
 * measurably so: the stamped file **names** the marker in its own doc comment, so a text scan would
 * report a fully finished factory as unfinished forever. A comment is not a command.
 */
export const survivorsIn = (module: unknown): ReadonlyArray<string> | undefined => {
  if (module === null || typeof module !== "object") return undefined;
  const exported = module as Record<string, unknown>;

  const asked = exported.survivingPlaceholders;
  if (typeof asked === "function") {
    const answer: unknown = (asked as () => unknown)();
    if (Array.isArray(answer)) return answer.map(String);
  }

  const commands = exported.commands;
  if (commands !== null && typeof commands === "object") {
    return Object.entries(commands as Record<string, unknown>)
      .filter(([, command]) => typeof command === "string" && isPlaceholder(command))
      .map(([name]) => name);
  }

  return undefined;
};

/** How reading `commands.ts` came out: it would not load, it is not one, or here are the survivors. */
export type CommandsRead =
  | { readonly _tag: "unreadable"; readonly reason: string }
  | { readonly _tag: "unrecognised" }
  | {
      readonly _tag: "read";
      readonly surviving: ReadonlyArray<string>;
      /**
       * The `install` entry, which is the one command that is knowledge rather than a guess — and
       * therefore the one whose binary the image has to carry. Absent when the file declares none.
       */
      readonly install?: string | undefined;
    };

/**
 * Edge 6's own criterion: a factory with a surviving placeholder is not ready.
 *
 * It is a failure and not a warning because a placeholder is *already* fatal to a run — it exits 78
 * and the mechanical half of the acceptance refuses — so anything softer here would disagree with
 * what the factory does.
 */
export const commandsFinding = (outcome: CommandsRead): Finding => {
  const file = `${factoryDirectory}/commands.ts`;
  switch (outcome._tag) {
    case "unreadable":
      return failed(
        "commands",
        `${file} could not be loaded: ${outcome.reason}`,
        "It imports `kojo`, so it needs this repository's dependencies installed. Run your " +
          "package manager's install, then run this again.",
      );
    case "unrecognised":
      return failed(
        "commands",
        `${file} exports neither \`commands\` nor \`survivingPlaceholders\``,
        "The workflows import `commands` from it, so a run cannot start. Restore the export, or " +
          "run `kojo init` in a scratch directory to see the shape it expects.",
      );
    case "read":
      return outcome.surviving.length === 0
        ? ok("commands", `every command in ${file} is real`)
        : failed(
            "commands",
            `${outcome.surviving.join(", ")} ${
              outcome.surviving.length === 1 ? "is still a placeholder" : "are still placeholders"
            }`,
            `A placeholder prints KOJO-PLACEHOLDER and exits 78 on purpose: a scaffolder cannot ` +
              `know how this repository runs its suite, and a guess that exits 0 would report a ` +
              `clean suite that never ran. Write the real commands in ${file}.`,
          );
  }
};

// --- the roster, the workflows, and the layers over them ------------------------------------------

/** The roster decoded and its prompt files read — which `YamlRoster` does while the layer builds. */
export const rosterFinding = (
  outcome: { readonly names: ReadonlyArray<string> } | { readonly reason: string },
): Finding =>
  "names" in outcome
    ? ok(
        "roster",
        outcome.names.length === 0
          ? `${factoryDirectory}/kojo.config.yaml names no agent`
          : `${outcome.names.length} agent${outcome.names.length === 1 ? "" : "s"} — ${outcome.names.join(", ")}, prompts read`,
      )
    : failed(
        "roster",
        outcome.reason,
        `Every agent in ${factoryDirectory}/kojo.config.yaml needs \`prompts/<name>/system.md\` ` +
          "and `prompts/<name>/user.md` beside it. Fix what the path above names.",
      );

/** Every workflow module imported and proven to be one, by path, with nothing spawned. */
export const workflowsFinding = (
  outcome: { readonly loaded: ReadonlyArray<string> } | { readonly reason: string },
): Finding =>
  "loaded" in outcome
    ? ok("workflows", `${outcome.loaded.join(", ")} — loaded`)
    : failed(
        "workflows",
        outcome.reason,
        "A workflow that does not load cannot be run or resumed. Fix the file the path above " +
          "names; `kojo run <name>` reports the same fault.",
      );

/**
 * The dry run: every layer built, and nothing started.
 *
 * This is the criterion "a dry run assembles every layer, decodes the config, validates the roster,
 * and stops before the first spawn" — and the *stops* is the load-bearing half. Building the layers
 * is what proves the engine, the gate store, the trace, the sandbox source and every workflow body
 * agree on their services; starting anything would be a run, and a diagnostic that starts runs is
 * not a diagnostic.
 */
export const layersFinding = (
  outcome: { readonly over: string } | { readonly reason: string },
): Finding =>
  "over" in outcome
    ? ok("layers", `assembled over ${outcome.over}, and nothing was started`)
    : failed(
        "layers",
        `the layers did not assemble: ${outcome.reason}`,
        "Nothing was started, so this is a fault in the factory rather than in a run. The message " +
          "above names the layer that refused.",
      );
