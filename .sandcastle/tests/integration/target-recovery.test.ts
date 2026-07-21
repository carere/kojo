import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Schema } from "effect";
import { DeliveryMetadata, DeliveryWorkstream, TrackerIssue } from "../../src/types/delivery";
import {
  beginTargetIntegration,
  prepareTarget,
  publishTargetCommit,
} from "../../src/workflows/delivery/target";
import { runEffect, runFailure } from "../helpers/effect";
import { runGit } from "../helpers/git";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const withBunServices = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  runEffect(effect.pipe(Effect.provide(BunServices.layer)));

const decodeIssue = Schema.decodeUnknownSync(TrackerIssue);

const recoveryRefs = (repository: string) =>
  runGit(repository, "for-each-ref", "--format=%(refname)", "refs/sandcastle/recovery/").then(
    (output) => output.split("\n").filter(Boolean),
  );

const createTargetRepository = async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-target-recovery-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const repository = join(root, "repository");
  await runGit(root, "init", "--bare", remote);
  await runGit(root, "init", "--initial-branch=main", repository);
  await runGit(repository, "config", "user.email", "sandcastle@example.test");
  await runGit(repository, "config", "user.name", "Sandcastle Test");
  await Bun.write(join(repository, "shared.txt"), "base\n");
  await Bun.write(join(repository, "delete-me.txt"), "restore after recovery\n");
  await runGit(repository, "add", "shared.txt", "delete-me.txt");
  await runGit(repository, "commit", "-m", "test: base");
  const sourceRevision = await runGit(repository, "rev-parse", "HEAD");
  await runGit(repository, "remote", "add", "origin", remote);
  await runGit(repository, "push", "-u", "origin", "main");
  await runGit(repository, "switch", "-c", "feat/delivery");
  await runGit(repository, "push", "-u", "origin", "feat/delivery");

  const rootIssue = decodeIssue({
    number: 10,
    title: "Delivery: retry boundary",
    body: "",
    state: "OPEN",
    labels: [],
    assignees: [],
    comments: [],
    parent: null,
    blockedBy: [],
    subIssues: [{ number: 42, title: "Issue 42", state: "OPEN" }],
  });
  const issue = decodeIssue({
    number: 42,
    title: "Issue 42",
    body: "",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    comments: [],
    parent: { number: 10, title: rootIssue.title, state: "OPEN" },
    blockedBy: [],
    subIssues: [],
  });
  const workstream = new DeliveryWorkstream({
    delivery: new DeliveryMetadata({
      destinationBranch: "main",
      sourceRevision,
      targetBranch: "feat/delivery",
    }),
    kind: "root",
    root: rootIssue,
    tickets: [issue],
  });
  return { issueBranch: "sandcastle/workstream-10/issue-42", remote, repository, workstream };
};

describe("delivery target recovery", () => {
  test("retains a clean reviewed integration with stale merge metadata", async () => {
    const { issueBranch, repository, workstream } = await createTargetRepository();
    await runGit(repository, "switch", "-c", issueBranch, workstream.delivery.sourceRevision);
    await Bun.write(join(repository, "integrated.txt"), "reviewed issue\n");
    await runGit(repository, "add", "integrated.txt");
    await runGit(repository, "commit", "-m", "feat: reviewed issue");
    const issueHead = await runGit(repository, "rev-parse", "HEAD");
    await runGit(repository, "switch", "feat/delivery");

    const target = await withBunServices(prepareTarget(repository, workstream));
    const safeHead = await runGit(repository, "rev-parse", "HEAD");
    await withBunServices(beginTargetIntegration(target, safeHead, issueBranch));
    await runGit(repository, "merge", "--no-ff", "-m", "feat: integrate reviewed issue", issueHead);
    await Bun.write(join(repository, "post-merge-repair.txt"), "reviewed repair\n");
    await runGit(repository, "add", "post-merge-repair.txt");
    await runGit(repository, "commit", "-m", "fix: reviewed integration");
    const reviewedHead = await runGit(repository, "rev-parse", "HEAD");

    await Bun.write(join(repository, ".git", "MERGE_HEAD"), `${issueHead}\n`);
    await Bun.write(join(repository, ".git", "MERGE_MODE"), "no-ff\n");
    await Bun.write(join(repository, ".git", "MERGE_MSG"), "stale completed merge\n");

    const recovered = await withBunServices(prepareTarget(repository, workstream));
    const repeated = await withBunServices(prepareTarget(repository, workstream));
    const mergeHead = Bun.spawn(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd: repository,
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(recovered.baseSha).toBe(reviewedHead);
    expect(repeated.baseSha).toBe(reviewedHead);
    expect(await runGit(repository, "rev-parse", "HEAD")).toBe(reviewedHead);
    expect(await mergeHead.exited).not.toBe(0);
    expect(await recoveryRefs(repository)).toEqual([]);
  });

  test("rewinds a rejected clean integration before retrying", async () => {
    const { issueBranch, repository, workstream } = await createTargetRepository();
    const target = await withBunServices(prepareTarget(repository, workstream));
    const safeHead = await runGit(repository, "rev-parse", "HEAD");
    await withBunServices(beginTargetIntegration(target, safeHead, issueBranch));
    await Bun.write(join(repository, "repair.txt"), "rejected repair\n");
    await runGit(repository, "add", "repair.txt");
    await runGit(repository, "commit", "-m", "fix: rejected repair");
    const rejectedHead = await runGit(repository, "rev-parse", "HEAD");

    const retriedTarget = await withBunServices(prepareTarget(repository, workstream));
    const [recoveryRef] = await recoveryRefs(repository);

    expect(await runGit(repository, "rev-parse", "HEAD")).toBe(safeHead);
    expect(await Bun.file(join(repository, "repair.txt")).exists()).toBe(false);
    expect(retriedTarget.baseSha).toBe(safeHead);
    expect(recoveryRef).toBeDefined();
    if (!recoveryRef) throw new Error("expected a recovery ref");
    expect(await runGit(repository, "rev-parse", recoveryRef)).toBe(rejectedHead);
    expect(await runGit(repository, "show", `${recoveryRef}:repair.txt`)).toBe("rejected repair");
  });

  test("aborts a Sandcastle-owned conflicted merge back to the safe checkpoint", async () => {
    const { issueBranch, repository, workstream } = await createTargetRepository();
    const safeTarget = await withBunServices(prepareTarget(repository, workstream));
    const sourceRevision = workstream.delivery.sourceRevision;
    await runGit(repository, "switch", "-c", issueBranch, sourceRevision);
    await Bun.write(join(repository, "shared.txt"), "issue\n");
    await runGit(repository, "add", "shared.txt");
    await runGit(repository, "commit", "-m", "feat: conflicting issue");
    await runGit(repository, "switch", "feat/delivery");
    await Bun.write(join(repository, "shared.txt"), "target\n");
    await runGit(repository, "add", "shared.txt");
    await runGit(repository, "commit", "-m", "feat: conflicting target");
    await runGit(repository, "push", "origin", "feat/delivery");
    const safeHead = await runGit(repository, "rev-parse", "HEAD");
    await withBunServices(publishTargetCommit(safeTarget, safeHead));
    const target = await withBunServices(prepareTarget(repository, workstream));
    await withBunServices(beginTargetIntegration(target, safeHead, issueBranch));
    const merge = Bun.spawn(["git", "merge", "--no-ff", "--no-edit", issueBranch], {
      cwd: repository,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await merge.exited).not.toBe(0);

    await withBunServices(prepareTarget(repository, workstream));

    expect(await runGit(repository, "rev-parse", "HEAD")).toBe(safeHead);
    expect(await runGit(repository, "status", "--porcelain", "--untracked-files=all")).toBe("");
    const mergeHead = Bun.spawn(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd: repository,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await mergeHead.exited).not.toBe(0);
    const [recoveryRef] = await recoveryRefs(repository);
    expect(recoveryRef).toBeDefined();
    expect(await runGit(repository, "show", `${recoveryRef}:shared.txt`)).toContain("<<<<<<< HEAD");
  });

  test("snapshots tracked and untracked inspection edits before owned recovery", async () => {
    const { issueBranch, repository, workstream } = await createTargetRepository();
    const target = await withBunServices(prepareTarget(repository, workstream));
    const safeHead = await runGit(repository, "rev-parse", "HEAD");
    await withBunServices(beginTargetIntegration(target, safeHead, issueBranch));
    await Bun.write(join(repository, "shared.txt"), "failed repair edit\n");
    await Bun.write(join(repository, "user-notes.txt"), "keep these exact bytes\n");
    await rm(join(repository, "delete-me.txt"));

    const recovered = await withBunServices(prepareTarget(repository, workstream));
    const [recoveryRef] = await recoveryRefs(repository);

    expect(recovered.baseSha).toBe(safeHead);
    expect(await Bun.file(join(repository, "shared.txt")).text()).toBe("base\n");
    expect(await Bun.file(join(repository, "user-notes.txt")).exists()).toBe(false);
    expect(await Bun.file(join(repository, "delete-me.txt")).text()).toBe(
      "restore after recovery\n",
    );
    expect(await runGit(repository, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(recoveryRef).toBeDefined();
    expect(await runGit(repository, "show", `${recoveryRef}:shared.txt`)).toBe(
      "failed repair edit",
    );
    expect(await runGit(repository, "show", `${recoveryRef}:user-notes.txt`)).toBe(
      "keep these exact bytes",
    );
    expect(await runGit(repository, "ls-tree", "-r", "--name-only", recoveryRef)).not.toContain(
      "delete-me.txt",
    );
  });

  test("refuses owned recovery when an untracked embedded repository cannot be snapshotted", async () => {
    const { issueBranch, repository, workstream } = await createTargetRepository();
    const target = await withBunServices(prepareTarget(repository, workstream));
    const safeHead = await runGit(repository, "rev-parse", "HEAD");
    await withBunServices(beginTargetIntegration(target, safeHead, issueBranch));

    const embeddedRepository = join(repository, "inspection-repository");
    await runGit(repository, "init", "--initial-branch=main", embeddedRepository);
    await runGit(embeddedRepository, "config", "user.email", "inspector@example.test");
    await runGit(embeddedRepository, "config", "user.name", "Inspector");
    await Bun.write(join(embeddedRepository, "tracked.txt"), "committed bytes\n");
    await runGit(embeddedRepository, "add", "tracked.txt");
    await runGit(embeddedRepository, "commit", "-m", "test: embedded repository");
    const embeddedHead = await runGit(embeddedRepository, "rev-parse", "HEAD");
    const embeddedHeadFile = await Bun.file(join(embeddedRepository, ".git", "HEAD")).text();
    await Bun.write(join(embeddedRepository, "tracked.txt"), "dirty tracked bytes\n");
    await Bun.write(join(embeddedRepository, "untracked.txt"), "untracked bytes\n");

    const failure = await runFailure(
      prepareTarget(repository, workstream).pipe(Effect.provide(BunServices.layer)),
    );

    expect(failure).toMatchObject({
      _tag: "WorkflowError",
      operation: "delivery.snapshotActiveRecovery",
    });
    expect((failure as Error).message).toContain("inspection-repository/");
    expect(await runGit(repository, "rev-parse", "HEAD")).toBe(safeHead);
    expect(await Bun.file(join(embeddedRepository, "tracked.txt")).text()).toBe(
      "dirty tracked bytes\n",
    );
    expect(await Bun.file(join(embeddedRepository, "untracked.txt")).text()).toBe(
      "untracked bytes\n",
    );
    expect(await Bun.file(join(embeddedRepository, ".git", "HEAD")).text()).toBe(embeddedHeadFile);
    expect(await runGit(embeddedRepository, "rev-parse", "HEAD")).toBe(embeddedHead);
    await runGit(embeddedRepository, "cat-file", "-e", `${embeddedHead}^{commit}`);
    expect(await recoveryRefs(repository)).toEqual([]);

    const repeatedFailure = await runFailure(
      prepareTarget(repository, workstream).pipe(Effect.provide(BunServices.layer)),
    );
    expect(repeatedFailure).toMatchObject({
      _tag: "WorkflowError",
      operation: "delivery.snapshotActiveRecovery",
    });
  });

  test("refuses arbitrary dirty edits at the safe checkpoint without deleting them", async () => {
    const { repository, workstream } = await createTargetRepository();
    await withBunServices(prepareTarget(repository, workstream));
    await Bun.write(join(repository, "shared.txt"), "user edit\n");

    const failure = await runFailure(
      prepareTarget(repository, workstream).pipe(Effect.provide(BunServices.layer)),
    );

    expect(failure).toMatchObject({
      _tag: "WorkflowError",
      operation: "delivery.ensureCleanWorktree",
    });
    expect(await Bun.file(join(repository, "shared.txt")).text()).toBe("user edit\n");
    expect(await recoveryRefs(repository)).toEqual([]);
  });

  test("recovers an active target moved outside source ancestry", async () => {
    const { issueBranch, repository, workstream } = await createTargetRepository();
    await runGit(repository, "switch", "--orphan", "unrelated-history");
    await Bun.write(join(repository, "unrelated.txt"), "unrelated root\n");
    await runGit(repository, "add", "unrelated.txt");
    await runGit(repository, "commit", "-m", "test: unrelated history");
    const unrelatedHead = await runGit(repository, "rev-parse", "HEAD");
    await runGit(repository, "switch", "feat/delivery");
    const target = await withBunServices(prepareTarget(repository, workstream));
    const safeHead = await runGit(repository, "rev-parse", "HEAD");
    await withBunServices(beginTargetIntegration(target, safeHead, issueBranch));
    await runGit(repository, "reset", "--hard", unrelatedHead);

    const recovered = await withBunServices(prepareTarget(repository, workstream));
    const [recoveryRef] = await recoveryRefs(repository);

    expect(recovered.baseSha).toBe(safeHead);
    expect(await runGit(repository, "rev-parse", "HEAD")).toBe(safeHead);
    expect(await runGit(repository, "symbolic-ref", "--short", "HEAD")).toBe("feat/delivery");
    if (!recoveryRef) throw new Error("expected a recovery ref");
    expect(await runGit(repository, "rev-parse", recoveryRef)).toBe(unrelatedHead);
  });

  test("refuses recovery when an active target worktree was switched to another branch", async () => {
    const { issueBranch, repository, workstream } = await createTargetRepository();
    const target = await withBunServices(prepareTarget(repository, workstream));
    const safeHead = await runGit(repository, "rev-parse", "HEAD");
    await withBunServices(beginTargetIntegration(target, safeHead, issueBranch));
    await runGit(repository, "switch", "-c", "inspection-branch");
    await Bun.write(join(repository, "inspection.txt"), "do not discard\n");

    const failure = await runFailure(
      prepareTarget(repository, workstream).pipe(Effect.provide(BunServices.layer)),
    );

    expect(failure).toMatchObject({
      _tag: "WorkflowError",
      operation: "delivery.reconcileTargetCheckpoint",
    });
    expect(await runGit(repository, "symbolic-ref", "--short", "HEAD")).toBe("inspection-branch");
    expect(await Bun.file(join(repository, "inspection.txt")).text()).toBe("do not discard\n");
    expect(await recoveryRefs(repository)).toEqual([]);
  });

  test("adopts a remote-published head when the process crashed before checkpointing it", async () => {
    const { issueBranch, repository, workstream } = await createTargetRepository();
    const target = await withBunServices(prepareTarget(repository, workstream));
    const safeHead = await runGit(repository, "rev-parse", "HEAD");
    await withBunServices(beginTargetIntegration(target, safeHead, issueBranch));
    await Bun.write(join(repository, "published.txt"), "published before crash\n");
    await runGit(repository, "add", "published.txt");
    await runGit(repository, "commit", "-m", "feat: published before checkpoint");
    const publishedHead = await runGit(repository, "rev-parse", "HEAD");
    await runGit(repository, "push", "origin", `HEAD:refs/heads/${target.branch}`);

    const recovered = await withBunServices(prepareTarget(repository, workstream));
    await withBunServices(beginTargetIntegration(recovered, publishedHead, issueBranch));

    expect(await runGit(repository, "rev-parse", "HEAD")).toBe(publishedHead);
  });

  test("does not advance the checkpoint when publication fails", async () => {
    const { issueBranch, remote, repository, workstream } = await createTargetRepository();
    const target = await withBunServices(prepareTarget(repository, workstream));
    const safeHead = await runGit(repository, "rev-parse", "HEAD");
    await withBunServices(beginTargetIntegration(target, safeHead, issueBranch));
    await Bun.write(join(repository, "unpublished.txt"), "not published\n");
    await runGit(repository, "add", "unpublished.txt");
    await runGit(repository, "commit", "-m", "feat: unpublished integration");
    const unpublishedHead = await runGit(repository, "rev-parse", "HEAD");
    await runGit(repository, "remote", "set-url", "origin", join(repository, "missing.git"));

    const publication = await withBunServices(
      publishTargetCommit(target, unpublishedHead).pipe(Effect.exit),
    );
    expect(Exit.isFailure(publication)).toBe(true);
    await runGit(repository, "remote", "set-url", "origin", remote);

    await withBunServices(prepareTarget(repository, workstream));

    expect(await runGit(repository, "rev-parse", "HEAD")).toBe(safeHead);
    expect(await Bun.file(join(repository, "unpublished.txt")).exists()).toBe(false);
  });
});
