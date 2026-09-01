import {
  factoryDirectory,
  runtimePackage,
  workflowsDirectory,
} from "../../shared/models/FactoryLayout.ts";
import type { ResolvedPackage } from "../../shared/models/ResolvedPackage.ts";
import { describeSplit, identify } from "../../shared/models/ResolvedPackage.ts";
import type { Declared, EngineDependency } from "../models/EngineDependency.ts";
import { type Finding, failed, ok, skipped } from "../models/Finding.ts";
import { firstInstall } from "../models/PackageManager.ts";

export const runtimeFinding = (bun: string | undefined): Finding =>
  bun === undefined
    ? failed("runtime", "not running under Bun", "Install Bun and run `kojo` with it.")
    : ok("runtime", `bun ${bun}`);

export interface RepositoryEvidence {
  readonly git: string | undefined;
  readonly insideWorkTree: boolean;
  readonly head: string | undefined;
}

export const repositoryFinding = (evidence: RepositoryEvidence): Finding => {
  if (evidence.git === undefined)
    return failed("repository", "`git` is not on PATH", "Install git.");
  if (!evidence.insideWorkTree)
    return failed(
      "repository",
      "this directory is not inside a Git worktree",
      "Run `kojo doctor --root <repository>` with an exact Git worktree root.",
    );
  if (evidence.head === undefined)
    return failed(
      "repository",
      "this repository has no commit",
      "Create the first commit before you register the Project.",
    );
  return ok("repository", `${evidence.git}, HEAD ${evidence.head}`);
};

export interface FactoryEvidence {
  readonly directory: boolean;
  readonly config: boolean;
  readonly commands: boolean;
  readonly workflows: ReadonlyArray<string>;
}

export const factoryFinding = (evidence: FactoryEvidence): Finding => {
  if (!evidence.directory)
    return failed("factory", `no \`${factoryDirectory}/\` here`, "Run `kojo init` to stamp one.");
  const missing = [
    ...(evidence.config ? [] : ["kojo.config.yaml"]),
    ...(evidence.commands ? [] : ["commands.ts"]),
    ...(evidence.workflows.length === 0 ? [`${workflowsDirectory}/ holds no Workflow`] : []),
  ];
  return missing.length === 0
    ? ok("factory", `${factoryDirectory}/ — ${evidence.workflows.length} Workflows`)
    : failed(
        "factory",
        `${factoryDirectory}/ is missing ${missing.join(" and ")}`,
        "Run `kojo init` again. It keeps authored files and adds only missing files.",
      );
};

export interface DependencyEvidence {
  readonly engine: EngineDependency | undefined;
  readonly runtime: ResolvedPackage | undefined;
  readonly effect: ResolvedPackage | undefined;
  readonly manager: Parameters<typeof firstInstall>[0];
}

export const dependencyFinding = (evidence: DependencyEvidence): Finding => {
  const subject = "dependencies";
  const install = firstInstall(evidence.manager);
  if (evidence.engine === undefined)
    return skipped(subject, "this Kojo installation cannot identify its Project runtime");
  if (evidence.runtime === undefined || evidence.effect === undefined) {
    const missing = [
      ...(evidence.runtime === undefined ? [runtimePackage] : []),
      ...(evidence.effect === undefined ? ["effect"] : []),
    ];
    return failed(
      subject,
      `${factoryDirectory}/ cannot resolve ${missing.join(" or ")}`,
      `Run \`kojo init\`, then \`${install}\`.`,
    );
  }
  const pairs: ReadonlyArray<readonly [Declared, ResolvedPackage]> = [
    [evidence.engine.effect, evidence.effect],
    [evidence.engine.runtime, evidence.runtime],
  ];
  const split = pairs.find(([wanted, found]) => wanted.version !== found.version);
  if (split !== undefined) {
    const [wanted, found] = split;
    return failed(
      subject,
      describeSplit({ mine: wanted, theirs: found }),
      `Declare \`"${wanted.name}": "${wanted.specifier}"\` and run \`${install}\`.`,
    );
  }
  return ok(
    subject,
    `${identify(evidence.engine.runtime)} and effect ${evidence.engine.effect.version}`,
  );
};
