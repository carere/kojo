import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import { startShippedPackageRegistry } from "./ShippedPackageRegistry.ts";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface EndpointRecord {
  readonly formatVersion: number;
  readonly instanceId: string;
  readonly dataIdentity: string;
  readonly socketPath: string;
  readonly consoleOrigin: string;
}

interface GateSnapshot {
  readonly askings: ReadonlyArray<{
    readonly token: string;
    readonly identity: { readonly runId: string };
    readonly state: string;
    readonly description: string;
  }>;
}

interface RunStatus {
  readonly runId: string;
  readonly state: string;
  readonly phases?: ReadonlyArray<unknown>;
  readonly artifacts?: ReadonlyArray<unknown>;
  readonly gates?: ReadonlyArray<{ readonly outcome: string }>;
  readonly sandboxes?: ReadonlyArray<{ readonly outcome: string }>;
}

const workspace = resolve(new URL("../../../../../", import.meta.url).pathname);
const defaultInstallation = join(homedir(), "Library", "Application Support", "Kojo");
const defaultData = join(defaultInstallation, "data");
const defaultService = join(homedir(), "Library", "LaunchAgents", "dev.kojo.daemon.plist");
const defaultCache = join(homedir(), "Library", "Caches", "Kojo");
const serviceLabel = "dev.kojo.daemon";
const serviceDomain = `gui/${process.getuid?.() ?? -1}`;
const serviceTarget = `${serviceDomain}/${serviceLabel}`;

const privateTemporaryRoot = (): string => {
  const result = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"]);
  const root = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !root.startsWith("/")) {
    throw new Error("macOS did not supply the isolated account temporary directory");
  }
  return root;
};

const assertReleaseIsolation = (): void => {
  const failures: string[] = [];
  if (process.platform !== "darwin") failures.push(`Host is ${process.platform}, not macOS`);
  if (process.env.GITHUB_ACTIONS !== "true") {
    failures.push("GITHUB_ACTIONS is not true; a disposable runner account is required");
  }
  if (process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    failures.push("RUNNER_ENVIRONMENT is not github-hosted; a disposable account is required");
  }
  if (process.env.RUNNER_OS !== "macOS") failures.push("RUNNER_OS is not macOS");
  if (process.env.RUNNER_TEMP === undefined) failures.push("RUNNER_TEMP is absent");
  for (const path of [
    defaultInstallation,
    defaultService,
    defaultCache,
    join(privateTemporaryRoot(), "Kojo"),
  ]) {
    if (existsSync(path)) failures.push(`pre-existing Kojo path: ${path}`);
  }
  const loaded = Bun.spawnSync(["/bin/launchctl", "print", serviceTarget]);
  if (loaded.exitCode === 0) failures.push(`pre-existing native service: ${serviceTarget}`);
  const disabled = Bun.spawnSync(["/bin/launchctl", "print-disabled", serviceDomain]);
  if (disabled.exitCode !== 0) {
    failures.push(`the native service domain is unavailable: ${serviceDomain}`);
  } else if (disabled.stdout.toString().includes(`"${serviceLabel}"`)) {
    failures.push(`pre-existing native service override: ${serviceTarget}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `native release isolation was not established; no installation command ran:\n- ${failures.join("\n- ")}`,
    );
  }
};

const safeName = (value: string): string => value.replaceAll(/[^a-z0-9-]+/gi, "-");

class EvidenceRecorder {
  readonly root: string;
  #sequence = 0;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, "steps"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "records"), { recursive: true, mode: 0o700 });
  }

  write(name: string, value: string | object): void {
    const path = join(this.root, "records", name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }

  async run(
    name: string,
    command: ReadonlyArray<string>,
    options: {
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string | undefined>>;
      readonly timeout?: number;
      readonly record?: boolean;
      readonly redactOutput?: boolean;
      readonly redactArguments?: ReadonlyArray<number>;
      readonly accept?: ReadonlyArray<number>;
    } = {},
  ): Promise<CommandResult> {
    const child = Bun.spawn([...command], {
      cwd: options.cwd ?? workspace,
      env: options.env ?? process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${name} exceeded ${options.timeout ?? 60_000}ms`));
      }, options.timeout ?? 60_000);
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const exitCode = await Promise.race([child.exited, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    const result = { exitCode, stdout: await stdout, stderr: await stderr };
    if (options.record !== false) {
      this.#sequence += 1;
      const output = options.redactOutput
        ? "[sensitive command output redacted]\n"
        : `${result.stdout}${result.stderr}`;
      const displayedCommand = command.map((part, index) =>
        options.redactArguments?.includes(index) === true ? "[redacted]" : part,
      );
      writeFileSync(
        join(
          this.root,
          "steps",
          `${String(this.#sequence).padStart(2, "0")}-${safeName(name)}.log`,
        ),
        [
          `Command=${displayedCommand.map((part) => JSON.stringify(part)).join(" ")}`,
          `WorkingDirectory=${options.cwd ?? workspace}`,
          `ExitCode=${result.exitCode}`,
          "Output:",
          output,
        ].join("\n"),
      );
    }
    const accepted = options.accept ?? [0];
    if (!accepted.includes(result.exitCode)) {
      throw new Error(`${name} exited ${result.exitCode}:\n${result.stdout}\n${result.stderr}`);
    }
    return result;
  }
}

const controlledWorkflow = (
  project: string,
): string => `import { Duration, Effect, Schema } from "effect";
import { fail } from "@carere/kojo-runtime/contexts/gate/models/OnExpiry";
import { noSandbox } from "@carere/kojo-runtime/contexts/sandbox/adapters/providers";
import { ArtifactPublisher } from "@carere/kojo-runtime/contexts/trace/ports/ArtifactPublisher";
import { CurrentRun } from "@carere/kojo-runtime/contexts/workflow/services/CurrentRun";
import { code } from "@carere/kojo-runtime/contexts/workflow/services/phase/code";
import { gate } from "@carere/kojo-runtime/contexts/workflow/services/phase/gate";
import { sandboxed } from "@carere/kojo-runtime/contexts/workflow/services/sandboxed";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";

export const releaseEvidence = workflow(
  {
    name: "release-evidence",
    payload: Schema.Struct({ message: Schema.String }),
    success: Schema.String,
    error: Schema.Unknown,
    idempotencyKey: (payload) => payload.message,
  },
  (payload) => Effect.gen(function* () {
    const run = yield* CurrentRun;
    return yield* sandboxed(
      {
        name: "shipped-macos",
        branch: "kojo/release-" + run.runId,
        provider: noSandbox(),
        cwd: ${JSON.stringify(project)},
        hidden: [],
      },
      Effect.gen(function* () {
        const artifactId = yield* code(
          {
            name: "publish-evidence",
            description: "Publish controlled shipped-release evidence",
            success: Schema.String,
            error: Schema.Never,
            recoveryPolicy: "safe-repetition",
          },
          Effect.gen(function* () {
            const artifacts = yield* ArtifactPublisher;
            return (yield* artifacts.publishText({
              name: "release-evidence.txt",
              mediaType: "text/plain; charset=utf-8",
              content: "actual Daemon artifact: " + payload.message + "\\n",
            })).artifactId;
          }),
        );
        yield* gate({
          name: "ship",
          description: "Approve the controlled shipped macOS Run",
          actor: "release-verifier",
          choices: ["approve", "reject"],
          deadline: Duration.minutes(15),
          onExpiry: fail(),
        });
        return yield* code(
          {
            name: "complete-evidence",
            description: "Complete the controlled shipped-release Run",
            success: Schema.String,
            error: Schema.Never,
            recoveryPolicy: "safe-repetition",
          },
          Effect.succeed(artifactId),
        );
      }),
    );
  }),
);
`;

const commands = `import { isPlaceholder } from "@carere/kojo-runtime/contexts/workflow/models/Placeholder";

export const commands = {
  install: "bun install --frozen-lockfile",
  test: "true",
  lint: "true",
  build: "true",
} as const;

export const survivingPlaceholders = (): ReadonlyArray<string> =>
  Object.entries(commands).filter(([, command]) => isPlaceholder(command)).map(([name]) => name);
`;

const prepareProject = async (
  recorder: EvidenceRecorder,
  project: string,
  kojo: string,
  bun: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> => {
  await recorder.run("git-init", ["/usr/bin/git", "init", "--initial-branch=main", project]);
  await recorder.run("git-identity-email", [
    "/usr/bin/git",
    "-C",
    project,
    "config",
    "user.email",
    "release-evidence@kojo.invalid",
  ]);
  await recorder.run("git-identity-name", [
    "/usr/bin/git",
    "-C",
    project,
    "config",
    "user.name",
    "Kojo Release Evidence",
  ]);
  await recorder.run(
    "printed-kojo-init",
    [
      kojo,
      "init",
      "--agent",
      "claude",
      "--model",
      "controlled",
      "--sandbox",
      "none",
      "--template",
      "review",
      "--package-manager",
      "bun",
      "--path",
      ".",
    ],
    { cwd: project, env: environment },
  );
  // README tells the Factory author to complete the generated placeholders. The evidence Workflow
  // is authored after init, before install and doctor, and is not a repair of a failed fixture.
  writeFileSync(join(project, ".kojo", "commands.ts"), commands);
  writeFileSync(
    join(project, ".kojo", "workflows", "release-evidence.ts"),
    controlledWorkflow(project),
  );
  recorder.write("factory-authorship.json", {
    sequence: "after kojo init and before bun install",
    authored: [".kojo/commands.ts", ".kojo/workflows/release-evidence.ts"],
    providerExecution: "none; the selected Workflow has no agent phase or AgentInvoker",
  });
  await recorder.run("printed-bun-install", [bun, "install"], {
    cwd: project,
    env: environment,
    timeout: 120_000,
  });
  await recorder.run("printed-kojo-doctor", [kojo, "doctor"], {
    cwd: project,
    env: environment,
    timeout: 60_000,
  });
  await recorder.run("git-add-factory", ["/usr/bin/git", "-C", project, "add", "."]);
  await recorder.run("git-commit-factory", [
    "/usr/bin/git",
    "-C",
    project,
    "commit",
    "-m",
    "test: add controlled release Factory",
  ]);
};

const endpoint = (): EndpointRecord => {
  const path = join(privateTemporaryRoot(), "Kojo", "endpoint.json");
  return JSON.parse(readFileSync(path, "utf8")) as EndpointRecord;
};

const waitFor = async <A>(
  read: () => Promise<A | undefined>,
  message: string,
  timeout = 60_000,
): Promise<A> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error(message);
};

const renderRun = async (options: {
  readonly browser: Browser;
  readonly launchUrl: string;
  readonly runId: string;
  readonly screenshot: string;
  readonly expectedState: string;
  readonly expectedText?: ReadonlyArray<string>;
}): Promise<{ readonly text: string; readonly origin: string }> => {
  const context = await options.browser.newContext();
  const page = await context.newPage();
  await page.goto(options.launchUrl);
  await page.getByText("Access active", { exact: true }).waitFor();
  const origin = new URL(options.launchUrl).origin;
  await page.goto(`${origin}/runs/${options.runId}`);
  await page.locator(`[data-run-header="${options.runId}"]`).waitFor();
  await page.getByText(options.expectedState, { exact: true }).first().waitFor();
  await page.getByText("Captured Artifacts", { exact: true }).waitFor();
  await page.getByText("release-evidence.txt", { exact: true }).waitFor();
  await page.locator("[data-published-artifact-display]").click();
  await page.getByText("actual Daemon artifact: shipped macOS", { exact: false }).waitFor();
  const text = (await page.locator("body").innerText()).trim();
  for (const expected of [
    "release-evidence",
    "publish-evidence",
    "shipped-macos",
    ...(options.expectedText ?? []),
  ]) {
    if (!text.includes(expected))
      throw new Error(`the authenticated Console did not render ${expected}`);
  }
  await page.screenshot({ path: options.screenshot, fullPage: true });
  await context.close();
  return { text, origin };
};

const sanitizeGateSnapshot = (snapshot: GateSnapshot): object => ({
  ...snapshot,
  askings: snapshot.askings.map(({ token: _token, ...asking }) => ({
    ...asking,
    token: "[redacted]",
  })),
});

const modes = (paths: ReadonlyArray<string>): ReadonlyArray<object> =>
  paths.map((path) => {
    const stat = statSync(path);
    return {
      path,
      mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
      uid: stat.uid,
      kind: stat.isDirectory() ? "directory" : stat.isSocket() ? "socket" : "file",
    };
  });

const discardOwnedFixturePath = (path: string): void => {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid?.()) {
    throw new Error(`cleanup refused a path that the disposable account does not own: ${path}`);
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) discardOwnedFixturePath(join(path, child));
  } else if (stat.isFile()) {
    chmodSync(path, 0o600);
  }
  rmSync(path, { recursive: true, force: true });
};

const recordManagedProcesses = async (recorder: EvidenceRecorder, name: string): Promise<void> => {
  const result = await recorder.run(name, ["/bin/ps", "-axo", "pid=,ppid=,pgid=,uid=,command="], {
    record: false,
  });
  const managed = result.stdout
    .split("\n")
    .filter((line) => line.includes(defaultInstallation) || line.includes("dev.kojo.daemon"));
  const observations = managed.flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match === null
      ? []
      : [
          {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            processGroupId: Number(match[3]),
            uid: Number(match[4]),
            command: match[5] ?? "",
          },
        ];
  });
  const expectedUid = process.getuid?.();
  if (
    expectedUid === undefined ||
    observations.length < 2 ||
    observations.some((entry) => entry.uid !== expectedUid) ||
    !observations.some((child) =>
      observations.some(
        (parent) =>
          child.parentPid === parent.pid && child.processGroupId === parent.processGroupId,
      ),
    )
  ) {
    throw new Error("the managed launcher and Daemon process-group relationship was not present");
  }
  recorder.write(`${name}.log`, `${managed.join("\n")}\n`);
  recorder.write(`${name}.json`, observations);
};

/** Run only on an explicit disposable macOS CI account. */
export const collectShippedMacosEvidence = async (): Promise<void> => {
  assertReleaseIsolation();
  const runnerTemporaryRoot = resolve(process.env.RUNNER_TEMP ?? "");
  const evidenceRevisionRoot = resolve(
    process.env.KOJO_RELEASE_EVIDENCE_ROOT ??
      join(runnerTemporaryRoot, "kojo-shipped-macos-evidence"),
  );
  const evidenceRoot = join(evidenceRevisionRoot, "RELEASE-01");
  if (
    runnerTemporaryRoot === resolve("/") ||
    evidenceRevisionRoot === runnerTemporaryRoot ||
    !evidenceRevisionRoot.startsWith(`${runnerTemporaryRoot}${sep}`)
  ) {
    throw new Error("the release evidence path is not a child of the disposable runner directory");
  }
  rmSync(evidenceRevisionRoot, { recursive: true, force: true });
  const recorder = new EvidenceRecorder(evidenceRoot);
  const fixtureRoot = join(runnerTemporaryRoot, `kojo-shipped-${crypto.randomUUID()}`);
  const globalRoot = join(fixtureRoot, "global-bun");
  const project = join(fixtureRoot, "project");
  const archives = join(fixtureRoot, "packages");
  const globalBun = join(globalRoot, "bin", "bun");
  const globalKojo = join(globalRoot, "bin", "kojo");
  const managedKojo = join(defaultInstallation, "bin", "kojo");
  let ownsInstallation = false;
  let registry: Awaited<ReturnType<typeof startShippedPackageRegistry>> | undefined;
  let browser: Browser | undefined;
  let evidenceReports:
    | ReadonlyArray<{ readonly checkId: string; readonly manifest: object }>
    | undefined;
  const cleanupFailures: string[] = [];

  mkdirSync(join(globalRoot, "bin"), { recursive: true, mode: 0o700 });
  mkdirSync(project, { recursive: true, mode: 0o700 });
  copyFileSync(process.execPath, globalBun);
  chmodSync(globalBun, 0o700);

  try {
    registry = await startShippedPackageRegistry({ workspace, destination: archives });
    recorder.write("shipped-packages.json", registry.packages);
    recorder.write("shipped-package-composition.json", registry.composition);
    const environment = {
      ...process.env,
      BUN_INSTALL: globalRoot,
      BUN_INSTALL_CACHE_DIR: join(fixtureRoot, "bun-install-cache"),
      NPM_CONFIG_REGISTRY: registry.origin,
      npm_config_registry: registry.origin,
      PATH: `${join(globalRoot, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    };

    await recorder.run("printed-global-kojo-install", [globalBun, "add", "-g", "@carere/kojo"], {
      env: environment,
      timeout: 120_000,
    });
    await recorder.run("shipped-kojo-version", [globalKojo, "--version"], { env: environment });
    // The preflight proved these paths absent. From this point, even a partial install belongs to
    // this disposable fixture and the finalizer can remove it.
    ownsInstallation = true;
    await recorder.run("printed-daemon-install", [globalKojo, "daemon", "install"], {
      env: environment,
      timeout: 120_000,
    });
    const installedEndpoint = await waitFor(async () => {
      try {
        return endpoint();
      } catch {
        return undefined;
      }
    }, "the shipped LaunchAgent did not publish its endpoint");
    recorder.write("endpoint-installed.json", installedEndpoint);
    await recorder.run(
      "managed-daemon-status-installed",
      [managedKojo, "daemon", "status", "--details", "--json"],
      {
        env: environment,
      },
    );

    await prepareProject(recorder, project, globalKojo, globalBun, environment);
    registry.assertConsumed();
    recorder.write("package-registry-requests.json", registry.requests);
    await recorder.run(
      "printed-project-register",
      [globalKojo, "project", "register", "--path", "."],
      {
        cwd: project,
        env: environment,
      },
    );
    const projects = await recorder.run("printed-project-list", [globalKojo, "project", "list"], {
      cwd: project,
      env: environment,
    });
    const projectId = projects.stdout.match(/^(project_[A-Za-z0-9_-]+)/m)?.[1];
    if (projectId === undefined) throw new Error("the shipped CLI did not return one Project ID");

    await waitFor(async () => {
      const result = await recorder.run(
        "wait-for-workflow",
        [globalKojo, "workflow", "list", "--project", projectId, "--json"],
        { cwd: project, env: environment, record: false, accept: [0, 1] },
      );
      if (result.exitCode !== 0) return undefined;
      return result.stdout.includes('"workflowName":"release-evidence"') &&
        result.stdout.includes('"availability":"available"')
        ? result.stdout
        : undefined;
    }, "the actual Daemon did not discover the controlled Workflow");
    const workflows = await recorder.run(
      "printed-workflow-list",
      [globalKojo, "workflow", "list", "--project", projectId, "--json"],
      { cwd: project, env: environment },
    );
    recorder.write("workflow-snapshot.json", JSON.parse(workflows.stdout) as object);

    const started = await recorder.run(
      "printed-workflow-start",
      [
        globalKojo,
        "workflow",
        "start",
        projectId,
        "release-evidence",
        "--payload",
        '{"message":"shipped macOS"}',
        "--json",
      ],
      { cwd: project, env: environment },
    );
    const startDocument = JSON.parse(started.stdout) as {
      readonly runId?: string;
      readonly run?: { readonly runId?: string };
    };
    const runId = startDocument.runId ?? startDocument.run?.runId;
    if (runId === undefined) throw new Error("the shipped CLI start result has no Run ID");

    const asking = await waitFor(async () => {
      const result = await recorder.run("wait-for-gate", [globalKojo, "gate", "list", "--json"], {
        cwd: project,
        env: environment,
        record: false,
      });
      const snapshot = JSON.parse(result.stdout) as GateSnapshot;
      const selected = snapshot.askings.find(
        (entry) => entry.identity.runId === runId && entry.state === "unanswered",
      );
      return selected === undefined ? undefined : { selected, snapshot };
    }, "the actual Daemon Run did not suspend at its Gate");
    recorder.write("gate-waiting.json", sanitizeGateSnapshot(asking.snapshot));
    const waitingStatus = await recorder.run(
      "run-status-waiting",
      [globalKojo, "run", "status", runId, "--details", "--json"],
      { cwd: project, env: environment },
    );
    const waitingDocument = (JSON.parse(waitingStatus.stdout) as { readonly run: RunStatus }).run;
    if (
      waitingDocument.state !== "suspended" ||
      (waitingDocument.phases?.length ?? 0) < 1 ||
      (waitingDocument.artifacts?.length ?? 0) < 1 ||
      (waitingDocument.gates?.length ?? 0) < 1 ||
      (waitingDocument.sandboxes?.length ?? 0) < 1
    ) {
      throw new Error(`the suspended real Trace is incomplete: ${JSON.stringify(waitingDocument)}`);
    }
    recorder.write("run-waiting.json", waitingDocument);

    const launch = await recorder.run(
      "authenticated-console-grant",
      [globalKojo, "ui", "--no-open"],
      {
        cwd: project,
        env: environment,
        redactOutput: true,
      },
    );
    const launchUrl = launch.stdout.trim();
    browser = await chromium.launch({ headless: true });
    const waitingRender = await renderRun({
      browser,
      launchUrl,
      runId,
      screenshot: join(evidenceRoot, "console-waiting.png"),
      expectedState: "suspended",
      expectedText: ["Approve the controlled shipped macOS Run", "release-verifier"],
    });
    recorder.write("console-waiting.txt", waitingRender.text);

    const currentEndpoint = endpoint();
    const unauthenticated = await fetch(`${currentEndpoint.consoleOrigin}/api/v1/daemon`);
    if (unauthenticated.status !== 401) {
      throw new Error(
        `the actual Console accepted an unauthenticated read with ${unauthenticated.status}`,
      );
    }
    recorder.write("browser-access.json", {
      origin: currentEndpoint.consoleOrigin,
      unauthenticatedDaemonRead: unauthenticated.status,
      authenticatedRunRendered: true,
    });
    recorder.write(
      "private-paths.json",
      modes([
        defaultInstallation,
        defaultData,
        defaultService,
        join(privateTemporaryRoot(), "Kojo"),
        currentEndpoint.socketPath,
        join(defaultInstallation, "active-release"),
        join(defaultInstallation, "bin", "kojo"),
        join(defaultInstallation, "bin", "kojo-launcher"),
      ]),
    );
    const activeRelease = readFileSync(join(defaultInstallation, "active-release"), "utf8").trim();
    recorder.write(
      "managed-release.json",
      readFileSync(join(defaultInstallation, "releases", activeRelease, "release.json"), "utf8"),
    );
    await recorder.run("native-launchctl-before-removal", [
      "/bin/launchctl",
      "print",
      serviceTarget,
    ]);
    await recordManagedProcesses(recorder, "process-group-before-removal");

    rmSync(globalRoot, { recursive: true });
    if (existsSync(globalBun) || existsSync(globalKojo)) {
      throw new Error("the isolated global Kojo or Bun remained after removal");
    }
    recorder.write("global-tool-removal.json", {
      removedRoot: globalRoot,
      globalKojoPresent: false,
      globalBunPresent: false,
      daemonInstanceStillActive: endpoint().instanceId === currentEndpoint.instanceId,
    });
    const managedEnvironment = {
      ...process.env,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      BUN_INSTALL: undefined,
      NPM_CONFIG_REGISTRY: undefined,
      npm_config_registry: undefined,
    };
    await recorder.run(
      "managed-status-without-global-tools",
      [managedKojo, "daemon", "status", "--details", "--json"],
      {
        env: managedEnvironment,
      },
    );
    await recorder.run(
      "managed-repair-without-global-tools",
      [managedKojo, "daemon", "repair", "--check", "--json"],
      {
        env: managedEnvironment,
      },
    );
    await recorder.run(
      "managed-gate-answer-without-global-tools",
      [
        managedKojo,
        "gate",
        "answer",
        asking.selected.token,
        "--choice",
        "approve",
        "--reason",
        "controlled shipped release evidence",
        "--as",
        "release-verifier",
        "--json",
      ],
      {
        cwd: project,
        env: managedEnvironment,
        redactOutput: true,
        redactArguments: [3],
      },
    );

    const completed = await waitFor(async () => {
      const result = await recorder.run(
        "wait-for-complete-run",
        [managedKojo, "run", "status", runId, "--details", "--json"],
        { cwd: project, env: managedEnvironment, record: false },
      );
      const document = (JSON.parse(result.stdout) as { readonly run: RunStatus }).run;
      return document.state === "succeeded" ? document : undefined;
    }, "the managed Daemon did not apply the Verdict and finish the Run");
    if (
      (completed.phases?.length ?? 0) < 2 ||
      (completed.artifacts?.length ?? 0) < 1 ||
      completed.gates?.some((gate) => gate.outcome === "answered") !== true ||
      completed.sandboxes?.some((sandbox) => sandbox.outcome === "released") !== true
    ) {
      throw new Error(`the real Run record is incomplete: ${JSON.stringify(completed)}`);
    }
    recorder.write("run-complete.json", completed);
    const completedLaunch = await recorder.run(
      "managed-authenticated-console-grant",
      [managedKojo, "ui", "--no-open"],
      { cwd: project, env: managedEnvironment, redactOutput: true },
    );
    const completeRender = await renderRun({
      browser,
      launchUrl: completedLaunch.stdout.trim(),
      runId,
      screenshot: join(evidenceRoot, "console-complete.png"),
      expectedState: "succeeded",
    });
    recorder.write("console-complete.txt", completeRender.text);

    const beforeStop = endpoint();
    await recorder.run("native-stop", [managedKojo, "daemon", "stop", "--timeout", "60s"], {
      env: managedEnvironment,
      timeout: 90_000,
    });
    if (existsSync(join(privateTemporaryRoot(), "Kojo", "endpoint.json"))) {
      throw new Error("native stop left the endpoint published");
    }
    await recorder.run(
      "native-status-stopped",
      [managedKojo, "daemon", "status", "--details", "--json"],
      {
        env: managedEnvironment,
      },
    );
    await recorder.run("native-start", [managedKojo, "daemon", "start"], {
      env: managedEnvironment,
      timeout: 60_000,
    });
    const afterStart = await waitFor(async () => {
      try {
        const value = endpoint();
        return value.instanceId === beforeStop.instanceId ? undefined : value;
      } catch {
        return undefined;
      }
    }, "native start did not publish a replacement instance");
    await recorder.run("native-restart", [managedKojo, "daemon", "restart", "--timeout", "60s"], {
      env: managedEnvironment,
      timeout: 90_000,
    });
    const afterRestart = await waitFor(async () => {
      try {
        const value = endpoint();
        return value.instanceId === afterStart.instanceId ? undefined : value;
      } catch {
        return undefined;
      }
    }, "native restart did not confirm a replacement instance");
    if (
      beforeStop.dataIdentity !== afterStart.dataIdentity ||
      afterStart.dataIdentity !== afterRestart.dataIdentity
    ) {
      throw new Error("native replacement changed the Daemon data identity");
    }
    recorder.write("native-replacement.json", { beforeStop, afterStart, afterRestart });
    const persistedStatus = await recorder.run(
      "run-status-after-native-replacement",
      [managedKojo, "run", "status", runId, "--details", "--json"],
      { cwd: project, env: managedEnvironment },
    );
    const persistedRun = (JSON.parse(persistedStatus.stdout) as { readonly run: RunStatus }).run;
    if (
      persistedRun.state !== "succeeded" ||
      (persistedRun.phases?.length ?? 0) < 2 ||
      (persistedRun.artifacts?.length ?? 0) < 1 ||
      persistedRun.gates?.some((gate) => gate.outcome === "answered") !== true ||
      persistedRun.sandboxes?.some((sandbox) => sandbox.outcome === "released") !== true
    ) {
      throw new Error(
        `native replacement lost persisted Run evidence: ${JSON.stringify(persistedRun)}`,
      );
    }
    recorder.write("run-after-native-replacement.json", persistedRun);
    const replacementLaunch = await recorder.run(
      "authenticated-console-grant-after-native-replacement",
      [managedKojo, "ui", "--no-open"],
      { cwd: project, env: managedEnvironment, redactOutput: true },
    );
    const replacementRender = await renderRun({
      browser,
      launchUrl: replacementLaunch.stdout.trim(),
      runId,
      screenshot: join(evidenceRoot, "console-after-native-replacement.png"),
      expectedState: "succeeded",
    });
    recorder.write("console-after-native-replacement.txt", replacementRender.text);
    const duplicate = await recorder.run(
      "singleton-duplicate-launch",
      [join(defaultInstallation, "bin", "kojo-launcher")],
      { env: managedEnvironment, accept: [1] },
    );
    if (duplicate.exitCode === 0 || endpoint().instanceId !== afterRestart.instanceId) {
      throw new Error("a duplicate managed launcher displaced the active Daemon owner");
    }
    await recorder.run("native-launchctl-final", ["/bin/launchctl", "print", serviceTarget]);
    await recordManagedProcesses(recorder, "process-group-final");

    const revision = await recorder.run("tested-revision", ["/usr/bin/git", "rev-parse", "HEAD"]);
    const bunVersion = readFileSync(
      join(defaultInstallation, "releases", activeRelease, "release.json"),
      "utf8",
    );
    const osVersion = await recorder.run("macos-version", ["/usr/bin/sw_vers"]);
    const kernel = await recorder.run("kernel-version", ["/usr/bin/uname", "-a"]);
    const moonVersion = await recorder.run("moon-version", ["moon", "--version"]);
    const managedManifest = JSON.parse(bunVersion) as {
      readonly bunVersion?: string;
      readonly kojoVersion?: string;
    };
    const commonEvidence = {
      formatVersion: 1,
      ticket: 89,
      evidence: "shipped-macos-installation",
      testedRevision: revision.stdout.trim(),
      environment: {
        os: osVersion.stdout.trim(),
        architecture: process.arch,
        kernel: kernel.stdout.trim(),
        bun: managedManifest.bunVersion ?? "unknown",
        moon: moonVersion.stdout.trim(),
        sessionTransport: "macOS GUI LaunchAgent domain",
      },
      managedRelease: managedManifest,
      packages: registry.packages,
      packageComposition: registry.composition,
      loadedTests: [
        {
          tier: "release-macos",
          loaded: 1,
          passed: 1,
          skipped: 0,
          namedSkips: [],
        },
      ],
      noHiddenRepairs: true,
      packageRegistryRequests: registry.requests,
      providerExecution: "none",
    };
    evidenceReports = [
      {
        checkId: "RELEASE-01",
        manifest: {
          ...commonEvidence,
          checkId: "RELEASE-01",
          logs: ["vitest.log", "steps/", "records/"],
          checks: [
            {
              name: "fresh shipped install",
              expected: "printed commands use packed package artifacts without fixture repair",
              actual: "installed",
              evidence: "steps/01-printed-global-kojo-install.log",
            },
            {
              name: "native lifecycle",
              expected: "stop, start, replacement, singleton, endpoint, process group and access",
              actual: "recorded",
              evidence: "records/native-replacement.json",
            },
          ],
        },
      },
      {
        checkId: "RELEASE-02",
        manifest: {
          ...commonEvidence,
          checkId: "RELEASE-02",
          logs: ["../RELEASE-01/vitest.log", "../RELEASE-01/records/"],
          checks: [
            {
              name: "real persisted records",
              expected: "Project, Workflow, Run, Gate, Phase, Sandbox and Artifact",
              actual: "rendered through authenticated Console",
              evidence: "../RELEASE-01/console-complete.png",
            },
            {
              name: "replacement persistence",
              expected: "Run, Gate, Trace, Sandbox and Artifact survive replacement",
              actual: "rendered through a new authenticated Console session",
              evidence: "../RELEASE-01/console-after-native-replacement.png",
            },
          ],
        },
      },
      {
        checkId: "RELEASE-03",
        manifest: {
          ...commonEvidence,
          checkId: "RELEASE-03",
          logs: ["../RELEASE-01/vitest.log", "../RELEASE-01/records/"],
          checks: [
            {
              name: "managed tools after global removal",
              expected: "status, repair and Gate answer remain usable",
              actual: "usable",
              evidence: "../RELEASE-01/records/global-tool-removal.json",
            },
          ],
        },
      },
    ];
  } finally {
    await browser?.close().catch(() => undefined);
    registry?.stop();
    if (ownsInstallation && existsSync(managedKojo)) {
      const cleanup = Bun.spawnSync([managedKojo, "daemon", "remove", "--timeout", "30s"], {
        env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      });
      recorder.write("cleanup-managed-remove.log", `${cleanup.stdout}${cleanup.stderr}`);
      if (cleanup.exitCode !== 0) {
        cleanupFailures.push(`managed removal exited ${cleanup.exitCode}`);
      }
    }
    if (ownsInstallation) {
      Bun.spawnSync(["/bin/launchctl", "bootout", serviceTarget]);
      for (const path of [
        defaultService,
        defaultInstallation,
        defaultCache,
        join(privateTemporaryRoot(), "Kojo"),
      ]) {
        try {
          discardOwnedFixturePath(path);
        } catch (cause) {
          cleanupFailures.push(cause instanceof Error ? cause.message : String(cause));
        }
      }
    }
    try {
      discardOwnedFixturePath(fixtureRoot);
    } catch (cause) {
      cleanupFailures.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (cleanupFailures.length > 0) {
    throw new Error(`release cleanup was incomplete:\n- ${cleanupFailures.join("\n- ")}`);
  }
  if (evidenceReports === undefined) throw new Error("the release evidence reports are absent");
  for (const report of evidenceReports) {
    const directory = join(evidenceRevisionRoot, report.checkId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, "evidence-manifest.json"),
      `${JSON.stringify(report.manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
};
