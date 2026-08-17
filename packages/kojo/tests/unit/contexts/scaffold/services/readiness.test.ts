import { describe, expect, it } from "@effect/vitest";
import {
  type SandboxChoice,
  sandboxChoices,
  templateNames,
} from "../../../../../src/contexts/scaffold/models/FactoryChoices.ts";
import {
  everyFaultSaysWhatToDo,
  type Finding,
  faults,
  isReady,
} from "../../../../../src/contexts/scaffold/models/Finding.ts";
import { toolchainFor } from "../../../../../src/contexts/scaffold/models/PackageManager.ts";
import { placeholder } from "../../../../../src/contexts/scaffold/models/Placeholder.ts";
import { starters } from "../../../../../src/contexts/scaffold/services/plan.ts";
import {
  binaryOf,
  commandsFinding,
  containerFinding,
  credentialFinding,
  credentialsIn,
  dependencyFinding,
  factoryFinding,
  imageFinding,
  imageNamed,
  layersFinding,
  payloadFinding,
  providerSymbols,
  repositoryFinding,
  rosterFinding,
  runtimeFinding,
  sandboxesNamed,
  sandboxFinding,
  sandboxOf,
  survivorsIn,
  toolchainFinding,
  workflowsFinding,
} from "../../../../../src/contexts/scaffold/services/readiness.ts";
import { enginePackage } from "../../../../../src/contexts/shared/models/FactoryLayout.ts";
import { someEngine } from "../../../../support/engineDependency.ts";

const ran = (exitCode: number, output = "") => ({ ran: true, exitCode, output });
const neverRan = (output: string) => ({ ran: false, exitCode: -1, output });

describe("what the host has to offer", () => {
  it("refuses a runtime that cannot load a workflow", () => {
    expect(runtimeFinding(undefined).standing).toBe("failed");
    expect(runtimeFinding("1.3.14").detail).toBe("bun 1.3.14");
  });

  it("names the three ways a repository is not one a run can cut a branch in", () => {
    const noGit = repositoryFinding({ git: undefined, insideWorkTree: false, head: undefined });
    const noRepository = repositoryFinding({
      git: "git version 2.50.1",
      insideWorkTree: false,
      head: undefined,
    });
    const noCommit = repositoryFinding({
      git: "git version 2.50.1",
      insideWorkTree: true,
      head: undefined,
    });

    expect(noGit.detail).toContain("`git` is not on the PATH");
    expect(noRepository.detail).toContain("not inside a git work tree");
    expect(noCommit.detail).toContain("no commit yet");
    // Three faults, three sentences. One "this repository is not usable" would send every reader
    // to the wrong command.
    expect(new Set([noGit.remedy, noRepository.remedy, noCommit.remedy]).size).toBe(3);

    expect(
      repositoryFinding({ git: "git version 2.50.1", insideWorkTree: true, head: "9f3a1c2" })
        .standing,
    ).toBe("ok");
  });
});

describe("the factory on disk", () => {
  it("says which part is missing rather than that something is", () => {
    expect(
      factoryFinding({ directory: false, config: false, commands: false, workflows: [] }).detail,
    ).toContain("no `.kojo/` here");

    const halfStamped = factoryFinding({
      directory: true,
      config: false,
      commands: true,
      workflows: ["review"],
    });
    expect(halfStamped.standing).toBe("failed");
    expect(halfStamped.detail).toContain("kojo.config.yaml");
    expect(halfStamped.detail).not.toContain("commands.ts");

    expect(
      factoryFinding({ directory: true, config: true, commands: true, workflows: ["review"] })
        .standing,
    ).toBe("ok");
  });
});

/**
 * The sandbox scan, graded against what `kojo init` actually stamps.
 *
 * Not against a hand-written import line that looks like one — against the real output of the real
 * template, for every provider and every starter. That is the difference between grading the
 * property and grading a stand-in for it: a rename inside `providerSource` that this scan stopped
 * recognising would still pass a test written over a literal, and would fail here.
 */
describe("which sandbox a stamped factory says it runs in", () => {
  const stampedWorkflow = (sandbox: SandboxChoice, template: (typeof templateNames)[number]) =>
    starters[template].workflow({
      agent: "pi",
      model: "claude-sonnet-4-6",
      sandbox,
      template,
      toolchain: toolchainFor("bun", "bun.lock"),
      imageName: "kojo-example:latest",
      engine: someEngine,
    }).source;

  it.each(
    sandboxChoices.flatMap((sandbox) => templateNames.map((template) => ({ sandbox, template }))),
  )("reads $sandbox off the $template starter's own import line", ({ sandbox, template }) => {
    expect(sandboxesNamed([stampedWorkflow(sandbox, template)])).toEqual([sandbox]);
  });

  it("has one symbol for each provider, and takes them from the stamper", () => {
    expect(providerSymbols.map(([, sandbox]) => sandbox)).toEqual([...sandboxChoices]);
    expect(new Set(providerSymbols.map(([symbol]) => symbol)).size).toBe(sandboxChoices.length);
  });

  it("reads the import and not the prose, so a mention in a comment is not an answer", () => {
    expect(sandboxesNamed(["// we could move this to docker one day\nconst x = 1;\n"])).toEqual([]);
  });

  it("takes the image tag the workflow asks its provider for", () => {
    expect(imageNamed([stampedWorkflow("docker", "review")])).toBe("kojo-example:latest");
    // `noSandbox()` names none, and nothing is invented in its place.
    expect(imageNamed([stampedWorkflow("none", "review")])).toBeUndefined();
  });

  it("aims the container checks at the provider that has an image, when there are two", () => {
    expect(sandboxOf({ named: ["none", "docker"] })).toBe("docker");
    expect(sandboxOf({ named: ["none"] })).toBe("none");
    expect(sandboxOf({ named: [] })).toBeUndefined();
    // The flag outranks the workflows, which is what makes it an override rather than a hint.
    expect(sandboxOf({ chosen: "podman", named: ["docker"] })).toBe("podman");
  });

  it("skips rather than guesses when no workflow names a provider", () => {
    const finding = sandboxFinding({ named: [] });
    expect(finding.standing).toBe("skipped");
    expect(finding.detail).toContain("--sandbox");
  });
});

describe("the container, the image, and the toolchain inside it", () => {
  it("separates a runtime that is absent from a daemon that is not answering", () => {
    const absent = containerFinding({ command: "docker", probed: neverRan("ENOENT docker") });
    const asleep = containerFinding({
      command: "docker",
      probed: ran(1, "Cannot connect to the Docker daemon"),
    });

    expect(absent.remedy).toContain("Install docker");
    expect(asleep.remedy).toContain("Start it");
    expect(containerFinding({ command: "docker", probed: ran(0, "29.4.0") }).detail).toContain(
      "29.4.0",
    );
  });

  it("hands back the whole build command when the image is not there", () => {
    const finding = imageFinding({
      command: "docker",
      image: "kojo-example:latest",
      probed: ran(1, "No such image"),
    });
    expect(finding.standing).toBe("failed");
    expect(finding.remedy).toContain("docker build --file .kojo/sandbox/Dockerfile");
    expect(finding.remedy).toContain("--tag kojo-example:latest");
    expect(finding.remedy).toContain("AGENT_UID");
  });

  it("shortens the image id to what a person recognises one by", () => {
    const finding = imageFinding({
      command: "docker",
      image: "kojo-example:latest",
      probed: ran(0, `sha256:${"d9e853e87e55".padEnd(64, "0")}`),
    });
    expect(finding.standing).toBe("ok");
    expect(finding.detail).toContain("d9e853e87e55");
  });

  it("says which file to edit when the image lacks the tool the commands call", () => {
    const finding = toolchainFinding({
      manager: "bun",
      image: "kojo-example:latest",
      probed: ran(1),
    });
    expect(finding.detail).toContain("carries no `bun`");
    expect(finding.remedy).toContain(".kojo/sandbox/Dockerfile");
    expect(finding.remedy).toContain(".kojo/commands.ts");
  });

  it("takes the binary an install command calls from the command itself", () => {
    expect(binaryOf("bun install --frozen-lockfile")).toBe("bun");
    expect(binaryOf("  npm ci ")).toBe("npm");
    expect(binaryOf("")).toBeUndefined();
  });
});

/**
 * The check that was missing, and the one every check under it depended on.
 *
 * A factory with two copies of `effect` loaded its commands, loaded its workflows and assembled its
 * layers — `kojo doctor` called it ready — and then the first run died inside the framework. So the
 * cases here are about the two things a message has to carry to be worth having: **both versions**,
 * and both directories, because the versions are usually equal and the paths are the answer.
 */
describe("whether this factory and this engine hold the same effect", () => {
  const mine = someEngine;
  const same = { ...mine.effect };
  const elsewhere = {
    name: "effect",
    version: "4.0.0-test",
    directory: "/repo/node_modules/effect",
  };

  it("passes when one copy of each serves both", () => {
    const finding = dependencyFinding({
      engine: mine,
      kojo: { ...mine.kojo },
      effect: same,
      manager: "bun",
    });
    expect(finding.standing).toBe("ok");
    expect(finding.detail).toContain("one copy of each");
  });

  it("refuses two copies of effect, and names both versions and both directories", () => {
    const finding = dependencyFinding({
      engine: mine,
      kojo: { ...mine.kojo },
      effect: elsewhere,
      manager: "bun",
    });

    expect(finding.standing).toBe("failed");
    // The versions are equal here on purpose: that is the ordinary case, and a check that compared
    // versions would call this healthy. What differs, and what a person acts on, is the directory.
    expect(finding.detail).toContain(mine.effect.directory);
    expect(finding.detail).toContain(elsewhere.directory);
    expect(finding.detail).toContain("4.0.0-test");
    // The failure a person would otherwise meet, named where they can recognise it.
    expect(finding.remedy).toContain("Cannot convert a symbol to a string");
    expect(finding.remedy).toContain(`"effect": "${mine.effect.specifier}"`);
  });

  it("refuses two copies of kojo for a different reason, because the remedy is different", () => {
    const finding = dependencyFinding({
      engine: mine,
      kojo: { name: enginePackage, version: "0.0.1", directory: "/repo/node_modules/kojo" },
      effect: same,
      manager: "bun",
    });

    expect(finding.standing).toBe("failed");
    expect(finding.detail).toContain(`two copies of ${enginePackage}`);
    expect(finding.remedy).toContain("different services");
  });

  it("says which package is unresolvable, and names the install that fixes it", () => {
    const finding = dependencyFinding({
      engine: mine,
      kojo: undefined,
      effect: undefined,
      manager: "pnpm",
    });

    expect(finding.standing).toBe("failed");
    expect(finding.detail).toContain("kojo or effect");
    expect(finding.remedy).toContain("pnpm install");
  });

  it("skips rather than guesses when this engine cannot say where it is", () => {
    const finding = dependencyFinding({
      engine: undefined,
      kojo: undefined,
      effect: undefined,
      manager: "npm",
    });
    expect(finding.standing).toBe("skipped");
  });
});

/**
 * Loading a workflow is not building a payload, and the difference is this ticket.
 *
 * `kojo doctor` imported every workflow module and called that enough. Importing is all that
 * loading does — a module holding a second `effect` imports perfectly well. The first thing that
 * touches both schemas at once is the payload, and that is what these cases are about.
 */
describe("a payload, actually built", () => {
  it("passes when every workflow's payload was built and keyed", () => {
    const finding = payloadFinding([{ _tag: "built", workflow: "review", key: "review/x" }]);
    expect(finding.standing).toBe("ok");
    expect(finding.detail).toContain("review");
  });

  it("fails when one refused, and points at the dependencies line as the likely cause", () => {
    const finding = payloadFinding([
      { _tag: "built", workflow: "hotfix", key: "hotfix/x" },
      { _tag: "refused", workflow: "review", reason: "Cannot convert a symbol to a string" },
    ]);

    expect(finding.standing).toBe("failed");
    expect(finding.detail).toContain("review: Cannot convert a symbol to a string");
    expect(finding.remedy).toContain("two copies of `effect`");
  });

  it("skips a payload one word cannot fill, which `kojo run` declines for the same reason", () => {
    const finding = payloadFinding([
      { _tag: "unfillable", workflow: "wide", fields: ["subject", "urgency"] },
    ]);
    expect(finding.standing).toBe("skipped");
    expect(finding.detail).toContain("2 payload fields");
  });

  it("skips when this factory holds no workflow at all", () => {
    expect(payloadFinding([]).standing).toBe("skipped");
  });
});

describe("credentials", () => {
  it("reads the variables a .env sets, and not the ones it comments out", () => {
    const text = [
      "# Claude Code OAuth token — get one by running `claude setup-token`.",
      "CLAUDE_CODE_OAUTH_TOKEN=abc",
      "# Or an Anthropic API key instead — uncomment and fill in:",
      "# ANTHROPIC_API_KEY=",
    ].join("\n");

    // The commented alternative is exactly what `kojo init` stamps under Claude Code, so reading it
    // as an unfilled credential would fail a correctly filled factory for ever.
    expect(credentialsIn(text)).toEqual([{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "abc" }]);
  });

  it("counts a variable already exported as filled, because that is how CI supplies one", () => {
    const empty = { present: true, text: "ANTHROPIC_API_KEY=\n", exported: () => false };
    expect(credentialFinding(empty).standing).toBe("failed");
    expect(credentialFinding({ ...empty, exported: () => true }).standing).toBe("ok");
  });

  it("refuses a factory with no credential file at all", () => {
    const finding = credentialFinding({ present: false, text: "", exported: () => false });
    expect(finding.standing).toBe("failed");
    expect(finding.detail).toContain(".kojo/.env");
  });
});

/**
 * The one predicate, and the trap beside it.
 *
 * `survivingPlaceholders()` is what a stamped factory exports and what is asked first; the walk over
 * `commands` with `isPlaceholder` is the fallback for a file whose owner deleted that export. Both
 * are the same test, which is the whole point — two definitions of "is this fake" would drift, and a
 * half-edited command would then pass one and fail the other.
 */
describe("which commands are still fake", () => {
  it("asks the module its own question first", () => {
    const module = {
      commands: { install: "npm ci", test: placeholder("test") },
      survivingPlaceholders: () => ["test"],
    };
    expect(survivorsIn(module)).toEqual(["test"]);
  });

  it("falls back to Kojo's own predicate when that export was deleted", () => {
    const module = {
      commands: { install: "npm ci", test: placeholder("test"), lint: "biome check ." },
    };
    expect(survivorsIn(module)).toEqual(["test"]);
  });

  it("catches a command that kept the marker and changed the words", () => {
    // The half-edit is the case a second definition of "placeholder" would miss: this string is
    // nothing `placeholder()` would produce, and it still says out loud that it is fake.
    const module = {
      commands: { test: `sh -c 'echo "KOJO-PLACEHOLDER: still to do" >&2; exit 78'` },
    };
    expect(survivorsIn(module)).toEqual(["test"]);
  });

  it("has no answer for a module that is not a command block", () => {
    expect(survivorsIn({ nothing: true })).toBeUndefined();
    expect(survivorsIn(undefined)).toBeUndefined();
  });

  it("refuses a factory while one survives, and passes one where none does", () => {
    expect(commandsFinding({ _tag: "read", surviving: [] }).standing).toBe("ok");
    const refused = commandsFinding({ _tag: "read", surviving: ["test", "lint"] });
    expect(refused.standing).toBe("failed");
    expect(refused.detail).toContain("test, lint are still placeholders");
    expect(refused.remedy).toContain("Write the real commands");
  });
});

/**
 * The criterion, graded over every failure this build can produce.
 *
 * `failed` takes a remedy as an argument, so this cannot fail while the constructors are the only
 * way a finding is built — which is the point of asserting it: the day somebody writes a `Finding`
 * literal by hand, this is what notices.
 */
describe("a diagnosis", () => {
  const everyFault: ReadonlyArray<Finding> = [
    runtimeFinding(undefined),
    repositoryFinding({ git: undefined, insideWorkTree: false, head: undefined }),
    repositoryFinding({ git: "git", insideWorkTree: false, head: undefined }),
    repositoryFinding({ git: "git", insideWorkTree: true, head: undefined }),
    factoryFinding({ directory: false, config: false, commands: false, workflows: [] }),
    factoryFinding({ directory: true, config: false, commands: false, workflows: [] }),
    commandsFinding({ _tag: "unreadable", reason: "no such file" }),
    commandsFinding({ _tag: "unrecognised" }),
    commandsFinding({ _tag: "read", surviving: ["test"] }),
    credentialFinding({ present: false, text: "", exported: () => false }),
    credentialFinding({ present: true, text: "", exported: () => false }),
    credentialFinding({ present: true, text: "KEY=\n", exported: () => false }),
    containerFinding({ command: "docker", probed: neverRan("ENOENT") }),
    containerFinding({ command: "docker", probed: ran(1) }),
    imageFinding({ command: "docker", image: "i", probed: ran(1) }),
    toolchainFinding({ manager: "bun", image: "i", probed: ran(1) }),
    rosterFinding({ reason: "kojo.config.yaml: agents.drafter.model: Expected string" }),
    workflowsFinding({ reason: "review.ts: nothing here is a workflow" }),
    layersFinding({ reason: "SqlError" }),
  ];

  it("is not ready while anything failed", () => {
    expect(faults(everyFault).length).toBe(everyFault.length);
    expect(isReady(everyFault)).toBe(false);
  });

  it("says what to do about every single one of them", () => {
    expect(everyFaultSaysWhatToDo(everyFault)).toBe(true);
  });

  it("is ready when nothing failed, and a skipped check does not stop it", () => {
    const passing = [
      runtimeFinding("1.3.14"),
      sandboxFinding({ named: [] }),
      rosterFinding({ names: ["drafter"] }),
      workflowsFinding({ loaded: ["review"] }),
      layersFinding({ over: "a scratch database" }),
    ];
    expect(isReady(passing)).toBe(true);
    expect(passing.some((finding) => finding.standing === "skipped")).toBe(true);
  });
});
