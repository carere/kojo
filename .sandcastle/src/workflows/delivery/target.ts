import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createWorktree } from "@ai-hero/sandcastle";
import { Effect, FileSystem } from "effect";
import { mapExternalFailure, tryExternalPromise } from "../../shared/external-failure";
import {
  assertLocalBranchExists,
  findGitCommonDirectory,
  listGitWorktrees,
  worktreeStatus,
} from "../../shared/git";
import { processFailure, runProcess, runRequired, runText } from "../../shared/process";
import { type DeliveryWorkstream, PreparedTarget } from "../../types/delivery";
import { WorkflowError } from "../../types/errors";

const lockOwner = (targetBranch: string) =>
  `pid=${globalThis.process.pid} started=${new Date().toISOString()} target=${targetBranch}\n`;

interface ActiveTargetIntegration {
  readonly baseSha: string;
  readonly issueBranch: string;
}

interface TargetCheckpoint {
  readonly version: 1;
  readonly targetBranch: string;
  readonly safeSha: string;
  readonly publishedSha?: string;
  readonly activeIntegration?: ActiveTargetIntegration;
}

const commitPattern = /^[0-9a-f]{40,64}$/;

const checkpointFile = Effect.fn("checkpointFile")(function* (
  repositoryPath: string,
  targetBranch: string,
) {
  const branchId = createHash("sha256").update(targetBranch).digest("hex").slice(0, 16);
  const checkpointRoot = resolve(
    yield* findGitCommonDirectory(repositoryPath),
    "sandcastle-targets",
  );
  return {
    checkpointRoot,
    path: resolve(checkpointRoot, `${branchId}.json`),
  };
});

const parseCheckpoint = (contents: string, path: string, targetBranch: string) =>
  Effect.try({
    try: () => {
      const checkpoint = JSON.parse(contents) as Partial<TargetCheckpoint>;
      if (
        checkpoint.version !== 1 ||
        checkpoint.targetBranch !== targetBranch ||
        typeof checkpoint.safeSha !== "string" ||
        !commitPattern.test(checkpoint.safeSha) ||
        (checkpoint.publishedSha !== undefined &&
          (typeof checkpoint.publishedSha !== "string" ||
            !commitPattern.test(checkpoint.publishedSha))) ||
        (checkpoint.activeIntegration !== undefined &&
          (typeof checkpoint.activeIntegration.baseSha !== "string" ||
            !commitPattern.test(checkpoint.activeIntegration.baseSha) ||
            typeof checkpoint.activeIntegration.issueBranch !== "string"))
      ) {
        throw new Error("invalid target checkpoint shape");
      }
      return checkpoint as TargetCheckpoint;
    },
    catch: (error) =>
      new WorkflowError({
        message: `Cannot read target checkpoint '${path}': ${String(error)}`,
        operation: "delivery.readTargetCheckpoint",
      }),
  });

const readTargetCheckpoint = Effect.fn("readTargetCheckpoint")(function* (
  repositoryPath: string,
  targetBranch: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const location = yield* checkpointFile(repositoryPath, targetBranch);
  if (!(yield* fileSystem.exists(location.path))) return { ...location, checkpoint: undefined };
  const contents = yield* fileSystem
    .readFileString(location.path)
    .pipe(mapExternalFailure("filesystem", `read ${location.path}`));
  return {
    ...location,
    checkpoint: yield* parseCheckpoint(contents, location.path, targetBranch),
  };
});

const writeTargetCheckpoint = Effect.fn("writeTargetCheckpoint")(function* (
  repositoryPath: string,
  checkpoint: TargetCheckpoint,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const { checkpointRoot, path } = yield* checkpointFile(repositoryPath, checkpoint.targetBranch);
  const candidatePath = `${path}.candidate-${randomUUID()}`;
  yield* fileSystem
    .makeDirectory(checkpointRoot, { recursive: true })
    .pipe(mapExternalFailure("filesystem", `create ${checkpointRoot}`));
  yield* Effect.gen(function* () {
    yield* fileSystem
      .writeFileString(candidatePath, `${JSON.stringify(checkpoint)}\n`)
      .pipe(mapExternalFailure("filesystem", `write ${candidatePath}`));
    yield* fileSystem
      .rename(candidatePath, path)
      .pipe(mapExternalFailure("filesystem", `replace ${path}`));
  }).pipe(
    Effect.ensuring(
      fileSystem.remove(candidatePath, { force: true }).pipe(Effect.catch(() => Effect.void)),
    ),
  );
});

const remoteTargetHead = Effect.fn("remoteTargetHead")(function* (
  repositoryPath: string,
  targetBranch: string,
) {
  const command = [
    "git",
    "ls-remote",
    "--exit-code",
    "--heads",
    "origin",
    `refs/heads/${targetBranch}`,
  ];
  const result = yield* runProcess(command, repositoryPath);
  if (result.exitCode === 2) return undefined;
  if (result.exitCode !== 0) return yield* processFailure(command, result, repositoryPath);
  const [head] = result.stdout.trim().split(/\s+/);
  if (!head || !commitPattern.test(head)) {
    return yield* new WorkflowError({
      message: `Remote target '${targetBranch}' returned an invalid commit`,
      operation: "delivery.remoteTargetHead",
    });
  }
  return head;
});

const isAncestor = Effect.fn("isAncestor")(function* (
  path: string,
  ancestor: string,
  descendant: string,
) {
  const result = yield* runProcess(
    ["git", "merge-base", "--is-ancestor", ancestor, descendant],
    path,
  );
  return result.exitCode === 0;
});

const ownerProcessIsAlive = (owner: string) => {
  const pid = Number(/^pid=(\d+)(?:\s|$)/.exec(owner.trim())?.[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return false;

  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

export const ensureCleanWorktree = Effect.fn("ensureCleanWorktree")(function* (path: string) {
  const status = yield* worktreeStatus(path);
  if (status) {
    return yield* new WorkflowError({
      message: `Target worktree '${path}' is dirty:\n${status}`,
      operation: "delivery.ensureCleanWorktree",
    });
  }
});

const checkpointMismatch = (targetBranch: string, message: string) =>
  new WorkflowError({
    message: `Target '${targetBranch}' cannot be recovered safely: ${message}`,
    operation: "delivery.reconcileTargetCheckpoint",
  });

interface RecoverySnapshot {
  readonly reference: string;
  readonly untrackedPaths: ReadonlyArray<string>;
}

const recoveryReference = (targetBranch: string) => {
  const branchId = createHash("sha256").update(targetBranch).digest("hex").slice(0, 16);
  return `refs/sandcastle/recovery/${branchId}/${Date.now()}-${randomUUID()}`;
};

const containedRecoveryPath = (targetPath: string, path: string) => {
  const root = resolve(targetPath);
  const absolutePath = resolve(root, path);
  const relativePath = relative(root, absolutePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return absolutePath;
};

const validateRecoveryPaths = Effect.fn("validateRecoveryPaths")(function* (
  targetPath: string,
  paths: ReadonlyArray<string>,
) {
  for (const path of paths) {
    // Git reports an untracked embedded repository as a directory entry. Its
    // worktree bytes and private object database cannot be represented by a
    // gitlink in the parent recovery commit, so recovery must remain manual.
    if (path.endsWith("/")) {
      return yield* new WorkflowError({
        message: `Cannot snapshot untracked embedded repository '${path}' without losing nested Git data`,
        operation: "delivery.snapshotActiveRecovery",
      });
    }
    if (!containedRecoveryPath(targetPath, path)) {
      return yield* new WorkflowError({
        message: `Refusing invalid recovery path '${path}'`,
        operation: "delivery.snapshotActiveRecovery",
      });
    }
  }
});

const snapshotActiveRecovery = Effect.fn("snapshotActiveRecovery")(function* (
  target: PreparedTarget,
  localHead: string,
  dirty: boolean,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  let snapshotCommit = localHead;
  let untrackedPaths: ReadonlyArray<string> = [];

  if (dirty) {
    const untracked = yield* runRequired(
      ["git", "ls-files", "--others", "--exclude-standard", "-z"],
      target.path,
    );
    untrackedPaths = untracked.stdout.split("\0").filter(Boolean);
    yield* validateRecoveryPaths(target.path, untrackedPaths);

    const commonDirectory = yield* findGitCommonDirectory(target.path);
    const temporaryRoot = resolve(commonDirectory, "sandcastle-recovery-indexes");
    const temporaryIndex = resolve(temporaryRoot, randomUUID());
    const indexEnvironment = `GIT_INDEX_FILE=${temporaryIndex}`;
    yield* fileSystem
      .makeDirectory(temporaryRoot, { recursive: true })
      .pipe(mapExternalFailure("filesystem", `create ${temporaryRoot}`));

    snapshotCommit = yield* Effect.gen(function* () {
      yield* runRequired(["env", indexEnvironment, "git", "read-tree", localHead], target.path);
      // The temporary index keeps the live conflicted/staged index untouched. Adding
      // the complete worktree resolves conflict stages to their exact marker bytes
      // and includes every nonignored addition, modification, and deletion.
      yield* runRequired(["env", indexEnvironment, "git", "add", "-A", "--", "."], target.path);
      const tree = yield* runText(["env", indexEnvironment, "git", "write-tree"], target.path);
      return yield* runText(
        [
          "git",
          "commit-tree",
          tree,
          "-p",
          localHead,
          "-m",
          `chore: snapshot interrupted integration of ${target.branch}`,
        ],
        target.path,
      );
    }).pipe(
      Effect.ensuring(
        fileSystem.remove(temporaryIndex, { force: true }).pipe(Effect.catch(() => Effect.void)),
      ),
    );
  }

  const reference = recoveryReference(target.branch);
  yield* runRequired(["git", "update-ref", reference, snapshotCommit], target.path);
  yield* Effect.sync(() => globalThis.console.log(`  Recovery snapshot: ${reference}`));
  return { reference, untrackedPaths } satisfies RecoverySnapshot;
});

const removeSnapshottedUntrackedPaths = Effect.fn("removeSnapshottedUntrackedPaths")(function* (
  targetPath: string,
  paths: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const path of paths) {
    const absolutePath = containedRecoveryPath(targetPath, path);
    if (!absolutePath) {
      return yield* new WorkflowError({
        message: `Refusing to remove invalid snapshotted path '${path}'`,
        operation: "delivery.removeSnapshottedUntrackedPaths",
      });
    }
    yield* fileSystem
      .remove(absolutePath, { force: true })
      .pipe(mapExternalFailure("filesystem", `remove recovered path ${absolutePath}`));
  }
});

const reconcileTargetCheckpoint = Effect.fn("reconcileTargetCheckpoint")(function* (
  target: PreparedTarget,
) {
  const localHead = yield* runText(["git", "rev-parse", "HEAD"], target.path);
  const remoteHead = yield* remoteTargetHead(target.path, target.branch);
  const stored = yield* readTargetCheckpoint(target.path, target.branch);
  let checkpoint = stored.checkpoint;

  if (!checkpoint) {
    yield* ensureCleanWorktree(target.path);
    checkpoint = {
      version: 1,
      targetBranch: target.branch,
      safeSha: localHead,
      ...(remoteHead ? { publishedSha: remoteHead } : {}),
    };
    yield* writeTargetCheckpoint(target.path, checkpoint);
    return localHead;
  }

  // The remote ref is the durable publication proof. If the exact local HEAD is
  // already there and descends from our previous safe point, the push completed
  // even if the process crashed before replacing the checkpoint file.
  if (remoteHead === localHead && remoteHead !== checkpoint.safeSha) {
    if (!(yield* isAncestor(target.path, checkpoint.safeSha, remoteHead))) {
      return yield* checkpointMismatch(
        target.branch,
        `published commit ${remoteHead} does not descend from checkpoint ${checkpoint.safeSha}`,
      );
    }
    checkpoint = {
      version: 1,
      targetBranch: target.branch,
      safeSha: remoteHead,
      publishedSha: remoteHead,
    };
    yield* writeTargetCheckpoint(target.path, checkpoint);
    yield* ensureCleanWorktree(target.path);
    return remoteHead;
  }

  const mergeHead = yield* runProcess(
    ["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"],
    target.path,
  );
  const status = yield* worktreeStatus(target.path);
  const active = checkpoint.activeIntegration;

  if (!active) {
    if (mergeHead.exitCode === 0 || status) yield* ensureCleanWorktree(target.path);
    if (localHead !== checkpoint.safeSha) {
      return yield* checkpointMismatch(
        target.branch,
        `local HEAD ${localHead} differs from checkpoint ${checkpoint.safeSha} without an active Sandcastle integration`,
      );
    }
    if (remoteHead !== undefined && remoteHead !== checkpoint.publishedSha) {
      return yield* checkpointMismatch(
        target.branch,
        `remote HEAD moved from ${checkpoint.publishedSha ?? "an unpublished target"} to ${remoteHead}`,
      );
    }
    return localHead;
  }

  if (active.baseSha !== checkpoint.safeSha) {
    return yield* checkpointMismatch(
      target.branch,
      `active integration base ${active.baseSha} differs from checkpoint ${checkpoint.safeSha}`,
    );
  }
  if (remoteHead !== checkpoint.publishedSha) {
    return yield* checkpointMismatch(
      target.branch,
      `remote HEAD moved while integration of '${active.issueBranch}' was active`,
    );
  }
  yield* runRequired(["git", "cat-file", "-e", `${checkpoint.safeSha}^{commit}`], target.path);

  const needsReset =
    mergeHead.exitCode === 0 || Boolean(status) || localHead !== checkpoint.safeSha;
  if (needsReset) {
    const snapshot = yield* snapshotActiveRecovery(
      target,
      localHead,
      mergeHead.exitCode === 0 || Boolean(status),
    );
    yield* runRequired(["git", "reset", "--hard", checkpoint.safeSha], target.path);
    yield* removeSnapshottedUntrackedPaths(target.path, snapshot.untrackedPaths);
  }

  yield* ensureCleanWorktree(target.path);
  yield* writeTargetCheckpoint(target.path, {
    version: 1,
    targetBranch: checkpoint.targetBranch,
    safeSha: checkpoint.safeSha,
    ...(checkpoint.publishedSha ? { publishedSha: checkpoint.publishedSha } : {}),
  });
  return checkpoint.safeSha;
});

export const beginTargetIntegration = Effect.fn("beginTargetIntegration")(function* (
  target: PreparedTarget,
  expectedTargetHead: string,
  issueBranch: string,
) {
  const currentHead = yield* runText(["git", "rev-parse", "HEAD"], target.path);
  if (currentHead !== expectedTargetHead) {
    return yield* checkpointMismatch(
      target.branch,
      `local HEAD moved from expected integration base ${expectedTargetHead} to ${currentHead}`,
    );
  }
  yield* ensureCleanWorktree(target.path);
  const stored = yield* readTargetCheckpoint(target.path, target.branch);
  const initialRemoteHead = stored.checkpoint
    ? undefined
    : yield* remoteTargetHead(target.path, target.branch);
  const checkpoint =
    stored.checkpoint ??
    ({
      version: 1,
      targetBranch: target.branch,
      safeSha: expectedTargetHead,
      ...(initialRemoteHead ? { publishedSha: initialRemoteHead } : {}),
    } satisfies TargetCheckpoint);
  if (checkpoint.safeSha !== expectedTargetHead) {
    return yield* checkpointMismatch(
      target.branch,
      `integration base ${expectedTargetHead} differs from checkpoint ${checkpoint.safeSha}`,
    );
  }
  if (checkpoint.activeIntegration) {
    return yield* checkpointMismatch(
      target.branch,
      `integration of '${checkpoint.activeIntegration.issueBranch}' is already active`,
    );
  }
  yield* writeTargetCheckpoint(target.path, {
    ...checkpoint,
    activeIntegration: { baseSha: expectedTargetHead, issueBranch },
  });
});

export const publishTargetCommit = Effect.fn("publishTargetCommit")(function* (
  target: PreparedTarget,
  commit: string,
) {
  yield* runRequired(
    ["git", "push", "-u", "origin", `${commit}:refs/heads/${target.branch}`],
    target.path,
  );
  yield* writeTargetCheckpoint(target.path, {
    version: 1,
    targetBranch: target.branch,
    safeSha: commit,
    publishedSha: commit,
  });
});

export const prepareTarget = Effect.fn("prepareTarget")(function* (
  repositoryRoot: string,
  workstream: DeliveryWorkstream,
) {
  const { targetBranch, destinationBranch, sourceRevision } = workstream.delivery;
  yield* assertLocalBranchExists(repositoryRoot, targetBranch);
  yield* assertLocalBranchExists(repositoryRoot, destinationBranch);
  yield* runRequired(["git", "cat-file", "-e", `${sourceRevision}^{commit}`], repositoryRoot);

  const existing = (yield* listGitWorktrees(repositoryRoot)).find(
    ({ branch }) => branch === targetBranch,
  );
  if (existing) {
    const target = new PreparedTarget({
      baseSha: yield* runText(["git", "rev-parse", "HEAD"], existing.path),
      branch: targetBranch,
      path: existing.path,
    });
    const baseSha = yield* reconcileTargetCheckpoint(target);
    const attachedBranch = yield* runText(
      ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
      target.path,
    );
    if (attachedBranch !== targetBranch) {
      return yield* checkpointMismatch(
        targetBranch,
        `worktree '${target.path}' is attached to '${attachedBranch}', not '${targetBranch}'`,
      );
    }
    const recoveredHead = yield* runText(["git", "rev-parse", "HEAD"], target.path);
    if (recoveredHead !== baseSha) {
      return yield* checkpointMismatch(
        targetBranch,
        `recovered HEAD moved from ${baseSha} to ${recoveredHead}`,
      );
    }
    const ancestry = yield* runProcess(
      ["git", "merge-base", "--is-ancestor", sourceRevision, recoveredHead],
      target.path,
    );
    if (ancestry.exitCode !== 0) {
      return yield* new WorkflowError({
        message: `Source revision ${sourceRevision} is not an ancestor of '${targetBranch}'`,
        operation: "delivery.prepareTarget",
      });
    }
    return new PreparedTarget({ ...target, baseSha: recoveredHead });
  }

  const stored = yield* readTargetCheckpoint(repositoryRoot, targetBranch);
  if (stored.checkpoint?.activeIntegration) {
    return yield* checkpointMismatch(
      targetBranch,
      `an active integration exists but no worktree is attached to '${targetBranch}'`,
    );
  }

  const ancestry = yield* runProcess(
    ["git", "merge-base", "--is-ancestor", sourceRevision, targetBranch],
    repositoryRoot,
  );
  if (ancestry.exitCode !== 0) {
    return yield* new WorkflowError({
      message: `Source revision ${sourceRevision} is not an ancestor of '${targetBranch}'`,
      operation: "delivery.prepareTarget",
    });
  }

  // createWorktree has no AbortSignal; keep the target lock until creation settles.
  const worktree = yield* tryExternalPromise("sandcastle", "create target worktree", () =>
    createWorktree({
      branchStrategy: { type: "branch", branch: targetBranch, baseBranch: destinationBranch },
      cwd: repositoryRoot,
    }),
  ).pipe(Effect.uninterruptible);
  const target = new PreparedTarget({
    baseSha: yield* runText(["git", "rev-parse", "HEAD"], worktree.worktreePath),
    branch: targetBranch,
    path: worktree.worktreePath,
  });
  const baseSha = yield* reconcileTargetCheckpoint(target);
  const attachedBranch = yield* runText(
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    target.path,
  );
  if (attachedBranch !== targetBranch) {
    return yield* checkpointMismatch(
      targetBranch,
      `new worktree '${target.path}' is attached to '${attachedBranch}', not '${targetBranch}'`,
    );
  }
  return new PreparedTarget({ ...target, baseSha });
});

export const acquireTargetLock = Effect.fn("acquireTargetLock")(function* (
  repositoryRoot: string,
  targetBranch: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const lockId = createHash("sha256").update(targetBranch).digest("hex").slice(0, 16);
  const lockRoot = resolve(yield* findGitCommonDirectory(repositoryRoot), "sandcastle-locks");
  const lockPath = resolve(lockRoot, lockId);

  yield* fileSystem
    .makeDirectory(lockRoot, { recursive: true })
    .pipe(mapExternalFailure("filesystem", `create ${lockRoot}`));

  const tryClaim = (path: string) => {
    const candidatePath = `${path}.candidate-${randomUUID()}`;
    return Effect.gen(function* () {
      yield* fileSystem
        .writeFileString(candidatePath, lockOwner(targetBranch))
        .pipe(mapExternalFailure("filesystem", `write lock candidate ${candidatePath}`));
      return yield* fileSystem.link(candidatePath, path).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          cause.reason._tag === "AlreadyExists"
            ? Effect.succeed(false)
            : Effect.fail(cause).pipe(mapExternalFailure("filesystem", `claim ${path}`)),
        ),
      );
    }).pipe(
      Effect.ensuring(
        fileSystem.remove(candidatePath, { force: true }).pipe(Effect.catch(() => Effect.void)),
      ),
    );
  };
  const readOwner = (path: string) =>
    fileSystem.readFileString(path).pipe(
      // Read the legacy directory representation so a crash from an older
      // Sandcastle process cannot leave an unrecoverable target lock.
      Effect.catch(() =>
        fileSystem
          .readFileString(resolve(path, "owner"))
          .pipe(Effect.catch(() => Effect.succeed("unknown owner"))),
      ),
    );
  const failLocked = (owner: string) =>
    new WorkflowError({
      message: `Target '${targetBranch}' is already locked by ${owner.trim()}`,
      operation: "delivery.acquireTargetLock",
    });
  const recoveryPath = `${lockPath}.recovery`;

  if (yield* tryClaim(lockPath)) {
    if (!(yield* fileSystem.exists(recoveryPath))) return lockPath;
    // A recovery gate fences the brief interval where its owner quarantines
    // the stale lock. Relinquish this direct claim and contend for that gate.
    yield* fileSystem
      .remove(lockPath, { force: true })
      .pipe(mapExternalFailure("filesystem", `release fenced claim ${lockPath}`));
  }

  const observedOwner = yield* readOwner(lockPath);
  if (ownerProcessIsAlive(observedOwner)) return yield* failLocked(observedOwner);

  if (!(yield* tryClaim(recoveryPath))) {
    const recoveryOwner = yield* readOwner(recoveryPath);
    if (ownerProcessIsAlive(recoveryOwner)) {
      return yield* new WorkflowError({
        message: `Target '${targetBranch}' has a stale lock recovery in progress by ${recoveryOwner.trim()}`,
        operation: "delivery.acquireTargetLock",
      });
    }

    const orphanedRecoveryPath = `${recoveryPath}.stale-${randomUUID()}`;
    yield* fileSystem
      .rename(recoveryPath, orphanedRecoveryPath)
      .pipe(mapExternalFailure("filesystem", `quarantine stale recovery ${recoveryPath}`));
    yield* fileSystem
      .remove(orphanedRecoveryPath, { force: true, recursive: true })
      .pipe(mapExternalFailure("filesystem", `remove stale recovery ${orphanedRecoveryPath}`));

    if (!(yield* tryClaim(recoveryPath))) {
      const currentRecoveryOwner = yield* readOwner(recoveryPath);
      return yield* new WorkflowError({
        message: `Target '${targetBranch}' has a stale lock recovery in progress by ${currentRecoveryOwner.trim()}`,
        operation: "delivery.acquireTargetLock",
      });
    }
  }

  return yield* Effect.gen(function* () {
    if (yield* fileSystem.exists(lockPath)) {
      const currentOwner = yield* readOwner(lockPath);
      if (ownerProcessIsAlive(currentOwner)) return yield* failLocked(currentOwner);

      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      yield* fileSystem
        .rename(lockPath, stalePath)
        .pipe(mapExternalFailure("filesystem", `quarantine stale lock ${lockPath}`));
      yield* fileSystem
        .remove(stalePath, { force: true, recursive: true })
        .pipe(mapExternalFailure("filesystem", `remove stale lock ${stalePath}`));
    }

    if (!(yield* tryClaim(lockPath))) return yield* failLocked(yield* readOwner(lockPath));
    return lockPath;
  }).pipe(
    Effect.ensuring(
      fileSystem
        .remove(recoveryPath, { force: true, recursive: true })
        .pipe(Effect.catch(() => Effect.void)),
    ),
  );
});

export const releaseTargetLock = Effect.fn("releaseTargetLock")(function* (lockPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem
    .remove(lockPath, { force: true, recursive: true })
    .pipe(mapExternalFailure("filesystem", `remove ${lockPath}`));
});
