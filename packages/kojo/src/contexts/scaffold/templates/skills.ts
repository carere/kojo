/**
 * What an agent working in a Kojo repository is told about Kojo.
 *
 * **These two files are the only thing `kojo init` writes outside `.kojo/`**, and the exception is
 * the point: a skill has to sit where the agent's harness looks for one, and no harness looks inside
 * a factory. `.claude/skills/<name>/SKILL.md` is Claude Code's own convention, so the file lands
 * there and is picked up without anybody wiring it.
 *
 * Everything below is a fact this build was *taught* rather than a fact it assumed, and each one cost
 * a wave to find. They are written as instructions rather than as prose because the reader is an
 * agent about to type a command:
 *
 *  - a suspended run is a success, and `kojo run` exits 0 with the question unanswered;
 *  - a run is deduplicated by its idempotency key, so **retrying needs a new subject** — re-running
 *    the old one replays the recorded outcome, failure included;
 *  - recording a verdict is not applying it, and the difference is visible in the wording of what
 *    the Console says back;
 *  - the trunk must be checked out and clean or the merge refuses by name;
 *  - `.kojo/` is the agent's own grader and is barred from it by the permission guard, which rolls
 *    the write back and kills the phase rather than asking again.
 *
 * Two more were bought by ticket 36, which ran this factory shape against a repository that already
 * had opinions, and both are in `authoring.md` because both only fail after the work is done:
 *
 *  - preparing the environment is a **sandbox hook**, never a phase — a phase replays its result and
 *    does not run again, so nothing prepares the worktree the scope rebuilt after a gate;
 *  - a repository's own `commit-msg` hook runs inside the `commit` phase, and on the **merge** commit
 *    too, so a factory in a Conventional Commits repository must name the type itself.
 *
 * Three more came from an independent walk of that factory by somebody who had only these files, and
 * every one of them is an *environment* fact rather than a Kojo fact — which is exactly why nobody
 * who already knew the repository would think to write it down:
 *
 *  - **`kojo` is not on the PATH.** Every example here says `kojo …`, and the binary is
 *    `node_modules/.bin/kojo`. The walk had to guess.
 *  - **`kojo watch` and `kojo ui` never exit.** Nothing said so, and the file taught the opposite
 *    lesson — *do not hold the terminal open* — about `kojo run`, the one command that does return.
 *    An earlier attempt at ticket 36 stalled on precisely this and was destroyed after two hours, so
 *    this is the most expensive missing line the build found. `--sweep` does not bound `watch`.
 *  - **`kojo ui` needs a built front end**, which a source checkout does not commit, and the server
 *    resolves that directory once at startup — so building under a running server changes nothing.
 */

/** Where the skill goes in a target repository. Claude Code's own layout, not Kojo's. */
export const skillsDirectory = ".claude/skills/kojo";

/**
 * The front matter every skill carries.
 *
 * The description is what decides whether the skill is ever read, so it names the nouns a person
 * actually types — run, gate, resume, trace, Console — rather than describing the file.
 */
const frontMatter = [
  "---",
  "name: kojo",
  "description: >-",
  "  Drive the Kojo factory in this repository: start a run, see what is waiting on a human, answer",
  "  a gate, apply an answer, and read a run back out of the trace. Use whenever the task is to run,",
  "  resume, unblock, inspect or author a Kojo workflow, or whenever a `.kojo/` directory is present",
  "  and the work touches it.",
  "---",
  "",
].join("\n");

/** The skill itself: how to drive a factory, in the order a person does it. */
export const skill = (): string =>
  [
    frontMatter,
    "# Driving Kojo",
    "",
    "This repository holds a **factory** in `.kojo/`: a roster of agents, one or more workflows, the",
    "envelopes those workflows decode, the checks that grade them, and the commands their code phases",
    "run. The Kojo engine is a versioned dependency, not a copy — nothing under `.kojo/` is engine",
    "source, and upgrading Kojo never means re-stamping.",
    "",
    "Read `.kojo/README.md` first. It says which file decides what.",
    "",
    "## Two facts about the commands themselves",
    "",
    "**`kojo` is probably not on your PATH.** Every example below is written `kojo …` for brevity, but",
    "the engine is a dependency of this repository, not a global install: the binary is",
    "`node_modules/.bin/kojo`. Settle it once and use whatever answers for every command that follows:",
    "",
    "```bash",
    "command -v kojo || ls node_modules/.bin/kojo",
    "```",
    "",
    "**`kojo watch` and `kojo ui` never exit on their own.** `watch` polls the inbox for ever and `ui`",
    "is an HTTP server. Both hold the terminal until something kills them. Run them in the background,",
    "or under a timeout, and never as the last foreground command you are waiting on — that mistake is",
    "indistinguishable from a hang and has cost this project hours. `--sweep <n>` sets the *seconds",
    "between sweeps*; it does not bound the command and does not make it return. Every other `kojo`",
    "command terminates by itself, `kojo run` included.",
    "",
    "## Before you run anything",
    "",
    "```bash",
    "kojo doctor",
    "```",
    "",
    "It loads every file in `.kojo/`, decodes the roster, imports each workflow, builds a payload",
    "against the engine's own schemas, and exits non-zero with a remedy per fault. It writes nothing",
    "and starts nothing. **A factory that fails `doctor` cannot run**, and the line it prints names",
    "the file to open. Two faults are worth recognising on sight:",
    "",
    "- *`.kojo/` cannot resolve kojo or effect* — the repository has not been installed. Install, and",
    "  re-run `kojo init` first if `package.json` does not name both.",
    "- *two copies of `effect`* — the workflow's schemas and the engine's are then different types,",
    "  and a run dies inside the framework at an innocent line. Pin the exact version `doctor` prints.",
    "",
    "## Starting a run",
    "",
    "```bash",
    "kojo run                       # --help lists the workflows this factory has",
    'kojo run <workflow> "<what the run is about>"',
    "```",
    "",
    "The workflow name is the file name under `.kojo/workflows/`, and the module must declare the same",
    "name — Kojo refuses one that does not, so the name typed and the workflow run are never two",
    "different things. Kojo's own demonstrations are all called `demo-something` and cannot shadow a",
    "factory's own name.",
    "",
    "The quoted word is the whole payload: it fills the single field the workflow declares.",
    "",
    "**Four things about `kojo run` that surprise people, in the order they bite.**",
    "",
    "1. **It does not block on a gate, and a suspended run is a success.** The command prints where",
    "   the run stopped and exits 0. Do not read that as a finished run, and do not hold the terminal",
    "   open waiting: the run is holding nothing, and the answer can come days later from anywhere.",
    "2. **A run is deduplicated by its idempotency key**, which is a function of the workflow and the",
    "   payload. Running the same subject again does not start a second run — it returns the recorded",
    "   one, **including a recorded failure**. To retry after a failure, change the subject. That is",
    "   the deduplication working, not a bug.",
    "3. **The trunk has to be checked out and clean.** The merge at the end of a run happens in the",
    "   repository the run was started from, and it refuses — by name, saying which branch it found",
    "   and which it wanted — rather than landing work somewhere nobody expected. Commit or stash",
    "   first.",
    "4. **`--timeout` is how long the command *watches*, not how long the run gets.** The run outlives",
    "   the watching of it. A phase that takes minutes needs a bigger number, or the command stops",
    "   describing a run that is still going.",
    "",
    "## Answering a gate",
    "",
    "```bash",
    "kojo gate list                                  # what is waiting, on whom, and for how long",
    "kojo gate answer <token> --choice approve       # or reject, with --reason",
    "```",
    "",
    "**Recording a verdict and applying it are two different acts, and the second needs a runner.**",
    "`kojo gate answer` does both when it can. Anything that only records — the Console's gate card,",
    'for instance — says so in as many words (*"Recorded — nothing is running"*), and the answer sits',
    "in the queue until a runner picks it up:",
    "",
    "```bash",
    "kojo watch                                      # becomes a runner; applies answers as they land",
    "```",
    "",
    "**That command does not return** — see the top of this file. Background it, and confirm the answer",
    "was applied by looking at the queue rather than by waiting on the process.",
    "",
    "So an answer that appears to do nothing is usually an answer nobody is running. Check `kojo gate",
    "list` — an applied asking leaves the queue.",
    "",
    "Every gate carries a **deadline** and a declared branch on expiry: fail, auto-reject, or escalate",
    "to somebody else once. An expired asking is settled by whichever runner next sweeps, and it leaves",
    "the queue like any other.",
    "",
    "## Watching a run",
    "",
    "```bash",
    "kojo ui                                         # the Console, on http://localhost:4321",
    "```",
    "",
    "**That command does not return either**, and it needs a front end to serve. An installed `kojo`",
    "ships the Console already built. If the page instead says *the front end is not built yet*, you",
    "are running the engine from a source checkout, where the Console is build output rather than a",
    "committed file: build it in that checkout, then **restart `kojo ui`** — the server resolves the",
    "directory once at startup, so a build under a running server changes nothing.",
    "",
    "The Console is read-mostly: it shows the run list, a waterfall of one run over its scope tree, a",
    "detail panel per phase or sandbox acquisition, and the gate queue — and it can record a verdict.",
    "It deliberately does **not** host a runner, because looking at runs must never be an act of",
    "executing them.",
    "",
    "## What not to do",
    "",
    "- **Do not edit anything under `.kojo/` as part of the work a run asked for.** The roster, the",
    "  workflows, the envelopes, the checks, the commands and the prompts are the agent's own grader.",
    "  The permission guard fingerprints the tree around every agent call, rolls unauthorised writes",
    "  back, and fails the phase — a breach is not something a better answer can fix, because the",
    "  write already happened.",
    "- **Do not run `git merge`, `git push` or a release by hand to finish a run.** Merging is the",
    "  workflow's last code phase and it hangs on the acceptance — the suite's verdict *and* the",
    "  human's. Doing it by hand lands work that was never accepted.",
    "- **Do not add a side effect to a workflow body outside a phase.** A body replays from the top on",
    "  every resume, and only a recorded phase replays its result instead of re-running. See",
    "  `authoring.md`.",
    "",
    "## Authoring or changing a workflow",
    "",
    "Read `authoring.md` beside this file. It is short, and three of its rules are the kind that only",
    "fail on the first suspension — days after the mistake.",
    "",
  ].join("\n");

/** The rules an agent has to know before it edits a workflow, and why each one exists. */
export const authoring = (): string =>
  [
    "# Authoring a Kojo workflow",
    "",
    "A workflow is an ordinary Effect program. Kojo supplies four primitives, the ports they plug",
    "into, and the durability that lets a run wait days for a human — and nothing else. There is no",
    "lane taxonomy, no fixed phase order and no built-in definition of done: those are yours.",
    "",
    "| Primitive | What it is | Owns |",
    "|---|---|---|",
    "| `actor` — `gate`, `reviewed` | a human deciding, mid-run | the decision |",
    "| `code` | a known invocation | determinism |",
    "| `agent` | reading and deciding | the judgement call |",
    "| `sandboxed` | an environment around a **region** | the blast radius |",
    "",
    "Plain control flow expresses the rest: `Match` on an envelope's discriminant to pick a lane, a",
    "`for` loop for a correction cycle, an early return on a refusal.",
    "",
    "## The six rules that only fail later",
    "",
    "**1. `sandboxed` goes around the phases, never inside one.** A gate suspends the run by",
    "interrupting it, and a phase retries on interrupt — so a sandbox acquired *inside* a phase turns",
    "waiting for a human into a defect. Around the phases, the container is torn down while the human",
    "thinks and rebuilt from the branch when they answer.",
    "",
    "**2. A loop that contains a gate must be `reviewed`, never `while` or `for`.** A durable deferred",
    "is keyed by name and refuses to be overwritten, so a hand-written loop reads the *first* verdict",
    "back forever: five rounds in milliseconds, one human, and a run that believes it was reviewed",
    "five times. `reviewed` names each asking from the engine's own attempt counter, which is the only",
    "counter that advances. Every other loop stays plain control flow.",
    "",
    "**3. Nothing irreversible happens outside a phase.** The body replays from the top on every",
    "resume; a completed phase returns its recorded result instead of running again. A `git push` in",
    "body code, not inside a phase, fires again days later when somebody answers.",
    "",
    "**4. The work has to reach the branch before a gate.** The branch is the durable state of a run.",
    "A worktree left dirty at a suspension is not merely lost — the rebuild on resume refuses it, and",
    "the run cannot continue at all. Commit before you ask anybody anything.",
    "",
    "**5. Preparing the environment is a sandbox hook, never a phase.** Installing dependencies,",
    "starting a database, warming a cache: a phase replays its recorded *result* and does not run",
    "again, so the first phase after a suspension finds a freshly rebuilt worktree that nothing",
    "prepared. Put it in `hooks`, which runs on every acquisition. Mind which slot: a container",
    "provider runs `sandbox.onSandboxReady`, and a no-sandbox provider runs only",
    "`host.onWorktreeReady`.",
    "",
    "**6. If the repository enforces a commit convention, the workflow has to satisfy it.** A",
    "`commit-msg` hook runs inside the `commit` phase — and on the **merge** commit too, where git's",
    "default is `Merge branch '<branch>'`. An agent's own summary becomes the commit message, so wrap",
    "it: name the type in code, and pass `message` to `merge`. A hook refusal arrives as",
    "`CommitRefused` or `MergeRefused` after the work is already done, and at the merge it arrives",
    "after a human has already approved.",
    "",
    "## The contract",
    "",
    "An envelope is **one declaration** — the type at the call site, the decoder, the JSON Schema",
    "rendered into the agent's prompt, and the wire contract. Never write an example of it by hand;",
    "the prompt already carries the schema, and a hand-written example is a second contract to keep in",
    "step.",
    "",
    "A **check** compares an envelope's claims against the repository, after the fact, and returns",
    "faults rather than a boolean — the correction turn is written from the fault. Checks never ask the",
    "agent anything.",
    "",
    "**Agents propose, code disposes.** An agent puts a commit message on its envelope; a code phase",
    "performs the commit. An agent reports which files it changed; a check verifies it. An agent never",
    "runs the merge — `merge` takes an `Acceptance`, and only a gate and a measurement produce one.",
    "",
    "**Acceptance gates the merge**, and it is the conjunction of the mechanical verdict and the human",
    "one. Phases passing is a different question: a test phase that ran a red suite did its job",
    "perfectly. Either half refusing merges nothing, leaves the trunk untouched, and leaves the",
    "branch and worktree intact for inspection.",
    "",
    "## Commands",
    "",
    "`.kojo/commands.ts` is the one place a factory writes down what its code phases run. A freshly",
    "stamped factory ships obvious placeholders that print `KOJO-PLACEHOLDER` and exit 78, and until",
    "they are replaced the mechanical half of every acceptance refuses. That is deliberate: a",
    "plausible-but-wrong command that exits 0 would report a clean suite that never ran.",
    "",
    "Run them through the `Workspace` port, never through a shell directly, or they grade the",
    "repository you are sitting in instead of the one the agent wrote in.",
    "",
  ].join("\n");
