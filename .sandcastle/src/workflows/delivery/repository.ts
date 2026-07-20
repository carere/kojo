import { Effect, Schema } from "effect";
import { decodeJson } from "../../shared/decoding";
import { findRepositoryRoot } from "../../shared/git";
import { runRequired, runText } from "../../shared/process";
import { WorkflowError } from "../../types/errors";

const GitHubRepositoryInfo = Schema.Struct({
  defaultBranchRef: Schema.Struct({ name: Schema.String }),
  nameWithOwner: Schema.String,
});

export interface DeliveryRepository {
  readonly defaultBranch: string;
  readonly githubLogin?: string;
  readonly githubName: string;
  readonly rootPath: string;
}

export const resolveDeliveryRepository = Effect.fn("resolveDeliveryRepository")(function* () {
  const rootPath = yield* findRepositoryRoot();
  yield* runRequired(["gh", "auth", "status"], rootPath);
  const repositoryInfo = yield* runText(
    ["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
    rootPath,
  );
  const decoded = yield* decodeJson(GitHubRepositoryInfo, "gh repo view", repositoryInfo);
  const githubLogin = yield* runText(["gh", "api", "user", "--jq", ".login"], rootPath);
  if (!githubLogin) {
    return yield* new WorkflowError({
      message: "GitHub authentication did not identify the delivery actor",
      operation: "delivery.resolveDeliveryRepository",
    });
  }
  return {
    defaultBranch: decoded.defaultBranchRef.name,
    githubLogin,
    githubName: decoded.nameWithOwner,
    rootPath,
  } satisfies DeliveryRepository;
});
