import { agentInstalls, buildsAnImage, type FactoryChoices } from "../models/FactoryChoices.ts";
import { firstInstall } from "../models/PackageManager.ts";
import type { Starter } from "./starter.ts";

/**
 * Where a run's own state goes, relative to `.kojo/`.
 *
 * One directory, and everything that is not a decision goes in it: the trace database, the run
 * data, the agent sessions, the worktrees. It is ignored as a whole rather than by pattern, so a
 * new kind of run artefact does not need a new ignore rule to stay out of the history.
 */
export const dataDirectory = "data";

/**
 * The ignore file, stamped inside `.kojo/` rather than appended to the repository's own.
 *
 * The root `.gitignore` belongs to the person whose repository this is. A scaffolder that edits it
 * has to decide what to do the second time it runs — append again, or parse and merge — and both
 * answers are wrong in a way that shows up as a mangled file. A `.gitignore` inside `.kojo/`
 * governs exactly what Kojo produces and nothing else, and is stamped by the same never-overwrite
 * rule as every other file here.
 */
export const ignore = (): string =>
  [
    "# This file is yours. Kojo wrote it once and will never overwrite it.",
    "#",
    "# Everything a run *produces* is here, and none of it belongs in the history: the trace",
    "# database, the run data, the agent sessions, and the worktrees a sandbox is cut into.",
    "# Everything a run is *decided by* — the roster, the workflows, the envelopes, the checks, the",
    "# commands, the prompts and the Dockerfile — is beside this file and is tracked.",
    "",
    `${dataDirectory}/`,
    "",
    "# Credentials. `.env` is where the agent's key lives; it must never be committed.",
    ".env",
    "",
    "# The engine suspends into a SQLite file. `--database` may point anywhere, so the default",
    "# location is covered here as well as under data/.",
    "*.db",
    "*.db-shm",
    "*.db-wal",
    "",
    "# Beside the database: the lock the first command to touch it takes, and the mark that says it",
    "# was created and migrated. Both are this machine's, and neither belongs in the history.",
    "*.db.first-run*",
    "*.db.migrated",
    "",
  ].join("\n");

/** The credential file. Empty values, and the variable names the chosen agent actually reads. */
export const environment = (choices: FactoryChoices): string =>
  [
    "# This file is yours. Kojo wrote it once and will never overwrite it.",
    "#",
    "# It is ignored by `.kojo/.gitignore`. Fill in the value below; nothing else reads it.",
    "",
    agentInstalls[choices.agent].env,
    "",
  ].join("\n");

/**
 * The file a person reads first.
 *
 * The ticket asks for a template a human can read and understand what to change, and a tree of
 * commented files is only half of that: the other half is one page saying which file answers which
 * question, and which of them is currently lying to them.
 */
export const readme = (choices: FactoryChoices, starter: Starter): string => {
  const workflow = starter.workflow(choices);
  const install = firstInstall(choices.toolchain.manager);

  return [
    "# Your factory",
    "",
    "`kojo init` wrote this directory once. **Nothing in it is a copy of the Kojo engine** — the",
    "engine is a versioned dependency in the `package.json` at the root of this repository, which",
    "`kojo init` wrote the two entries of. Upgrading it is therefore a version bump and never a",
    "re-stamp. Everything here is yours to change, and running `kojo init` again keeps every file",
    "that already exists.",
    "",
    "## First, install",
    "",
    "Every file in this directory imports `kojo` and `effect`, so **nothing here resolves until you",
    "have installed them**:",
    "",
    "```bash",
    install,
    "```",
    "",
    "Two entries went into `package.json` at the repository root:",
    "",
    `- \`${choices.engine.kojo.name}\` — \`${choices.engine.kojo.specifier}\``,
    `- \`${choices.engine.effect.name}\` — \`${choices.engine.effect.specifier}\``,
    "",
    ...(choices.engine.reach === "linked"
      ? [
          "Both are paths on **this machine**, because the `kojo` that stamped this factory is a",
          "checkout rather than an installed version, and there is no published version to name.",
          "Replace them with versions the day you install Kojo from a registry.",
          "",
        ]
      : []),
    "The install writes `node_modules/`, which `kojo init` made sure the repository's `.gitignore`",
    "covers — a run's merge refuses a trunk holding uncommitted files, so what the install produces",
    "must never reach `git status`. It also writes a lockfile, which is **not** ignored on purpose:",
    "the sandbox restores dependencies frozen against it, so it belongs in the history. Commit it.",
    "",
    "`effect` is pinned to the exact version the engine was built against, and the exactness is",
    "load-bearing. **Two copies of `effect` in one process are two `Schema` modules**, so the",
    "payload your workflow declares and the payload the engine reads are different types — and a",
    "run then dies inside the framework, at a line of your workflow that is innocent. `kojo doctor`",
    "refuses a factory in that state and names both copies, so you find out before a run does.",
    "",
    "## What is where",
    "",
    "| File | What it decides |",
    "|---|---|",
    "| `kojo.config.yaml` | The roster: who the agents are, what each is for, which model each uses. |",
    `| \`workflows/${workflow.file}\` | The workflow itself — the phases, their order, where the sandbox scope sits, and where the human is asked. **This is the product.** |`,
    "| `envelopes.ts` | The shape of every answer an agent may give. Kojo renders it into the prompt, so there is no example to keep in step. |",
    "| `checks.ts` | Your definition of done: what an answer is compared against, in the repository rather than in the agent. |",
    "| `commands.ts` | The real invocations a code phase makes. **Three of the four are still fake.** |",
    "| `prompts/<agent>/system.md` | Who that agent is. |",
    "| `prompts/<agent>/user.md` | What that agent is asked, every call. |",
    "| `sandbox/Dockerfile` | The image the phases and the agent run inside. |",
    "| `.env` | The credential your agent reads. Ignored, never committed. |",
    `| \`${dataDirectory}/\` | Runs, the trace database, sessions and worktrees. Ignored as a whole. |`,
    "",
    "Two more files were written **outside** this directory, and they are the only ones:",
    "",
    "| File | What it decides |",
    "|---|---|",
    "| `.claude/skills/kojo/SKILL.md` | What an agent working in this repository is told about driving the factory — the commands, and the four things about them that surprise people. |",
    "| `.claude/skills/kojo/authoring.md` | The rules an agent has to know before it edits a workflow. Three of them only fail on the first suspension. |",
    "",
    "They are there rather than here because a skill has to sit where the agent harness looks for",
    "one, and no harness looks inside a factory. Neither is about *this* factory, so neither goes",
    "stale when you change one.",
    "",
    "## What to change first",
    "",
    "**1. `commands.ts`.** Three of its four entries are placeholders. Each prints",
    "`KOJO-PLACEHOLDER` and exits 78, so the first run that reaches one stops and says so. That is",
    "deliberate: a scaffolder cannot know how this repository runs its suite, and a plausible guess",
    "that exits 0 would report a clean suite that never ran. Until you replace them, the mechanical",
    "half of every acceptance refuses — a freshly stamped factory cannot land anything, on purpose.",
    "",
    "**2. The prompts.** They are written for a generic repository. The agent keeps your",
    "`AGENTS.md`, so say here only what is true of *this* agent's job.",
    "",
    `**3. \`workflows/${workflow.file}\`.** Read it top to bottom — it is short. Two rules matter when`,
    "you edit it:",
    "",
    "- The `sandboxed` scope goes **around** the phases, never inside one. A gate suspends the run",
    "  by interrupting it, and a phase retries on interrupt, so a sandbox acquired inside a phase",
    "  turns waiting for a human into a defect.",
    "- A loop that contains a gate must be `reviewed`, not `while` or `for`. Every other loop can be",
    "  plain control flow.",
    "",
    "## Running it",
    "",
    "```bash",
    `${install}                         # once, and again after any dependency changes`,
    "git add --all && git commit --message 'add a kojo factory'",
    "                                     # a run forks from this commit, and the merge back",
    "                                     # refuses a trunk holding uncommitted work",
    "kojo doctor                          # says whether this factory can run, and refuses it if not",
    `kojo run ${starter.name} "what the run is about"`,
    "kojo gate list                       # what is waiting on a human, and for how long",
    "kojo gate answer <token> --choice approve",
    "```",
    "",
    "`kojo doctor` is the second line rather than an afterthought: it loads every file here, builds",
    "a payload against the engine's own schemas, and exits non-zero with a remedy for each thing it",
    "found. A freshly stamped factory fails it — the commands below are placeholders — and that is",
    "the honest answer for a factory nobody has finished.",
    "",
    `Run it from the root of this repository. \`${starter.name}\` is the name of the file —`,
    `\`workflows/${workflow.file}\` — and \`kojo run --help\` lists what this directory holds. The`,
    "workflow inside it must declare the same name, and Kojo refuses to run one that does not, so",
    "the name you type and the workflow that runs can never be two different things. Kojo's own",
    "demonstrations are all called `demo-something` and cannot take a name from you.",
    "",
    "The word after the name is the whole payload: it fills the single field the workflow declares.",
    "",
    "`kojo run` does not block on a gate. It prints where the run stopped and exits 0 — a suspended",
    "run is a success. Close the terminal; answer from anywhere, days later, and the run continues",
    "from where it stopped rather than from the top.",
    "",
    "## What approval does",
    "",
    "Every run works on a branch of its own, named after the run — `kojo/<run id>`. The agent's work",
    "is committed there, and **an approved run merges that branch onto your trunk**. The merge is the",
    "last phase of the workflow: it is code rather than an agent, it uses the same git the rest of the",
    "run uses, and it hangs on one condition — the acceptance, which is your suite's verdict *and* the",
    "human's together. Either half saying no merges nothing at all: the run fails with `NotAccepted`,",
    "your trunk is untouched, and the branch is left exactly as it is so you can check it out and look.",
    "",
    `The trunk is the \`trunk\` constant at the top of \`workflows/${workflow.file}\`, and it is \`main\``,
    "until you change it. The merge happens in the repository you started the run from, so that",
    "repository has to be on that branch with nothing uncommitted in it when the run lands. If it is",
    "not, the merge refuses and says which branch it found — it does not put the work somewhere else.",
    "",
    "So a freshly stamped factory lands nothing, whatever anybody approves: `commands.test` is still a",
    "placeholder, the mechanical half of the acceptance therefore refuses, and no approval can outvote",
    "it. That is the same sentence as **What to change first**, seen from the other end.",
    "",
    "## The image",
    "",
    ...(buildsAnImage(choices.sandbox)
      ? [
          `Built as \`${choices.imageName}\` from \`sandbox/Dockerfile\`. \`workflows/${workflow.file}\``,
          "names the same string, so renaming it in one place means renaming it in the other.",
          "",
          "Rebuild it after you edit the Dockerfile:",
          "",
          "```bash",
          `docker build --file .kojo/sandbox/Dockerfile --tag ${choices.imageName} \\`,
          "  --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) .kojo/sandbox",
          "```",
          "",
          "The uid and gid are not decoration: the sandbox provider starts containers as your host",
          "user and refuses an image built for a different one.",
        ]
      : [
          `This factory was initialised with \`--sandbox ${choices.sandbox}\`, so no image was built.`,
          "`sandbox/Dockerfile` is stamped anyway, because the day you move to a container is the",
          "day you need it — and because it is the written record of the toolchain your phases",
          "assume. Keep it in step with `commands.ts`.",
        ]),
    "",
  ].join("\n");
};
