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
import { basename, dirname, join, resolve, sep } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import { DAEMON_CLEANUP_MILLIS } from "../../../src/contexts/daemon/services/LifecycleController.ts";
import { startShippedPackageRegistry } from "./ShippedPackageRegistry.ts";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One internal cleanup interval plus one interval for sealing and managed removal. */
export const SHIPPED_MACOS_REMOVAL_TIMEOUT_MILLIS = DAEMON_CLEANUP_MILLIS * 2;

export const shippedMacosRemovalArguments = (managedKojo: string): string[] => [
  managedKojo,
  "daemon",
  "remove",
  "--timeout",
  `${SHIPPED_MACOS_REMOVAL_TIMEOUT_MILLIS}ms`,
];

export const assertShippedSingletonEvidence = (
  result: CommandResult,
  activeInstanceId: string,
  observedInstanceId: string,
): void => {
  if (
    result.exitCode !== 1 ||
    !result.stderr.includes(
      "another Daemon start or purge transition owns the stable lifecycle gate",
    ) ||
    !result.stderr.includes("PURGE_GATE_HELD") ||
    observedInstanceId !== activeInstanceId
  ) {
    throw new Error("a duplicate shipped Daemon did not preserve the active Daemon owner");
  }
};

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

export const shippedMacosControlledWorkflow = (
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
    payload: { message: Schema.String },
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

const projectIdSource = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const shippedProjectId = (registeredOutput: string, listedOutput: string): string => {
  const registered = [
    ...registeredOutput.matchAll(
      new RegExp(`^(?:registered|already registered) Project (${projectIdSource})$`, "gm"),
    ),
  ];
  if (registered.length !== 1) {
    throw new Error("shipped Project registration did not return exactly one UUID Project ID");
  }
  const listed = [...listedOutput.matchAll(new RegExp(`^(${projectIdSource})\\t`, "gm"))];
  if (listed.length !== 1) {
    throw new Error("shipped Project list did not return exactly one UUID Project ID");
  }
  const registeredId = registered[0]?.[1];
  const listedId = listed[0]?.[1];
  if (registeredId === undefined || listedId === undefined || registeredId !== listedId) {
    throw new Error(
      `shipped Project identity differs between registration (${registeredId}) and list (${listedId})`,
    );
  }
  return registeredId;
};

interface ShippedWorkflowObservation {
  readonly ready: boolean;
  readonly diagnostic: string;
  readonly snapshot?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const shippedWorkflowObservation = (
  output: string,
  projectId: string,
): ShippedWorkflowObservation => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch (cause) {
    return {
      ready: false,
      diagnostic: `Workflow observation is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.workflows)) {
    return { ready: false, diagnostic: "Workflow observation has no Workflow collection" };
  }
  const matches = decoded.workflows.filter(
    (workflow): workflow is Record<string, unknown> =>
      isRecord(workflow) &&
      workflow.projectId === projectId &&
      workflow.workflowName === "release-evidence",
  );
  const workflow = matches[0];
  if (matches.length !== 1 || workflow === undefined) {
    return {
      ready: false,
      diagnostic: `expected one release-evidence Workflow for Project ${projectId}; observed ${matches.length}`,
      snapshot: decoded,
    };
  }
  const diagnostic = [
    `Project ${String(workflow.projectState)}`,
    `Factory ${String(workflow.factoryState)}`,
    `Factory Refresh ${String(workflow.refreshState)}`,
    `Workflow ${String(workflow.availability)}`,
  ].join(", ");
  return {
    ready:
      workflow.projectState === "available" &&
      workflow.factoryState === "available" &&
      workflow.refreshState === "current" &&
      workflow.availability === "available",
    diagnostic,
    snapshot: decoded,
  };
};

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
  await recorder.run("printed-bun-install", [bun, "install"], {
    cwd: project,
    env: environment,
    timeout: 120_000,
  });
  // The printed second step tells the Factory author to replace the generated placeholders. This
  // controlled Workflow is authored before the printed first commit, not as repair after doctor.
  writeFileSync(join(project, ".kojo", "commands.ts"), commands);
  writeFileSync(
    join(project, ".kojo", "workflows", "release-evidence.ts"),
    shippedMacosControlledWorkflow(project),
  );
  recorder.write("factory-authorship.json", {
    sequence: "after printed bun install and before printed first commit",
    authored: [".kojo/commands.ts", ".kojo/workflows/release-evidence.ts"],
    providerExecution: "none; the selected Workflow has no agent phase or AgentInvoker",
  });
  await recorder.run("printed-git-add-all", ["/usr/bin/git", "add", "--all"], {
    cwd: project,
    env: environment,
  });
  await recorder.run(
    "printed-git-commit-factory",
    ["/usr/bin/git", "commit", "--message", "add a kojo factory"],
    { cwd: project, env: environment },
  );
  await recorder.run("printed-kojo-doctor", [kojo, "doctor"], {
    cwd: project,
    env: environment,
    timeout: 60_000,
  });
  recorder.write("printed-instruction-sequence.json", {
    source: "printed-kojo-init",
    followedInOrder: [
      { step: 1, instruction: "bun install", evidence: "steps/09-printed-bun-install.log" },
      {
        step: 2,
        instruction: "write real Factory commands and the controlled Workflow",
        evidence: "records/factory-authorship.json",
      },
      {
        step: 3,
        instruction: "git add --all && git commit --message 'add a kojo factory'",
        evidence: ["steps/10-printed-git-add-all.log", "steps/11-printed-git-commit-factory.log"],
      },
      { step: 4, instruction: "kojo doctor", evidence: "steps/12-printed-kojo-doctor.log" },
    ],
  });
};

const observeControlledWorkflow = async (
  recorder: EvidenceRecorder,
  project: string,
  kojo: string,
  projectId: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, unknown>> => {
  const timeoutMillis = 120_000;
  const deadline = Date.now() + timeoutMillis;
  let attempt = 0;
  let lastDiagnostic = "no Workflow observation completed";
  while (Date.now() < deadline) {
    attempt += 1;
    const attemptName = String(attempt).padStart(3, "0");
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const result = await recorder.run(
        `observe-controlled-workflow-${attemptName}`,
        [kojo, "workflow", "list", "--project", projectId, "--json"],
        {
          cwd: project,
          env: environment,
          timeout: Math.min(10_000, remaining),
          accept: [0, 1],
        },
      );
      const observation =
        result.exitCode === 0
          ? shippedWorkflowObservation(result.stdout, projectId)
          : {
              ready: false,
              diagnostic: `workflow list exited ${result.exitCode}: ${result.stderr.trim()}`,
            };
      lastDiagnostic = observation.diagnostic;
      const evidence = {
        attempt,
        exitCode: result.exitCode,
        readiness: observation,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      recorder.write(`workflow-observations/${attemptName}.json`, evidence);
      if (observation.ready && observation.snapshot !== undefined) {
        recorder.write("workflow-observation-final.json", evidence);
        recorder.write("workflow-snapshot.json", observation.snapshot);
        return observation.snapshot;
      }
    } catch (cause) {
      lastDiagnostic = cause instanceof Error ? cause.message : String(cause);
      recorder.write(`workflow-observations/${attemptName}.json`, {
        attempt,
        error: lastDiagnostic,
      });
    }
    const delay = Math.min(1_000, deadline - Date.now());
    if (delay > 0) await Bun.sleep(delay);
  }
  recorder.write("workflow-observation-final.json", {
    attempts: attempt,
    timeoutMillis,
    readiness: "timed-out",
    lastDiagnostic,
  });
  throw new Error(
    `the controlled Workflow did not become available after a current Factory Refresh within ${timeoutMillis}ms; ${lastDiagnostic}; see records/workflow-observations and records/workflow-observation-final.json`,
  );
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

const shippedMacosArtifactContent = "actual Daemon artifact: shipped macOS\n";

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
  const origin = new URL(options.launchUrl).origin;
  const diagnosticName = basename(options.screenshot, ".png");
  const diagnosticPath = join(
    dirname(options.screenshot),
    "records",
    `${diagnosticName}-render.json`,
  );
  const failureScreenshot = join(dirname(options.screenshot), `${diagnosticName}-failure.png`);
  const observations: Array<Record<string, unknown>> = [];
  let stage = "open authenticated Console";
  let artifactResponse: Record<string, unknown> | undefined;
  page.on("requestfailed", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/") || path.startsWith("/_kojo/")) {
      observations.push({
        kind: "request-failed",
        method: request.method(),
        path,
        error: request.failure()?.errorText ?? "unknown",
      });
    }
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/api/") || path.startsWith("/_kojo/")) {
      observations.push({ kind: "response", path, status: response.status() });
    }
  });
  page.on("pageerror", (error) => {
    observations.push({ kind: "page-error", message: error.message });
  });
  try {
    await page.goto(options.launchUrl);
    await page.getByText("Access active", { exact: true }).waitFor();
    const notificationEstablished = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/notifications" &&
        response.status() === 200 &&
        new URL(response.request().headers().referer ?? origin).pathname ===
          `/runs/${options.runId}`,
      { timeout: 10_000 },
    );
    stage = "render retained Run after authenticated notification handshake";
    await page.goto(`${origin}/runs/${options.runId}`);
    await notificationEstablished;
    await page.locator(`[data-run-header="${options.runId}"]`).waitFor();
    await page.getByText(options.expectedState, { exact: true }).first().waitFor();
    await page.getByText("Captured Artifacts", { exact: true }).waitFor();
    await page.getByText("release-evidence.txt", { exact: true }).waitFor();

    const display = page.locator("[data-published-artifact-display]");
    const artifactId = await display.getAttribute("data-published-artifact-display");
    if (artifactId === null || artifactId.length === 0) {
      throw new Error("the retained Artifact display action has no Artifact identity");
    }
    const artifactPath = `/api/v1/runs/${encodeURIComponent(options.runId)}/artifacts/${encodeURIComponent(artifactId)}`;
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === artifactPath &&
        new URL(response.url()).search === "",
      { timeout: 10_000 },
    );
    stage = "read retained Artifact through the authenticated Console API";
    const [, response] = await Promise.all([display.click(), responsePromise]);
    artifactResponse = {
      path: artifactPath,
      status: response.status(),
      contentType: response.headers()["content-type"] ?? null,
    };
    if (response.status() !== 200) {
      throw new Error(`the authenticated Artifact response returned ${response.status()}`);
    }
    const wire = (await response.json()) as {
      readonly artifactId?: unknown;
      readonly content?: unknown;
    };
    if (wire.artifactId !== artifactId || wire.content !== shippedMacosArtifactContent) {
      throw new Error("the authenticated Artifact response changed the retained bytes");
    }

    stage = "render retained Artifact content in the Console";
    const visibleArtifact = page.locator(`[data-published-artifact-content="${artifactId}"]`);
    await visibleArtifact.waitFor({ state: "visible", timeout: 5_000 });
    const visibleContent = await visibleArtifact.textContent();
    if (visibleContent !== shippedMacosArtifactContent) {
      throw new Error("the authenticated Console changed the retained Artifact bytes");
    }
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
    writeFileSync(
      diagnosticPath,
      `${JSON.stringify(
        {
          outcome: "rendered",
          stage,
          artifactResponse,
          visibleContent: true,
          observations,
        },
        null,
        2,
      )}\n`,
    );
    return { text, origin };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const visibleState = {
      runHeader: await page
        .locator(`[data-run-header="${options.runId}"]`)
        .isVisible()
        .catch(() => false),
      artifactAction: await page
        .locator("[data-published-artifact-display]")
        .isVisible()
        .catch(() => false),
      artifactContent: await page
        .locator("[data-published-artifact-content]")
        .isVisible()
        .catch(() => false),
      reconnect: await page
        .getByText("Reconnect", { exact: true })
        .isVisible()
        .catch(() => false),
    };
    await page.screenshot({ path: failureScreenshot, fullPage: true }).catch(() => undefined);
    writeFileSync(
      diagnosticPath,
      `${JSON.stringify(
        {
          outcome: "failed",
          stage,
          message,
          artifactResponse,
          location: new URL(page.url()).pathname,
          visibleState,
          observations,
        },
        null,
        2,
      )}\n`,
    );
    throw new Error(`${stage}: ${message}; see ${diagnosticPath}`, { cause });
  } finally {
    await context.close();
  }
};

const sanitizeGateSnapshot = (snapshot: GateSnapshot): object => ({
  ...snapshot,
  askings: snapshot.askings.map(({ token: _token, ...asking }) => ({
    ...asking,
    token: "[redacted]",
  })),
});

export const assertShippedWaitingGateEvidence = (run: RunStatus, snapshot: GateSnapshot): void => {
  const unanswered = snapshot.askings.filter(
    (asking) => asking.identity.runId === run.runId && asking.state === "unanswered",
  );
  if (
    run.state !== "suspended" ||
    (run.phases?.length ?? 0) < 1 ||
    (run.artifacts?.length ?? 0) < 1 ||
    (run.gates?.length ?? 0) !== 0 ||
    (run.sandboxes?.length ?? 0) < 1 ||
    unanswered.length !== 1 ||
    unanswered[0]?.token.length === 0
  ) {
    throw new Error(
      `the pre-Verdict Run and Asking evidence is incomplete: ${JSON.stringify({ run, gate: sanitizeGateSnapshot(snapshot) })}`,
    );
  }
};

export const assertShippedCompletedRunEvidence = (run: RunStatus): void => {
  if (
    run.state !== "succeeded" ||
    (run.phases?.length ?? 0) < 2 ||
    (run.artifacts?.length ?? 0) < 1 ||
    run.gates?.length !== 1 ||
    run.gates[0]?.outcome !== "answered" ||
    run.sandboxes?.some((sandbox) => sandbox.outcome === "released") !== true
  ) {
    throw new Error(`the settled real Run evidence is incomplete: ${JSON.stringify(run)}`);
  }
};

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

const captureNativeFailure = (recorder: EvidenceRecorder, cause: unknown): void => {
  recorder.write(
    "native-failure.txt",
    `${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  const captureCommand = (name: string, command: ReadonlyArray<string>): void => {
    try {
      const result = Bun.spawnSync([...command]);
      recorder.write(
        name,
        `ExitCode=${result.exitCode}\n${result.stdout.toString()}${result.stderr.toString()}`,
      );
    } catch (commandCause) {
      recorder.write(
        name,
        `Diagnostic command failed: ${commandCause instanceof Error ? commandCause.message : String(commandCause)}\n`,
      );
    }
  };
  captureCommand("native-failure-launchctl-print.log", ["/bin/launchctl", "print", serviceTarget]);
  captureCommand("native-failure-launchctl-disabled.log", [
    "/bin/launchctl",
    "print-disabled",
    serviceDomain,
  ]);
  try {
    const processes = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,pgid=,uid=,state=,command="]);
    const managed = processes.stdout
      .toString()
      .split("\n")
      .filter((line) => line.includes(defaultInstallation) || line.includes(serviceLabel))
      .map((line) => line.replace(/^(\s*\d+\s+\d+\s+\d+\s+\d+\s+\S+)\s+.*$/, "$1 [managed Kojo]"));
    recorder.write(
      "native-failure-processes.log",
      `ExitCode=${processes.exitCode}\n${managed.join("\n")}\n${processes.stderr.toString()}`,
    );
  } catch (processCause) {
    recorder.write(
      "native-failure-processes.log",
      `Diagnostic command failed: ${processCause instanceof Error ? processCause.message : String(processCause)}\n`,
    );
  }

  const selected = [
    defaultInstallation,
    defaultData,
    defaultService,
    defaultCache,
    join(privateTemporaryRoot(), "Kojo"),
    join(defaultInstallation, "active-release"),
    join(defaultInstallation, "bin", "kojo"),
    join(defaultInstallation, "bin", "kojo-launcher"),
  ];
  recorder.write(
    "native-failure-paths.json",
    selected.flatMap((path) => {
      if (!existsSync(path)) return [];
      const stat = lstatSync(path);
      return [
        {
          path,
          uid: stat.uid,
          mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
          kind: stat.isSymbolicLink()
            ? "symbolic-link"
            : stat.isDirectory()
              ? "directory"
              : stat.isFile()
                ? "file"
                : "special",
          size: stat.size,
        },
      ];
    }),
  );
  for (const [name, path] of [
    ["native-failure-service.plist", defaultService],
    ["native-failure-launcher-stdout.log", join(defaultCache, "daemon.stdout.log")],
    ["native-failure-launcher-stderr.log", join(defaultCache, "daemon.stderr.log")],
    [
      "native-failure-supervision-state.json",
      join(defaultData, "launcher-supervision", "state.json"),
    ],
  ] as const) {
    try {
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (stat.isFile() && !stat.isSymbolicLink())
          recorder.write(name, readFileSync(path, "utf8"));
      }
    } catch (readCause) {
      recorder.write(
        `${name}.capture-error.txt`,
        `${readCause instanceof Error ? readCause.message : String(readCause)}\n`,
      );
    }
  }
  try {
    const activePath = join(defaultInstallation, "active-release");
    if (existsSync(activePath)) {
      const releaseId = readFileSync(activePath, "utf8").trim();
      if (/^[A-Za-z0-9._-]+$/.test(releaseId)) {
        const manifest = join(defaultInstallation, "releases", releaseId, "release.json");
        if (existsSync(manifest))
          recorder.write("native-failure-release.json", readFileSync(manifest, "utf8"));
      }
    }
  } catch (readCause) {
    recorder.write(
      "native-failure-release.capture-error.txt",
      `${readCause instanceof Error ? readCause.message : String(readCause)}\n`,
    );
  }
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
    const registered = await recorder.run(
      "printed-project-register",
      [globalKojo, "project", "register", "."],
      {
        cwd: project,
        env: environment,
      },
    );
    const projects = await recorder.run("printed-project-list", [globalKojo, "project", "list"], {
      cwd: project,
      env: environment,
    });
    const projectId = shippedProjectId(registered.stdout, projects.stdout);

    await observeControlledWorkflow(recorder, project, globalKojo, projectId, environment);

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
    assertShippedWaitingGateEvidence(waitingDocument, asking.snapshot);
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
    assertShippedCompletedRunEvidence(completed);
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
    assertShippedCompletedRunEvidence(persistedRun);
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
      "singleton-duplicate-daemon",
      [join(defaultInstallation, "bin", "kojo-launcher")],
      {
        env: { ...managedEnvironment, KOJO_DAEMON_CHILD: "1" },
        accept: [1],
      },
    );
    const singletonInstanceId = endpoint().instanceId;
    assertShippedSingletonEvidence(duplicate, afterRestart.instanceId, singletonInstanceId);
    recorder.write("singleton-duplicate.json", {
      executable: join(defaultInstallation, "bin", "kojo-launcher"),
      mode: "KOJO_DAEMON_CHILD=1",
      expectedRefusal: "PURGE_GATE_HELD",
      exitCode: duplicate.exitCode,
      activeInstanceId: afterRestart.instanceId,
      observedInstanceId: singletonInstanceId,
    });
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
  } catch (cause) {
    try {
      captureNativeFailure(recorder, cause);
    } catch (captureCause) {
      recorder.write(
        "native-failure-capture-error.txt",
        `${captureCause instanceof Error ? captureCause.message : String(captureCause)}\n`,
      );
    }
    throw cause;
  } finally {
    await browser?.close().catch(() => undefined);
    registry?.stop();
    if (ownsInstallation && existsSync(managedKojo)) {
      const cleanupStartedAt = Date.now();
      const cleanup = Bun.spawnSync(shippedMacosRemovalArguments(managedKojo), {
        env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      });
      recorder.write("cleanup-managed-remove.log", `${cleanup.stdout}${cleanup.stderr}`);
      recorder.write("cleanup-managed-remove.json", {
        timeoutMillis: SHIPPED_MACOS_REMOVAL_TIMEOUT_MILLIS,
        elapsedMillis: Date.now() - cleanupStartedAt,
        exitCode: cleanup.exitCode,
      });
      if (cleanup.exitCode !== 0) {
        if (existsSync(managedKojo)) {
          const status = Bun.spawnSync([managedKojo, "daemon", "status", "--details", "--json"], {
            env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          });
          recorder.write("cleanup-managed-remove-status.log", `${status.stdout}${status.stderr}`);
        }
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
