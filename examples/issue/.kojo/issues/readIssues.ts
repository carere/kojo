import { Workspace } from "@carere/kojo-runtime/contexts/sandbox/ports/Workspace";
import { Effect, Schema } from "effect";

const GithubIssue = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  repository_url: Schema.String,
});

export const IssueRequest = Schema.Struct({
  repository: Schema.String,
  issue: Schema.Number,
  branch: Schema.String,
  base: Schema.String,
});

export const Issue = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  title: Schema.String,
  body: Schema.String,
  blockedBy: Schema.Array(Schema.Number),
});

export const IssuePlan = Schema.Struct({
  mode: Schema.Literals(["single", "graph"]),
  issues: Schema.Array(Issue),
  title: Schema.String,
  url: Schema.String,
});

export class IssueRequestFailed extends Schema.TaggedError<IssueRequestFailed>()(
  "IssueRequestFailed",
  {
    message: Schema.String,
  },
) {}

/** GitHub pagination stays inside one recorded planning Phase. */
export const readIssues = (request: typeof IssueRequest.Type) =>
  Effect.gen(function* () {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository) ||
      !Number.isSafeInteger(request.issue) ||
      request.issue < 1
    )
      return yield* new IssueRequestFailed({
        message: "Use repository owner/name and a positive issue number.",
      });
    const workspace = yield* Workspace;
    const endpoint = `repos/${request.repository}/issues`;
    const list = (path: string) =>
      Effect.gen(function* () {
        const response = yield* workspace.exec(["gh", "api", "--paginate", "--slurp", path]);
        if (!response.succeeded)
          return yield* new IssueRequestFailed({
            message: `Cannot read ${path}. Run gh auth status and check repository access.`,
          });
        const parsed = yield* Effect.try({
          try: () => JSON.parse(response.stdout) as unknown,
          catch: () =>
            new IssueRequestFailed({ message: `GitHub returned invalid JSON for ${path}.` }),
        });
        return yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Array(GithubIssue)))(
          parsed,
        ).pipe(
          Effect.map((pages) => pages.flat()),
          Effect.mapError(
            () =>
              new IssueRequestFailed({
                message: `GitHub returned an invalid issue list for ${path}.`,
              }),
          ),
        );
      });
    const response = yield* workspace.exec(["gh", "api", `${endpoint}/${request.issue}`]);
    if (!response.succeeded)
      return yield* new IssueRequestFailed({
        message: "Cannot read the selected issue. Run gh auth status and check repository access.",
      });
    const parsed = yield* Effect.try({
      try: () => JSON.parse(response.stdout) as unknown,
      catch: () =>
        new IssueRequestFailed({ message: "GitHub returned invalid JSON for the selected issue." }),
    });
    const parent = yield* Schema.decodeUnknownEffect(GithubIssue)(parsed).pipe(
      Effect.mapError(
        () => new IssueRequestFailed({ message: "GitHub returned an invalid selected issue." }),
      ),
    );
    const children = yield* list(`${endpoint}/${request.issue}/sub_issues`);
    const selected = children.length === 0 ? [parent] : children;
    const issues = yield* Effect.forEach(selected, (issue) =>
      Effect.gen(function* () {
        if (
          issue.repository_url.toLowerCase() !==
          `https://api.github.com/repos/${request.repository}`.toLowerCase()
        )
          return yield* new IssueRequestFailed({
            message: `Child ${issue.html_url} belongs to another repository. This example uses one repository per Run.`,
          });
        const blockers = yield* list(`${endpoint}/${issue.number}/dependencies/blocked_by`);
        const external = blockers.find(
          (blocker) => blocker.repository_url.toLowerCase() !== issue.repository_url.toLowerCase(),
        );
        if (external !== undefined)
          return yield* new IssueRequestFailed({
            message: `Issue ${issue.html_url} is blocked by external issue ${external.html_url}. Resolve that blocker before starting this Run.`,
          });
        return {
          number: issue.number,
          url: issue.html_url,
          title: issue.title,
          body: issue.body ?? "",
          blockedBy: blockers.map((blocker) => blocker.number),
        };
      }),
    );
    return {
      mode: children.length === 0 ? ("single" as const) : ("graph" as const),
      issues,
      title: parent.title,
      url: parent.html_url,
    };
  });
