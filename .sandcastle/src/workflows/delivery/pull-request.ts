import { Console, Effect, Exit } from "effect";
import { decodeJson } from "../../shared/decoding";
import { quoteShellArgument, runRequired, runText } from "../../shared/process";
import {
  type DeliveryWorkstream,
  PullRequest,
  PullRequestArray,
  type TrackerIssue,
} from "../../types/delivery";
import type { ExternalServiceError, ProcessError } from "../../types/errors";
import { WorkflowError } from "../../types/errors";
import { issueLabelNames } from "./issue";
import type { DeliveryRepository } from "./repository";

const DELIVERY_REVIEWER = "carere";
// gh pr list paginates in 100-item pages until it reaches this limit or the
// connection is exhausted. This 32-bit maximum makes exhaustion the practical
// stopping condition while staying portable across supported gh builds.
const ALL_OPEN_PULL_REQUESTS_LIMIT = "2147483647";
const PULL_REQUEST_FIELDS =
  "number,url,title,body,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,autoMergeRequest,closingIssuesReferences,reviewRequests,latestReviews";
const CONVENTIONAL_TITLE =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)]+\))?!?:\s+\S/;

const isConventionalPullRequestTitle = (title: string) => CONVENTIONAL_TITLE.test(title.trim());

const pullRequestType = (issue: TrackerIssue) => {
  const labels = new Set(issueLabelNames(issue).map((label) => label.toLowerCase()));
  if (labels.has("bug")) return "fix";
  if (labels.has("documentation") || labels.has("docs")) return "docs";
  for (const type of ["build", "chore", "ci", "perf", "refactor", "style", "test"] as const) {
    if (labels.has(type)) return type;
  }
  return "feat";
};

const conventionalPullRequestTitle = (issue: TrackerIssue) => {
  const title = issue.title.trim();
  if (isConventionalPullRequestTitle(title)) return title;
  return `${pullRequestType(issue)}: ${title.replace(/^delivery:\s*/i, "").trim()}`;
};

export const deliveryPullRequestContent = (workstream: DeliveryWorkstream) => {
  const preview = `\`\`\`sh
moon run sandcastle:preview -- start --branch ${quoteShellArgument(workstream.delivery.targetBranch)}
moon run sandcastle:preview -- stop --branch ${quoteShellArgument(workstream.delivery.targetBranch)}
\`\`\``;
  const marker = `<!-- sandcastle-delivery-root: #${workstream.root.number} -->`;
  const rootClosure = `Closes #${workstream.root.number}`;
  return {
    body: `${marker}
## Summary

Delivers #${workstream.root.number} from \`${workstream.delivery.targetBranch}\` into \`${workstream.delivery.destinationBranch}\`.

## Preview

${preview}

## Issue closed on merge

${rootClosure}`,
    marker,
    preview,
    rootClosure,
    title: conventionalPullRequestTitle(workstream.root),
  } as const;
};

export const listDeliveryPullRequests = Effect.fn("listDeliveryPullRequests")(function* (
  repository: DeliveryRepository,
) {
  const output = yield* runText(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      repository.githubName,
      "--state",
      "open",
      "--limit",
      ALL_OPEN_PULL_REQUESTS_LIMIT,
      "--json",
      PULL_REQUEST_FIELDS,
    ],
    repository.rootPath,
  );
  return yield* decodeJson(PullRequestArray, "gh pr list", output);
});

const loadManagedPullRequestForCurrentRoute = Effect.fn("loadManagedPullRequestForCurrentRoute")(
  function* (repository: DeliveryRepository, workstream: DeliveryWorkstream, operation: string) {
    const existing = (yield* listDeliveryPullRequests(repository)).filter(
      ({ baseRefName, headRefName }) =>
        baseRefName === workstream.delivery.destinationBranch &&
        headRefName === workstream.delivery.targetBranch,
    );
    if (existing.length > 1) {
      return yield* new WorkflowError({
        message: `Multiple open pull requests target '${workstream.delivery.destinationBranch}' from '${workstream.delivery.targetBranch}'`,
        operation,
      });
    }

    const pullRequest = existing[0];
    const rootMarkers = pullRequest ? managedDeliveryRootMarkers(pullRequest.body) : [];
    if (pullRequest && (rootMarkers.length !== 1 || rootMarkers[0] !== workstream.root.number)) {
      return yield* new WorkflowError({
        message: `Existing PR #${pullRequest.number} is not exclusively owned by delivery root #${workstream.root.number}`,
        operation,
      });
    }
    return pullRequest;
  },
);

const ISSUE_REFERENCE_PATTERN =
  "(?:https?://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/\\d+|(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#\\d+)";
const CLOSING_REFERENCE_PATTERN = `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:\\s*:\\s*|\\s+)(${ISSUE_REFERENCE_PATTERN})\\b`;
const closingReference = new RegExp(CLOSING_REFERENCE_PATTERN, "gi");
const closingReferenceLine = new RegExp(`^\\s*${CLOSING_REFERENCE_PATTERN}[.!]?\\s*$`, "i");

const closingReferencesIn = (value: string) =>
  Array.from(
    value.matchAll(new RegExp(CLOSING_REFERENCE_PATTERN, "gi")),
    (match) => match[1] ?? "",
  );

const isRootReference = (
  reference: string,
  repository: DeliveryRepository,
  workstream: DeliveryWorkstream,
) => {
  const rootNumber = workstream.root.number;
  const bare = /^#(\d+)$/.exec(reference);
  if (bare) return Number(bare[1]) === rootNumber;

  const qualified = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(reference);
  if (qualified) {
    return (
      qualified[1]?.toLowerCase() === repository.githubName.toLowerCase() &&
      Number(qualified[2]) === rootNumber
    );
  }

  const fullUrl =
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)$/i.exec(reference);
  return (
    fullUrl?.[1]?.toLowerCase() === repository.githubName.toLowerCase() &&
    Number(fullUrl[2]) === rootNumber
  );
};

const withoutClosingReferences = (body: string) =>
  body
    .split("\n")
    .map((line) =>
      closingReferenceLine.test(line)
        ? ""
        : line.replace(closingReference, (_match, reference: string) => `References ${reference}`),
    )
    .join("\n")
    .trimEnd();

const managedDeliveryRootMarkers = (body: string) =>
  Array.from(body.matchAll(/<!--\s*sandcastle-delivery-root:\s*#(\d+)\s*-->/gi), (match) =>
    Number(match[1]),
  ).filter((rootNumber) => Number.isSafeInteger(rootNumber) && rootNumber > 0);

const holdKnownPullRequest = Effect.fn("holdKnownPullRequest")(function* (
  repository: DeliveryRepository,
  pullRequest: PullRequest,
  forceDraft = false,
) {
  const mutationAttempts: Array<
    Exit.Exit<unknown, ExternalServiceError | ProcessError | WorkflowError>
  > = [];
  if (forceDraft || !pullRequest.isDraft) {
    mutationAttempts.push(
      yield* runRequired(
        [
          "gh",
          "pr",
          "ready",
          String(pullRequest.number),
          "--repo",
          repository.githubName,
          "--undo",
        ],
        repository.rootPath,
      ).pipe(Effect.exit),
    );
  }

  const heldBody = withoutClosingReferences(pullRequest.body);
  if (heldBody !== pullRequest.body) {
    mutationAttempts.push(
      yield* runRequired(
        [
          "gh",
          "pr",
          "edit",
          String(pullRequest.number),
          "--repo",
          repository.githubName,
          "--body",
          heldBody,
        ],
        repository.rootPath,
      ).pipe(Effect.exit),
    );
  }
  const failure = mutationAttempts.find(Exit.isFailure);
  if (failure) return yield* Effect.failCause(failure.cause);
  yield* Console.log(`Pull request held for recovery: ${pullRequest.url}`);
});

const holdPullRequests = Effect.fn("holdPullRequests")(function* (
  repository: DeliveryRepository,
  matches: (pullRequest: PullRequest) => boolean,
) {
  const pullRequests = (yield* listDeliveryPullRequests(repository)).filter(matches);
  const attempts = yield* Effect.forEach(
    pullRequests,
    (pullRequest) => holdKnownPullRequest(repository, pullRequest).pipe(Effect.exit),
    { concurrency: 1 },
  );
  const failure = attempts.find(Exit.isFailure);
  if (failure) return yield* Effect.failCause(failure.cause);
});

export const holdDeliveryPullRequest = Effect.fn("holdDeliveryPullRequest")(function* (
  repository: DeliveryRepository,
  workstream: DeliveryWorkstream,
) {
  yield* holdPullRequests(repository, ({ body }) =>
    managedDeliveryRootMarkers(body).includes(workstream.root.number),
  );
});

export const holdDeliveryPullRequestsBeforeDiscovery = Effect.fn(
  "holdDeliveryPullRequestsBeforeDiscovery",
)(function* (repository: DeliveryRepository, selectedRoot?: number) {
  yield* holdPullRequests(repository, ({ body }) => {
    const rootNumbers = managedDeliveryRootMarkers(body);
    return selectedRoot === undefined ? rootNumbers.length > 0 : rootNumbers.includes(selectedRoot);
  });
});

const reviewerAlreadyHandled = (pullRequest: PullRequest) =>
  pullRequest.reviewRequests.some(
    ({ login }) => login.toLowerCase() === DELIVERY_REVIEWER.toLowerCase(),
  ) ||
  pullRequest.latestReviews.some(
    ({ author }) => author?.login.toLowerCase() === DELIVERY_REVIEWER.toLowerCase(),
  );

const validateTargetCommitClosures = Effect.fn("validateTargetCommitClosures")(function* (
  repository: DeliveryRepository,
  workstream: DeliveryWorkstream,
  destinationOid: string,
  verifiedTargetOid: string,
) {
  const messages = yield* runText(
    ["git", "log", "--format=%B%x00", `${destinationOid}..${verifiedTargetOid}`, "--"],
    repository.rootPath,
  );
  const unsafe = closingReferencesIn(messages).filter(
    (reference) => !isRootReference(reference, repository, workstream),
  );
  if (unsafe.length > 0) {
    return yield* new WorkflowError({
      message: `Target '${workstream.delivery.targetBranch}' contains commit closing references outside delivery root #${workstream.root.number}: ${unsafe.join(", ")}`,
      operation: "delivery.ensurePullRequest",
    });
  }
});

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const currentRemoteBranchOid = Effect.fn("currentRemoteBranchOid")(function* (
  repository: DeliveryRepository,
  branch: string,
) {
  const reference = `refs/heads/${branch}`;
  const output = yield* runText(
    ["git", "ls-remote", "--exit-code", "origin", reference],
    repository.rootPath,
  );
  const [oid, reportedReference, ...extra] = output.split(/\s+/);
  if (!oid || !OBJECT_ID.test(oid) || reportedReference !== reference || extra.length > 0) {
    return yield* new WorkflowError({
      message: `Remote branch '${branch}' did not resolve to exactly one valid object ID`,
      operation: "delivery.ensurePullRequest",
    });
  }
  return oid;
});

const reloadPullRequest = Effect.fn("reloadPullRequest")(function* (
  repository: DeliveryRepository,
  identifier: number | string,
) {
  const output = yield* runText(
    [
      "gh",
      "pr",
      "view",
      String(identifier),
      "--repo",
      repository.githubName,
      "--json",
      PULL_REQUEST_FIELDS,
    ],
    repository.rootPath,
  );
  return yield* decodeJson(PullRequest, "gh pr view", output);
});

const validateReadyPullRequest = Effect.fn("validateReadyPullRequest")(function* (
  repository: DeliveryRepository,
  workstream: DeliveryWorkstream,
  pullRequest: PullRequest,
  verifiedTargetOid: string,
  destinationOid: string,
  expectedDraft: boolean,
) {
  const { marker, rootClosure } = deliveryPullRequestContent(workstream);
  const rootMarkers = managedDeliveryRootMarkers(pullRequest.body);
  const bodyReferences = closingReferencesIn(pullRequest.body);
  const linkedIssues = pullRequest.closingIssuesReferences;
  const linksOnlyRoot = linkedIssues.every(
    ({ number, repository: linkedRepository }) =>
      number === workstream.root.number &&
      `${linkedRepository.owner.login}/${linkedRepository.name}`.toLowerCase() ===
        repository.githubName.toLowerCase(),
  );
  if (
    pullRequest.isDraft !== expectedDraft ||
    pullRequest.baseRefName !== workstream.delivery.destinationBranch ||
    !pullRequest.baseRefOid ||
    !OBJECT_ID.test(pullRequest.baseRefOid) ||
    pullRequest.baseRefOid !== destinationOid ||
    pullRequest.headRefName !== workstream.delivery.targetBranch ||
    !pullRequest.headRefOid ||
    !OBJECT_ID.test(pullRequest.headRefOid) ||
    pullRequest.headRefOid !== verifiedTargetOid ||
    pullRequest.autoMergeRequest != null ||
    rootMarkers.length !== 1 ||
    rootMarkers[0] !== workstream.root.number ||
    !pullRequest.body.includes(marker) ||
    !pullRequest.body.includes(rootClosure) ||
    bodyReferences.length !== 1 ||
    !isRootReference(bodyReferences[0] ?? "", repository, workstream) ||
    linkedIssues.length !== 1 ||
    !linksOnlyRoot
  ) {
    return yield* new WorkflowError({
      message: `Pull request #${pullRequest.number} cannot be readied because its route or issue-closing references do not exclusively target delivery root #${workstream.root.number}`,
      operation: "delivery.ensurePullRequest",
    });
  }
});

const markPullRequestReady = Effect.fn("markPullRequestReady")(function* (
  repository: DeliveryRepository,
  workstream: DeliveryWorkstream,
  pullRequest: PullRequest,
  verifiedTargetOid: string,
  destinationOid: string,
) {
  const ready = yield* runRequired(
    ["gh", "pr", "ready", String(pullRequest.number), "--repo", repository.githubName],
    repository.rootPath,
  ).pipe(Effect.exit);
  if (Exit.isFailure(ready)) {
    yield* holdKnownPullRequest(repository, pullRequest, true);
    return yield* Effect.failCause(ready.cause);
  }
  const reload = yield* reloadPullRequest(repository, pullRequest.number).pipe(Effect.exit);
  if (Exit.isFailure(reload)) {
    yield* holdKnownPullRequest(repository, pullRequest, true);
    return yield* Effect.failCause(reload.cause);
  }
  const validation = yield* validateReadyPullRequest(
    repository,
    workstream,
    reload.value,
    verifiedTargetOid,
    destinationOid,
    false,
  ).pipe(Effect.exit);
  if (Exit.isFailure(validation)) {
    yield* holdKnownPullRequest(repository, reload.value);
    return yield* Effect.failCause(validation.cause);
  }
});

export const ensureDeliveryPullRequest = Effect.fn("ensureDeliveryPullRequest")(function* (
  repository: DeliveryRepository,
  workstream: DeliveryWorkstream,
  verifiedTargetOid: string,
) {
  const { body, preview, rootClosure, title } = deliveryPullRequestContent(workstream);
  if (workstream.delivery.destinationBranch !== repository.defaultBranch) {
    return yield* new WorkflowError({
      message: `Delivery destination '${workstream.delivery.destinationBranch}' is not the repository default branch '${repository.defaultBranch}'. GitHub only applies Closes references when a PR targets the default branch.`,
      operation: "delivery.ensurePullRequest",
    });
  }
  if (!OBJECT_ID.test(verifiedTargetOid)) {
    return yield* new WorkflowError({
      message: `Verified target '${verifiedTargetOid}' is not a valid object ID`,
      operation: "delivery.ensurePullRequest",
    });
  }
  const destinationOid = yield* currentRemoteBranchOid(
    repository,
    workstream.delivery.destinationBranch,
  );
  yield* validateTargetCommitClosures(repository, workstream, destinationOid, verifiedTargetOid);

  const pullRequest = yield* loadManagedPullRequestForCurrentRoute(
    repository,
    workstream,
    "delivery.ensurePullRequest",
  );
  if (pullRequest) {
    if (!pullRequest.isDraft) {
      yield* runRequired(
        [
          "gh",
          "pr",
          "ready",
          String(pullRequest.number),
          "--repo",
          repository.githubName,
          "--undo",
        ],
        repository.rootPath,
      );
    }

    let updatedBody = withoutClosingReferences(pullRequest.body);
    if (!updatedBody.includes(preview)) updatedBody += `\n\n## Preview\n\n${preview}`;
    updatedBody += `\n\n${rootClosure}`;
    const edit = [
      "gh",
      "pr",
      "edit",
      String(pullRequest.number),
      "--repo",
      repository.githubName,
      "--title",
      title,
      "--body",
      updatedBody,
    ];
    if (!reviewerAlreadyHandled(pullRequest)) edit.push("--add-reviewer", DELIVERY_REVIEWER);
    yield* runRequired(edit, repository.rootPath);
    const refreshed = yield* reloadPullRequest(repository, pullRequest.number);
    yield* validateReadyPullRequest(
      repository,
      workstream,
      refreshed,
      verifiedTargetOid,
      destinationOid,
      true,
    );
    yield* markPullRequestReady(
      repository,
      workstream,
      refreshed,
      verifiedTargetOid,
      destinationOid,
    );

    yield* Console.log(`Pull request ready: ${pullRequest.url}`);
    return pullRequest.url;
  }

  const url = yield* runText(
    [
      "gh",
      "pr",
      "create",
      "--repo",
      repository.githubName,
      "--base",
      workstream.delivery.destinationBranch,
      "--head",
      workstream.delivery.targetBranch,
      "--title",
      title,
      "--body",
      body,
      "--reviewer",
      DELIVERY_REVIEWER,
      "--draft",
    ],
    repository.rootPath,
  );
  const created = yield* reloadPullRequest(repository, url);
  yield* validateReadyPullRequest(
    repository,
    workstream,
    created,
    verifiedTargetOid,
    destinationOid,
    true,
  );
  yield* markPullRequestReady(repository, workstream, created, verifiedTargetOid, destinationOid);
  yield* Console.log(`Pull request ready: ${url}`);
  return url;
});
