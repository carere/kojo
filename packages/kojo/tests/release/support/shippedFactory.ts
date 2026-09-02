import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const operation = process.argv[2];
const root = resolve(process.argv[3] ?? "");
const packages = resolve(process.argv[4] ?? "");

const packageTarball = (name: string): string => {
  const matches = readdirSync(packages).filter(
    (entry) =>
      entry.startsWith(`${name}-`) &&
      /^\d/.test(entry.slice(name.length + 1)) &&
      entry.endsWith(".tgz"),
  );
  if (matches.length !== 1) {
    throw new Error(`the shipped package set has ${matches.length} ${name} tarballs`);
  }
  const path = join(packages, matches[0] as string);
  return realpathSync(path);
};

const write = (path: string, content: string): void => {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

const prepare = (): void => {
  mkdirSync(root, { recursive: true });
  const runtime = packageTarball("carere-kojo-runtime");
  const contracts = packageTarball("carere-kojo-runner-contracts");
  write(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "kojo-shipped-linux-evidence",
        private: true,
        type: "module",
        packageManager: `bun@${Bun.version}`,
        dependencies: {
          "@carere/kojo-runtime": `file:${runtime}`,
          effect: "4.0.0-beta.106",
        },
        overrides: { "@carere/kojo-runner-contracts": `file:${contracts}` },
      },
      undefined,
      2,
    )}\n`,
  );
  execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "inherit" });
  execFileSync("git", ["-C", root, "config", "user.email", "shipped-linux@kojo.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Kojo shipped Linux evidence"]);
  console.log(`Prepared the authored Project at ${root}.`);
};

const commands = `/** Commands completed by the controlled release-evidence Workflow. */
export const commands = {
  install: "bun install",
  test: "true",
  lint: "true",
  build: "true",
} as const;

export const survivingPlaceholders = (): ReadonlyArray<string> => [];
`;

const workflow = `import { Duration, Effect, Schema } from "effect";
import { fail } from "@carere/kojo-runtime/contexts/gate/models/OnExpiry";
import { noSandbox } from "@carere/kojo-runtime/contexts/sandbox/adapters/providers";
import { runBranch } from "@carere/kojo-runtime/contexts/shared/models/RunBranch";
import { ArtifactPublisher } from "@carere/kojo-runtime/contexts/trace/ports/ArtifactPublisher";
import { CurrentRun } from "@carere/kojo-runtime/contexts/workflow/services/CurrentRun";
import { code } from "@carere/kojo-runtime/contexts/workflow/services/phase/code";
import { gate } from "@carere/kojo-runtime/contexts/workflow/services/phase/gate";
import { sandboxed } from "@carere/kojo-runtime/contexts/workflow/services/sandboxed";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";

export const review = workflow(
  {
    name: "review",
    payload: { request: Schema.String },
    success: Schema.String,
    error: Schema.Unknown,
    idempotencyKey: (payload) => \`shipped-linux/\${payload.request}\`,
  },
  (payload) =>
    Effect.gen(function* () {
      const run = yield* CurrentRun;
      return yield* sandboxed(
        {
          name: "controlled-release-evidence",
          branch: runBranch(run.runId),
          provider: noSandbox(),
          hidden: [],
        },
        Effect.gen(function* () {
          const artifactId = yield* code(
            {
              name: "publish-evidence",
              description: "Publish controlled shipped-install evidence",
              success: Schema.String,
              error: Schema.Never,
            },
            Effect.gen(function* () {
              const artifacts = yield* ArtifactPublisher;
              const published = yield* artifacts.publishText({
                name: "shipped-linux.txt",
                mediaType: "text/plain; charset=utf-8",
                content: \`actual shipped Daemon record for \${payload.request}\\n\`,
              });
              return published.artifactId;
            }),
          );
          const verdict = yield* gate({
            name: "release-proof",
            description: "Continue the controlled shipped Linux evidence Run?",
            actor: "release-evidence",
            choices: ["approve", "reject"],
            deadline: Duration.hours(1),
            onExpiry: fail(),
          });
          yield* code(
            {
              name: "confirm-verdict",
              description: "Record execution after Gate application",
              success: Schema.Void,
              error: Schema.Never,
            },
            Effect.void,
          );
          return \`\${artifactId}:\${verdict.choice}\`;
        }),
      );
    }),
);
`;

const author = (): void => {
  const generated = join(root, ".kojo", "workflows", "review.ts");
  if (!readFileSync(generated, "utf8").includes("export const review = workflow")) {
    throw new Error("kojo init did not create the printed review Workflow");
  }
  write(join(root, ".kojo", "commands.ts"), commands);
  write(join(root, ".kojo", "workflows", "review.ts"), workflow);
  execFileSync("git", ["-C", root, "add", "--all"], { stdio: "inherit" });
  execFileSync("git", ["-C", root, "commit", "--message", "test: author shipped Linux evidence"], {
    stdio: "inherit",
  });
  console.log(
    `Authored ${basename(root)} before validation: the generated placeholders were replaced and the controlled Workflow makes no provider call.`,
  );
};

if (operation === "prepare") prepare();
else if (operation === "author") author();
else throw new Error("usage: shippedFactory.ts <prepare|author> ROOT PACKAGE_DIRECTORY");
