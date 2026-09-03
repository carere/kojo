// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${AGENT_UID}` below is Docker's own
// build-arg syntax, read back out of a stamped Dockerfile. It is a literal to be searched for.

import { describe, expect, it } from "@effect/vitest";
import {
  type FactoryChoices,
  type TemplateName,
  templateNames,
} from "../../../../../src/contexts/scaffold/models/FactoryChoices.ts";
import type { PlannedFile } from "../../../../../src/contexts/scaffold/models/FactoryPlan.ts";
import {
  firstInstall,
  toolchainFor,
} from "../../../../../src/contexts/scaffold/models/PackageManager.ts";
import {
  isPlaceholder,
  placeholderExitCode,
  placeholderMarker,
} from "../../../../../src/contexts/scaffold/models/Placeholder.ts";
import {
  defaultImageName,
  plan,
  starters,
} from "../../../../../src/contexts/scaffold/services/plan.ts";
import { runtimePackage } from "../../../../../src/contexts/shared/models/FactoryLayout.ts";
import { someEngine } from "../../../../support/engineDependency.ts";

const choicesFor = (template: TemplateName, manager: "bun" | "npm" = "bun"): FactoryChoices => ({
  agent: "pi",
  model: "claude-sonnet-4-6",
  sandbox: "docker",
  template,
  toolchain: manager === "bun" ? toolchainFor("bun", "bun.lock") : toolchainFor("npm"),
  imageName: "kojo-demo:latest",
  engine: someEngine,
});

const contentAt = (files: ReadonlyArray<PlannedFile>, path: string): string => {
  const found = files.find((file) => file.path === path);
  if (found === undefined)
    throw new Error(
      `the plan holds no ${path}. It holds: ${files.map((file) => file.path).join(", ")}`,
    );
  return found.content;
};

describe("what a stamped factory is made of", () => {
  it.each(templateNames)(
    "%s stamps the tree the design record names, and only that",
    (template) => {
      const stamped = plan(choicesFor(template));
      const paths = stamped.files.map((file) => file.path);

      // Everything a factory owns, per typescript-effect.md §2 — plus the agent-facing skill, which
      // is the one thing a factory owns that cannot live inside it. A plan is written whole or kept
      // whole, so a file a plan claims must be a file nobody else edits: `.claude/skills/kojo/`
      // qualifies for the same reason `.kojo/` does, and a repository's own `.gitignore` does not.
      //
      // The one file initialisation touches that is on neither list — `package.json` — is therefore
      // deliberately absent. It is **merged** rather than written, by `manifest.ts`, under the
      // narrower rule that no existing value is ever changed. Without it nothing under `.kojo/`
      // resolves, because every file there imports `kojo` and `effect`.
      for (const path of paths) {
        expect(
          path.startsWith(".kojo/") || path.startsWith(".claude/skills/kojo/"),
          `${path} is neither a factory file nor a skill`,
        ).toBe(true);
      }

      expect(paths).toEqual(
        expect.arrayContaining([
          ".kojo/README.md",
          ".kojo/.gitignore",
          ".kojo/.env",
          ".kojo/kojo.config.yaml",
          ".kojo/envelopes.ts",
          ".kojo/checks.ts",
          ".kojo/commands.ts",
          ".kojo/sandbox/Dockerfile",
          // Phase 8's own deliverable: an agent standing in a stamped repository is told how to
          // drive the factory it is standing in.
          ".claude/skills/kojo/SKILL.md",
          ".claude/skills/kojo/operations.md",
          ".claude/skills/kojo/authoring.md",
        ]),
      );
      expect(paths.some((path) => path.startsWith(".kojo/workflows/"))).toBe(true);
    },
  );

  it.each(templateNames)("%s stamps a small Kojo router with exact branch pointers", (template) => {
    const stamped = plan(choicesFor(template));
    const router = contentAt(stamped.files, ".claude/skills/kojo/SKILL.md");
    const operations = contentAt(stamped.files, ".claude/skills/kojo/operations.md");

    expect(router.split("\n").length).toBeLessThanOrEqual(24);
    expect(router).toContain("`.kojo/README.md`");
    expect(router).toContain("`operations.md`");
    expect(router).toContain("`authoring.md`");
    expect(router).not.toContain("```bash");
    expect(router).not.toContain("kojo project register .");
    expect(operations).toContain("kojo project register .");
    expect(operations).toContain("kojo workflow start <project-id> <workflow>");
    expect(operations).toContain("one Daemon for the current OS user");
  });

  it.each(templateNames)(
    "%s copies no engine source: it imports the engine instead",
    (template) => {
      const stamped = plan(choicesFor(template));

      for (const file of stamped.files.filter((candidate) => candidate.path.endsWith(".ts"))) {
        // Every reference to Kojo is a bare package specifier — `from "@carere/kojo/..."` — which is a
        // dependency, resolved from node_modules at the version the target repository pins. A
        // relative reach out of `.kojo/` would be a vendored copy wearing an import's clothes, and it
        // is the one thing this ticket must not ship: stamped source is drift you cannot upgrade away.
        const reaches = [...file.content.matchAll(/from "([^"]+)"/g)].map(
          (match) => match[1] ?? "",
        );
        for (const specifier of reaches) {
          expect(specifier.startsWith("../../")).toBe(false);
          if (specifier.includes("kojo"))
            expect(specifier.startsWith(`${runtimePackage}/`)).toBe(true);
        }
        expect(file.content).toContain(`from "${runtimePackage}/`);
      }
    },
  );
});

/**
 * **Edge 7.** The toolchain a phase calls has to exist where the phase runs, and the only way to
 * keep that true after the first day is for one value to render both files.
 */
describe("the package manager reaching the image and the command block together", () => {
  it.each(templateNames)("%s writes the same manager into both files", (template) => {
    const withBun = plan(choicesFor(template, "bun"));

    const dockerfile = contentAt(withBun.files, ".kojo/sandbox/Dockerfile");
    const commands = contentAt(withBun.files, ".kojo/commands.ts");

    expect(dockerfile).toContain("RUN npm install -g bun");
    expect(commands).toContain("bun install --frozen-lockfile");
    // Both name the evidence, so a person who disagrees with the detection knows what to argue with.
    expect(dockerfile).toContain("bun.lock");
    expect(commands).toContain("bun.lock");
  });

  it("says out loud when npm was assumed rather than detected", () => {
    const guessed = plan(choicesFor("review", "npm"));

    for (const path of [".kojo/sandbox/Dockerfile", ".kojo/commands.ts"]) {
      expect(contentAt(guessed.files, path)).toContain("no lockfile was found");
    }
  });

  it("puts the agent's own CLI in the image, pinned, under the name pi ships as", () => {
    const withPi = plan(choicesFor("review"));
    const piImage = contentAt(withPi.files, ".kojo/sandbox/Dockerfile");
    expect(piImage).toContain("RUN npm install -g @earendil-works/pi-coding-agent@0.84.2");

    // **Pinned rather than floating**, which is the half worth asserting on its own: a stamped
    // factory has to be reproducible, and `kojoPi` builds its command line against a version it was
    // measured against rather than against whatever `latest` resolves to on the day of the build.
    expect(piImage).toMatch(/pi-coding-agent@\d+\.\d+\.\d+/);
    expect(piImage).not.toContain("pi-coding-agent@latest");

    // The old name, which is stale at 0.73.1 and is what this stamped for eleven releases. Ticket
    // 57 — kept as an assertion because nothing else would notice it coming back.
    expect(piImage).not.toContain("@mariozechner/");

    const withClaude = plan({ ...choicesFor("review"), agent: "claude-code" });
    const dockerfile = contentAt(withClaude.files, ".kojo/sandbox/Dockerfile");
    expect(dockerfile).toContain("https://claude.ai/install.sh");
    // Claude Code's installer writes into the agent's own home, so it must run *after* `USER`.
    // pi and codex install globally and must run before it. Getting this backwards produces an
    // image that builds and an agent that is not on the PATH.
    expect(dockerfile.indexOf("USER ${AGENT_UID}")).toBeLessThan(
      dockerfile.indexOf("claude.ai/install.sh"),
    );
    expect(
      contentAt(withPi.files, ".kojo/sandbox/Dockerfile").indexOf("pi-coding-agent"),
    ).toBeLessThan(
      contentAt(withPi.files, ".kojo/sandbox/Dockerfile").indexOf("USER ${AGENT_UID}"),
    );
  });

  it("carries the image name into the workflow that will ask for it", () => {
    const stamped = plan(choicesFor("review"));
    const workflow = stamped.files.find((file) => file.path.startsWith(".kojo/workflows/"));

    expect(workflow?.content).toContain('docker({ imageName: "kojo-demo:latest" })');
  });

  it.each(["none", "vercel"] as const)("stamps no docker provider for --sandbox %s", (sandbox) => {
    const stamped = plan({ ...choicesFor("review"), sandbox });
    const workflow = stamped.files.find((file) => file.path.startsWith(".kojo/workflows/"));

    expect(workflow?.content).not.toContain("docker(");
    expect(workflow?.content).toContain(sandbox === "none" ? "noSandbox()" : "vercel()");
    // The Dockerfile is stamped anyway: it is the written record of what the phases assume, and
    // the day a factory moves into a container is the day it is needed.
    expect(stamped.files.some((file) => file.path === ".kojo/sandbox/Dockerfile")).toBe(true);
  });
});

/**
 * **Edge 6.** A plausible-but-wrong command that exits 0 is worse than one that says it is fake.
 */
describe("the commands a fresh factory ships", () => {
  it.each(templateNames)("%s makes every guessable command obviously fake", (template) => {
    const commands = contentAt(plan(choicesFor(template)).files, ".kojo/commands.ts");

    for (const name of ["test", "lint", "build"]) {
      const line = commands
        .split("\n")
        .find((candidate) => candidate.trimStart().startsWith(`${name}:`));

      expect(line, `no ${name} command was stamped`).toBeDefined();
      // Mechanically detectable, which is what ticket 23 needs: the marker is in the command
      // string itself, so `kojo doctor` recognises a survivor without parsing this file.
      expect(isPlaceholder(line ?? "")).toBe(true);
      expect(line).toContain(placeholderMarker);
      // And it cannot pass. A fake command that exited 0 would make the mechanical half of every
      // acceptance report a clean suite that was never run.
      expect(line).toContain(`exit ${placeholderExitCode}`);
      expect(line).toContain(".kojo/commands.ts");
    }
  });

  it("leaves the one command it actually knows real", () => {
    const commands = contentAt(plan(choicesFor("review")).files, ".kojo/commands.ts");
    const line = commands
      .split("\n")
      .find((candidate) => candidate.trimStart().startsWith("install:"));

    expect(line).toContain("bun install --frozen-lockfile");
    expect(isPlaceholder(line ?? "")).toBe(false);
  });

  it("hands the factory a way to find its own survivors", () => {
    // `kojo doctor` is ticket 23, and what it needs from this one is that the answer is
    // computable without parsing: the stamped file exports the question.
    const commands = contentAt(plan(choicesFor("review")).files, ".kojo/commands.ts");
    expect(commands).toContain(
      'import { isPlaceholder } from "@carere/kojo-runtime/contexts/workflow/models/Placeholder"',
    );
    expect(commands).toContain("export const survivingPlaceholders");
  });
});

/**
 * The page a person reads first, graded as a walk-through rather than as prose.
 *
 * It asserted *"the engine is a versioned dependency in your `package.json`"* about a file
 * initialisation never created, and its walk-through began with `kojo run` — a command that could
 * not work, because nothing under `.kojo/` resolved. Both are things a test can hold it to.
 */
describe("the README a stamped factory carries", () => {
  it.each(templateNames)("%s describes only files the plan actually writes", (template) => {
    const stamped = plan(choicesFor(template));
    const readme = contentAt(stamped.files, ".kojo/README.md");
    const written = new Set(stamped.files.map((file) => file.path.replace(/^\.kojo\//, "")));

    // Every row of the "What is where" table names a file, and every one of them has to exist.
    // The prompt row is written `prompts/<agent>/system.md` and stands for one per agent, so it is
    // matched by prefix; everything else is a path.
    const rows = [...readme.matchAll(/^\| `([^`]+)` \| /gm)].map((match) => match[1] ?? "");
    expect(rows.length).toBeGreaterThan(5);

    for (const row of rows) {
      const named =
        written.has(row) ||
        (row.includes("<agent>") &&
          [...written].some((path) => path.startsWith(row.split("<agent>")[0] ?? "")));
      expect(named, `the README names \`${row}\`, and nothing stamps it`).toBe(true);
    }
  });

  it.each(templateNames)("%s tells a person to install before anything else", (template) => {
    const readme = contentAt(plan(choicesFor(template)).files, ".kojo/README.md");
    const choices = choicesFor(template);

    // Followed literally, the walk-through has to work. It cannot begin with a Workflow Start:
    // every
    // file in the directory imports `kojo` and `effect`, and neither resolves until an install.
    expect(readme.indexOf(firstInstall(choices.toolchain.manager))).toBeLessThan(
      readme.indexOf(`kojo workflow start <project-id> ${template}`),
    );
    // And the manifest it now describes is one initialisation writes, with both entries named.
    expect(readme).toContain("package.json");
    expect(readme).toContain(choices.engine.runtime.specifier);
    expect(readme).toContain(choices.engine.effect.specifier);
  });

  it("names the install that works after two dependencies were just added", () => {
    // `Toolchain.install` is frozen against the lockfile, which is right inside a sandbox and
    // **fails** on a manifest that has grown two entries no lockfile knows about.
    expect(firstInstall("bun")).toBe("bun install");
    expect(toolchainFor("bun").install).toContain("--frozen-lockfile");
  });
});

describe("where a Run's state goes", () => {
  it.each(templateNames)("%s keeps only credentials in the Project ignore file", (template) => {
    const stamped = plan(choicesFor(template));

    expect(stamped.directories).not.toContain(".kojo/data");

    const ignore = contentAt(stamped.files, ".kojo/.gitignore");
    expect(ignore).toContain(".env");
    expect(ignore).not.toContain("data/");
    expect(ignore).not.toContain("*.db");
  });
});

describe("the Factory asset declaration", () => {
  it.each(templateNames)("%s declares retained non-source inputs", (template) => {
    const stamped = plan(choicesFor(template));
    const manifest = JSON.parse(contentAt(stamped.files, ".kojo/factory.json")) as {
      formatVersion: number;
      assets: ReadonlyArray<string>;
    };

    expect(manifest.formatVersion).toBe(1);
    expect(manifest.assets).toContain("kojo.config.yaml");
    expect(manifest.assets).toContain("sandbox/Dockerfile");
    expect(manifest.assets.some((asset) => asset.startsWith("prompts/"))).toBe(true);
    expect(manifest.assets).not.toContain(".env");
    expect(manifest.assets.every((asset) => !asset.startsWith("data/"))).toBe(true);
  });
});

describe("the roster and the workflow agreeing", () => {
  it.each(templateNames)(
    "%s names every agent its workflow calls, with both prompts",
    (template) => {
      const stamped = plan(choicesFor(template));
      const starter = starters[template];
      const workflow = stamped.files.find((file) => file.path.startsWith(".kojo/workflows/"));
      const config = contentAt(stamped.files, ".kojo/kojo.config.yaml");

      // A workflow that calls an agent the roster does not name is a factory that fails at its first
      // agent phase, minutes into a run. It is the cheapest thing in this ticket to get wrong.
      for (const agent of starter.agents) {
        expect(workflow?.content).toContain(`agent: "${agent.name}"`);
        expect(config).toContain(`  ${agent.name}:`);
        // `YamlRoster` reads both files at load, so a missing one is a factory that cannot start.
        expect(
          stamped.files.some((file) => file.path === `.kojo/prompts/${agent.name}/system.md`),
        ).toBe(true);
        expect(
          stamped.files.some((file) => file.path === `.kojo/prompts/${agent.name}/user.md`),
        ).toBe(true);
      }

      expect(config).toContain('model: "claude-sonnet-4-6"');
    },
  );

  it("writes no prompt that carries its own copy of the contract", () => {
    // `renderPrompt` appends the envelope's JSON Schema to every call, generated from the schema
    // the decoder uses. A hand-written example in a prompt would be a second contract to keep in
    // step, which is exactly what D5 makes unrepresentable everywhere else.
    for (const template of templateNames) {
      for (const file of plan(choicesFor(template)).files.filter((candidate) =>
        candidate.path.startsWith(".kojo/prompts/"),
      )) {
        expect(file.content).not.toContain("_tag");
        expect(file.content).not.toContain("```json");
      }
    }
  });
});

describe("the image name a repository gets when nobody names one", () => {
  it("derives it from the directory, lower-cased, because Docker refuses anything else", () => {
    expect(defaultImageName("MyRepo")).toBe("kojo-myrepo:latest");
    expect(defaultImageName("some repo!")).toBe("kojo-some-repo:latest");
    expect(defaultImageName("---")).toBe("kojo-factory:latest");
  });
});
