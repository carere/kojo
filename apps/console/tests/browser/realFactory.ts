// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every `${…}` below belongs to the
// TypeScript this file *writes into a stamped factory*, not to the TypeScript it is. Making these
// template literals would interpolate this script's variables into a workflow that has its own.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The one server in this suite that is **not** a fixture: a factory stamped here, a run started by
 * `kojo run`, and `kojo ui` over the database that run wrote.
 *
 * **It exists because eighty-five green specs could not see the defect this file was added for.**
 * Every other server in `playwright.config.ts` is `kojo ui --fixtures`, whose records are *stated* —
 * built by calling the record constructors and omitting whatever is absent. The SQLite readers built
 * the same records from nullable columns and passed `undefined` for the absent ones, and a present
 * `undefined` encodes as `"inFlight": null` while an omitted key encodes as nothing at all. So the
 * fixtures and the database sent two different documents, the Console was only ever shown one of
 * them, and the run view threw a `TypeError` over every real run. adr/trace/0003 settles the shape;
 * this is what proves the Console meets the shape a real factory sends.
 *
 * Nothing here is faked, and that is the whole point:
 *
 * - `kojo init` stamps the factory, exactly as the README teaches.
 * - `kojo run` starts the workflow and suspends it at its gate.
 * - `kojo ui` serves the database that run wrote, with no `--fixtures` flag anywhere.
 *
 * **No agent is called and no money is spent.** The workflow below is the factory's own and has two
 * `code` phases and a `gate`. It still enters a `sandboxed` scope, so the run leaves a branch, an
 * acquisition record and a second waterfall row — a document with every shape the run view draws,
 * and not one agent turn.
 */

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);

/** The package under test, from this file rather than from wherever the runner was started. */
const packageRoot = new URL("../../../../packages/kojo", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const cli = join(packageRoot, "src", "main.ts");

/**
 * Bun, and it has to be this one.
 *
 * The CLI reaches `bun:sqlite`, which under Node is `ERR_UNSUPPORTED_ESM_URL_SCHEME` at import. This
 * script is itself started by Bun from `playwright.config.ts`, so `process.execPath` is the answer
 * that cannot drift from the runtime the package targets.
 */
const bun = process.execPath;

const run = (command: string, args: ReadonlyArray<string>, cwd: string): string => {
  const finished = spawnSync(command, [...args], { cwd, encoding: "utf8" });
  if (finished.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${finished.status}\n${finished.stdout}\n${finished.stderr}`,
    );
  }
  return finished.stdout;
};

const git = (root: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd: root, encoding: "utf8" });

/**
 * A workflow of the factory's own: a sandbox scope, two code phases, and a gate that is still open.
 *
 * It is written into `.kojo/workflows/` rather than taken from the starters, because a starter's
 * first phase is an `agent` phase and this suite must never spend money. What it keeps from the
 * starter is the shape that matters to the run view — the `sandboxed` scope is **around** the
 * phases, so the acquisition is torn down when the gate suspends the run and the waterfall has a
 * second row with an `interrupted` acquisition on it.
 */
const workflowSource = [
  'import { Duration, Effect, Schema } from "effect";',
  'import { GateRejected } from "kojo/contexts/gate/models/GateRejected";',
  'import * as OnExpiry from "kojo/contexts/gate/models/OnExpiry";',
  'import { noSandbox } from "kojo/contexts/sandbox/adapters/providers";',
  'import { SandboxError } from "kojo/contexts/sandbox/models/SandboxError";',
  'import { WorkspaceError } from "kojo/contexts/sandbox/models/WorkspaceError";',
  'import { WorkspaceUnreachable } from "kojo/contexts/sandbox/models/WorkspaceUnreachable";',
  'import { WorktreeUnusable } from "kojo/contexts/sandbox/models/WorktreeUnusable";',
  'import { code } from "kojo/contexts/workflow/services/phase/code";',
  'import { gate } from "kojo/contexts/workflow/services/phase/gate";',
  'import { sandboxed } from "kojo/contexts/workflow/services/sandboxed";',
  'import { workflow } from "kojo/contexts/workflow/services/workflow";',
  "",
  "export const paperwork = workflow(",
  "  {",
  '    name: "paperwork",',
  "    payload: { form: Schema.String },",
  "    success: Schema.String,",
  "    error: Schema.Union([",
  "      GateRejected,",
  "      SandboxError,",
  "      WorkspaceError,",
  "      WorkspaceUnreachable,",
  "      WorktreeUnusable,",
  "    ]),",
  "    idempotencyKey: (payload) => `paperwork/${payload.form}`,",
  "  },",
  "  (payload) =>",
  "    sandboxed(",
  "      {",
  '        name: "desk",',
  '        branch: "kojo/paperwork/form-12",',
  "        provider: noSandbox(),",
  "      },",
  "      Effect.gen(function* () {",
  "        yield* code(",
  "          {",
  '            name: "prepare",',
  '            description: "Prepare the form",',
  "            success: Schema.String,",
  "            error: Schema.Never,",
  "          },",
  "          // The wait is what gives the span a width. A phase that takes a millisecond is drawn as",
  "          // the two-pixel hairline the waterfall floors it at, and a test cannot click a hairline.",
  "          Effect.as(Effect.sleep(Duration.millis(400)), payload.form),",
  "        );",
  "        yield* code(",
  "          {",
  '            name: "stamp",',
  '            description: "Stamp the form before anybody signs it",',
  "            success: Schema.String,",
  "            error: Schema.Never,",
  "          },",
  "          Effect.as(Effect.sleep(Duration.millis(250)), `${payload.form} stamped`),",
  "        );",
  "        const verdict = yield* gate({",
  '          name: "sign-off",',
  "          description: `Sign ${payload.form}?`,",
  '          actor: "clerk",',
  '          choices: ["approve", "reject"],',
  "          deadline: Duration.days(2),",
  "          onExpiry: OnExpiry.fail(),",
  "        });",
  '        if (verdict.choice !== "approve") {',
  '          return yield* new GateRejected({ gate: "sign-off", actor: "clerk", reason: verdict.reason });',
  "        }",
  "        return yield* code(",
  "          {",
  '            name: "file-it",',
  '            description: "File what the clerk signed",',
  "            success: Schema.String,",
  "            error: Schema.Never,",
  "          },",
  "          Effect.succeed(`${payload.form} filed by ${verdict.answerer}`),",
  "        );",
  "      }),",
  "    ),",
  ");",
  "",
].join("\n");

/**
 * A repository with a real factory in it, and one suspended run.
 *
 * The three things it needs that a bare temp directory does not are the same three
 * `tests/integration/cli/stampedRun.test.ts` names: a git repository with a commit for the branch to
 * fork from, `node_modules/kojo` linked to the package under test so the stamped file's `kojo/...`
 * imports reach *this* engine, and `--sandbox none`, which is a real answer rather than an opt-out.
 */
const stamp = (): string => {
  const root = mkdtempSync(join(tmpdir(), "kojo-console-real-"));

  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Kojo"]);
  git(root, ["config", "user.email", "kojo@example.invalid"]);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "kojo-target", type: "module" }, undefined, 2)}\n`,
  );
  writeFileSync(join(root, ".gitignore"), "node_modules\n");

  run(
    bun,
    [
      cli,
      "init",
      "--path",
      root,
      "--agent",
      "pi",
      "--model",
      "claude-sonnet-4-6",
      "--sandbox",
      "none",
      "--template",
      "review",
      "--skip-image",
    ],
    root,
  );

  // Committed before the links are made, so the branch the run forks from holds the repository and
  // none of its dependencies — which is what a real one looks like.
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "--message", "stamp a factory"]);

  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(packageRoot, join(root, "node_modules", "kojo"));
  for (const dependency of ["effect", "@ai-hero", "@effect", "@types"]) {
    symlinkSync(
      join(packageRoot, "node_modules", dependency),
      join(root, "node_modules", dependency),
    );
  }

  writeFileSync(join(root, ".kojo", "workflows", "paperwork.ts"), workflowSource);

  const started = run(bun, [cli, "run", "paperwork", "form 12"], root);
  if (!started.includes('suspended at gate "sign-off"')) {
    throw new Error(`the run did not suspend at its gate:\n${started}`);
  }

  return root;
};

const root = stamp();

/**
 * `kojo ui` over that database, in the foreground, so Playwright owns its life.
 *
 * No `--fixtures`: this is the SQLite reader, the migration ledger and the artifact reader over a
 * real repository. The signals are forwarded because Playwright stops a web server by signalling the
 * process it started, which is this one.
 */
const server = spawn(bun, [cli, "ui", "--port", String(port)], { cwd: root, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.kill(signal));
}
server.on("exit", (code) => process.exit(code ?? 0));
