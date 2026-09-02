import { Console, Effect, Option } from "effect";
import { Command, Flag, Prompt } from "effect/unstable/cli";
import { commandFailed } from "../../../cli/CommandFailed.ts";
import type { Declared } from "../models/EngineDependency.ts";
import {
  agentInstalls,
  agentNames,
  agentSpellings,
  canonicalAgent,
  sandboxChoices,
  templateNames,
} from "../models/FactoryChoices.ts";
import { firstInstall, packageManagers } from "../models/PackageManager.ts";
import type { IgnoreReport } from "../services/ignoreInstall.ts";
import { installArtifacts } from "../services/ignoreInstall.ts";
import { initialise } from "../services/initialise.ts";
import type { ManifestReport } from "../services/manifest.ts";
import { starters } from "../services/plan.ts";
import { engineDependency } from "../services/resolveEngine.ts";

/**
 * The four answers, as flags that prompt when they are absent.
 *
 * **This is the whole of "asks, and can be driven non-interactively".** `Flag.withFallbackPrompt`
 * turns a missing required flag into a prompt, so `kojo init` alone is a conversation and
 * `kojo init --agent pi --model X --sandbox docker --template review` never opens one. The two
 * behaviours are one declaration rather than an `--interactive` switch and two code paths, which
 * is what stops the non-interactive path from being the one nobody exercises.
 *
 * `--wizard` is the framework's and needs nothing here: it builds the whole argv interactively.
 */
const agent = Flag.choice("agent", agentSpellings).pipe(
  Flag.withDescription(
    "Which coding agent's CLI the image installs, and whose credential .env asks for " +
      "(`claude` is accepted for `claude-code`)",
  ),
  Flag.withFallbackPrompt(
    Prompt.select({
      message: "Which agent runs the judgement calls?",
      choices: agentNames.map((name) => ({
        title: name,
        value: name,
        description: `default model ${agentInstalls[name].defaultModel}`,
      })),
    }),
  ),
);

const model = Flag.string("model").pipe(
  Flag.withDescription("The model every agent in the stamped roster is given"),
  Flag.withFallbackPrompt(
    Prompt.text({ message: "Which model? (you can change it per agent in kojo.config.yaml)" }),
  ),
);

const sandbox = Flag.choice("sandbox", sandboxChoices).pipe(
  Flag.withDescription("Where the work runs. Init writes, but does not build, a container image"),
  Flag.withFallbackPrompt(
    Prompt.select({
      message: "Where does the work run?",
      choices: [
        { title: "docker", value: "docker" as const, description: "a container; build it later" },
        { title: "podman", value: "podman" as const, description: "a container; build it later" },
        { title: "vercel", value: "vercel" as const, description: "isolated; no local image" },
        { title: "daytona", value: "daytona" as const, description: "isolated; no local image" },
        {
          title: "none",
          value: "none" as const,
          description: "on this machine, still on a branch",
        },
      ],
    }),
  ),
);

const template = Flag.choice("template", templateNames).pipe(
  Flag.withDescription("Which starter factory to stamp"),
  Flag.withFallbackPrompt(
    Prompt.select({
      message: "Which starter factory?",
      choices: templateNames.map((name) => ({
        title: name,
        value: name,
        description: starters[name].summary,
      })),
    }),
  ),
);

/** One line per file, so a second run reads as "kept everything" rather than as silence. */
const describe = (outcome: "created" | "kept", path: string): string =>
  `${outcome === "created" ? "created" : "kept   "}  ${path}`;

/** `@carere/kojo-runtime@0.0.0, effect@4.0.0-beta.106` — the entries, as one line. */
const listing = (declared: ReadonlyArray<Declared>): string =>
  declared.map((entry) => `${entry.name}@${entry.specifier}`).join(", ");

/**
 * What became of `package.json`, said in full.
 *
 * A mismatch is printed loudly and is **not** silently corrected. This repository's own pin wins,
 * because it is this repository's, and because a scaffolder that re-pinned `effect` under somebody
 * would be the defect this ticket exists to remove wearing the opposite coat. What a person gets
 * instead is the two versions, side by side, and `kojo doctor` refusing the factory until they
 * agree.
 */
const manifestLines = (report: ManifestReport): ReadonlyArray<string> => [
  ...(report.outcome === "created"
    ? [`created  ${report.path} — declaring ${listing(report.added)}`]
    : report.outcome === "updated"
      ? [`updated  ${report.path} — added ${listing(report.added)}`]
      : report.outcome === "kept"
        ? [`kept     ${report.path} — it already declares what this factory imports`]
        : [`WARNING  ${report.path} is not a JSON object, so nothing was declared in it`]),
  ...report.mismatched.map(
    (entry) =>
      `WARNING  ${report.path} declares ${entry.name}@${entry.declared}; this engine was built ` +
      `against ${entry.wanted}. Yours was left in place — \`kojo doctor\` will refuse the factory ` +
      "until the two agree.",
  ),
];

/**
 * What became of the repository's `.gitignore` — the file that keeps step 1 below off the trunk.
 *
 * Without it, the install this command instructs leaves `node_modules/` untracked, and the first
 * approved run refuses its merge with `main holds uncommitted changes` — over the very directory
 * this command told the person to create. An existing file is never rewritten: the missing entries
 * are appended as one commented block, and a file that already covers them is kept as it is.
 */
const ignoreLine = (report: IgnoreReport): string =>
  report.outcome === "created"
    ? `created  ${report.path} — ignoring ${report.added.join(", ")}, which step 1 below creates`
    : report.outcome === "updated"
      ? `updated  ${report.path} — appended ${report.added.join(", ")}, which step 1 below ` +
        "creates; every line you had is untouched"
      : `kept     ${report.path} — it already covers ${installArtifacts.join(", ")}`;

/**
 * Stamp a factory into a repository and build the image its phases run in.
 *
 * **No engine source is copied.** Everything written is either a declaration the target owns or a
 * program the target owns that imports Kojo, so upgrading the engine is a version bump and never a
 * re-stamp. That is the one place this differs from SSSF, and the reason is that a stamped
 * dependency in TypeScript is drift you cannot upgrade away from.
 *
 * **Nothing is ever overwritten.** Run it twice and the second run creates what is missing and
 * keeps what is there, file by file. There is no `--force`, because the thing a `--force` would
 * destroy is the workflow — the product.
 */
export const init = Command.make(
  "init",
  {
    agent,
    model,
    sandbox,
    template,
    path: Flag.directory("path", { mustExist: true }).pipe(
      Flag.withDescription("The repository to stamp a factory into"),
      Flag.withDefault("."),
    ),
    packageManager: Flag.choice("package-manager", packageManagers).pipe(
      Flag.withDescription("Override what the lockfile says this repository is built with"),
      Flag.optional,
    ),
    image: Flag.string("image").pipe(
      Flag.withDescription("Override the image tag derived from the repository's directory name"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ agent, model, sandbox, template, path, packageManager, image }) {
    // Asked of this process before anything is written, because it is the one answer a stamped
    // factory cannot work out for itself: which `kojo`, and which `effect`, the files about to be
    // written must resolve to. No ordinary install can fail to answer it.
    const engine = yield* Effect.sync(engineDependency);
    if (engine === undefined) {
      return yield* commandFailed(
        "this `kojo` cannot say where it is installed, so it cannot declare itself as a " +
          "dependency of your repository. Reinstall Kojo and run this again.",
      );
    }

    const factory = yield* initialise({
      root: path,
      engine,
      agent: canonicalAgent(agent),
      model,
      sandbox,
      template,
      packageManager: Option.getOrUndefined(packageManager),
      imageName: Option.getOrUndefined(image),
    }).pipe(
      Effect.catchTag("ScaffoldError", (error) =>
        commandFailed(`${error.operation} ${error.target}: ${error.reason}`),
      ),
    );

    // The manifest first, because it is what the lines under it depend on. The `.gitignore` beside
    // it, because those two are what this command *edits* outside `.kojo/` — the skill under
    // `.claude/skills/kojo/` is written whole, so it reports as a stamped file like any other.
    for (const line of manifestLines(factory.manifest)) {
      yield* Console.log(line);
    }
    yield* Console.log(ignoreLine(factory.ignore));
    for (const file of factory.stamped) {
      yield* Console.log(describe(file.outcome, file.path));
    }

    const created = factory.stamped.filter((file) => file.outcome === "created").length;
    const kept = factory.stamped.length - created;
    // Not "into .kojo/". Two of these land in `.claude/skills/kojo/`, and a count that named one
    // directory for a list holding two is the kind of line a reader stops trusting the moment they
    // count the paths above it themselves.
    yield* Console.log(
      kept === 0
        ? `\n${created} files written`
        : `\n${created} written, ${kept} kept — nothing you had edited was replaced`,
    );

    yield* Option.match(factory.image, {
      onNone: () => Console.log("no image was built"),
      onSome: (name: string) => Console.log(`image ${name} built from .kojo/sandbox/Dockerfile`),
    });

    yield* Console.log(
      [
        "",
        `Next, in this order — \`.kojo/README.md\` says the same thing at length:`,
        "",
        `  1. ${firstInstall(factory.choices.toolchain.manager)}`,
        "     Factory source imports `@carere/kojo-runtime` and `effect`. Neither resolves until now.",
        "     It writes node_modules/, which is ignored — see the .gitignore line above — and a",
        "     lockfile, which is not: the sandbox restores dependencies frozen against it, so it",
        "     belongs in the history.",
        "  2. Write the real commands in `.kojo/commands.ts`. Three of the four print",
        "     KOJO-PLACEHOLDER and exit 78 on purpose — a scaffolder cannot know how this repository",
        "     runs its suite, and a guess that exits 0 would report a suite that never ran.",
        "  3. git add --all && git commit --message 'add a kojo factory'",
        "     A run forks its branch from your trunk's last commit, and the merge back refuses a",
        "     trunk holding uncommitted work — the factory, the manifest and the lockfile all",
        "     belong in that commit.",
        "  4. kojo doctor",
        "     It says whether this factory can actually run, and refuses it while it cannot.",
        "  5. kojo daemon install",
        "     One per-user Daemon owns execution, Gate application, the Console, and storage.",
        "  6. kojo project register --path .",
        "     Then use `kojo workflow list --project <project-id>` and",
        "     `kojo workflow start <project-id> <workflow> --payload <json>`.",
        "",
        "An agent working in this repository now finds `.claude/skills/kojo/SKILL.md` on its own:",
        "how to drive this factory, and the rules that bind anyone editing the workflow.",
      ].join("\n"),
    );
  }),
).pipe(
  Command.withDescription("Stamp a Factory into this repository without starting execution"),
  Command.withExamples([
    {
      command: "kojo init",
      description: "Ask for each answer in turn",
    },
    {
      command: "kojo init --agent pi --model claude-sonnet-4-6 --sandbox docker --template review",
      description: "Every answer given, so nothing is asked — what CI and ticket 15 use",
    },
    {
      command: "kojo init --agent claude --model claude-opus-4-8 --sandbox none --template hotfix",
      description: "`claude` is accepted for `claude-code`, so the prompt-free path takes either",
    },
  ]),
);
