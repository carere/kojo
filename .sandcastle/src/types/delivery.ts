import { Effect, Schema, SchemaTransformation } from "effect";

export const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
export const DeliveryBranch = Schema.NonEmptyString;

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const StringArray = Schema.Array(Schema.String);

class Label extends Schema.Class<Label>("Label")({
  name: Schema.String,
}) {}

const LabelArray = Schema.Array(Label);

class Assignee extends Schema.Class<Assignee>("Assignee")({
  login: Schema.String,
}) {}

const AssigneeArray = Schema.Array(Assignee);

const CommentAuthor = Schema.Struct({ login: Schema.String });

class Comment extends Schema.Class<Comment>("Comment")({
  author: Schema.optional(Schema.NullOr(CommentAuthor)),
  body: Schema.String,
}) {}

const CommentArray = Schema.Array(Comment);

const RepositoryNameInput = Schema.Union([
  Schema.String,
  Schema.Struct({ nameWithOwner: Schema.String }),
]);

const RepositoryName = RepositoryNameInput.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform<string, typeof RepositoryNameInput.Type>({
      decode: (repository) =>
        typeof repository === "string" ? repository : repository.nameWithOwner,
      encode: (repository) => repository,
    }),
  ),
);

const IssueReferenceFields = {
  number: PositiveInteger,
  state: Schema.String,
  stateReason: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  repository: Schema.optional(RepositoryName),
};

const IssueReferenceStruct = Schema.Struct(IssueReferenceFields);

class IssueReference extends Schema.Class<IssueReference>("IssueReference")(IssueReferenceStruct) {}

const IssueReferenceArray = Schema.Array(IssueReference);

const IssueRelationsInput = Schema.Union([
  Schema.Array(IssueReferenceStruct),
  Schema.Struct({
    nodes: Schema.Array(IssueReferenceStruct),
    totalCount: NonNegativeInteger,
  }),
]);

class IssueRelations extends Schema.Class<IssueRelations>("IssueRelations")({
  nodes: IssueReferenceArray,
  totalCount: NonNegativeInteger,
}) {}

const IssueRelationsFromInput = IssueRelationsInput.pipe(
  Schema.decodeTo(
    IssueRelations,
    SchemaTransformation.transform<typeof IssueRelations.Encoded, typeof IssueRelationsInput.Type>({
      decode: (relations) =>
        "nodes" in relations ? relations : { nodes: relations, totalCount: relations.length },
      encode: (relations) => ({
        nodes: relations.nodes.map(({ repository, ...reference }) =>
          repository === undefined
            ? reference
            : {
                ...reference,
                repository: typeof repository === "string" ? repository : repository.nameWithOwner,
              },
        ),
        totalCount: relations.totalCount,
      }),
    }),
  ),
  Schema.withDecodingDefault(Effect.succeed({ nodes: [], totalCount: 0 })),
);

const ParentIssueReference = Schema.NullOr(IssueReferenceStruct).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
  Schema.decodeTo(Schema.NullOr(IssueReference)),
);

export class TrackerIssue extends Schema.Class<TrackerIssue>("TrackerIssue")({
  number: PositiveInteger,
  title: Schema.String,
  body: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  state: Schema.String,
  stateReason: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.String),
  labels: LabelArray.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  assignees: AssigneeArray.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  comments: CommentArray.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  parent: ParentIssueReference,
  blockedBy: IssueRelationsFromInput,
  subIssues: IssueRelationsFromInput,
}) {}

export const TrackerIssueArray = Schema.Array(TrackerIssue);

export class DeliveryMetadata extends Schema.Class<DeliveryMetadata>("DeliveryMetadata")({
  targetBranch: DeliveryBranch,
  destinationBranch: DeliveryBranch,
  sourceRevision: Schema.String,
}) {}

export class DeliveryWorkstream extends Schema.Class<DeliveryWorkstream>("DeliveryWorkstream")({
  kind: Schema.Literals(["root", "standalone"]),
  root: TrackerIssue,
  delivery: DeliveryMetadata,
  tickets: TrackerIssueArray,
  repository: Schema.optional(Schema.String),
  deliveryActor: Schema.optional(Schema.String),
}) {}

export class DeliveryOptions extends Schema.Class<DeliveryOptions>("DeliveryOptions")({
  root: Schema.optional(PositiveInteger),
  target: Schema.optional(DeliveryBranch),
  concurrency: PositiveInteger.pipe(Schema.withDecodingDefault(Effect.succeed(4))),
  maxIterations: PositiveInteger.pipe(Schema.withDecodingDefault(Effect.succeed(10))),
}) {}

export class ReviewDecision extends Schema.Class<ReviewDecision>("ReviewDecision")({
  readyToMerge: Schema.Boolean,
  summary: Schema.NonEmptyString,
  findings: StringArray.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
}) {}

export const IntegrationFailureKind = Schema.Literals(["merge-conflict", "failed-checks"]);

const PlannerIssueIdInput = Schema.Union([Schema.String, Schema.Number]);

const PlannerIssueId = PlannerIssueIdInput.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform<string, typeof PlannerIssueIdInput.Type>({
      decode: String,
      encode: (issueId) => issueId,
    }),
  ),
);

export class PlannerSelection extends Schema.Class<PlannerSelection>("PlannerSelection")({
  issueIds: Schema.Array(PlannerIssueId),
}) {}

class GitHubActor extends Schema.Class<GitHubActor>("GitHubActor")({
  login: Schema.String,
}) {}

const GitHubActorArray = Schema.Array(GitHubActor);

class PullRequestReview extends Schema.Class<PullRequestReview>("PullRequestReview")({
  author: Schema.optional(Schema.NullOr(GitHubActor)),
}) {}

const PullRequestReviewArray = Schema.Array(PullRequestReview);

const UrlString = Schema.String.check(Schema.makeFilter((value) => URL.canParse(value)));

class PullRequestIssueRepositoryOwner extends Schema.Class<PullRequestIssueRepositoryOwner>(
  "PullRequestIssueRepositoryOwner",
)({
  login: Schema.String,
}) {}

class PullRequestIssueRepository extends Schema.Class<PullRequestIssueRepository>(
  "PullRequestIssueRepository",
)({
  name: Schema.String,
  owner: PullRequestIssueRepositoryOwner,
}) {}

export class PullRequestClosingIssue extends Schema.Class<PullRequestClosingIssue>(
  "PullRequestClosingIssue",
)({
  number: PositiveInteger,
  repository: PullRequestIssueRepository,
  url: UrlString,
}) {}

const PullRequestClosingIssueArray = Schema.Array(PullRequestClosingIssue);

export class PullRequest extends Schema.Class<PullRequest>("PullRequest")({
  baseRefName: Schema.String,
  baseRefOid: Schema.optional(Schema.String),
  headRefName: Schema.String,
  headRefOid: Schema.optional(Schema.String),
  number: PositiveInteger,
  url: UrlString,
  title: Schema.String,
  body: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  closingIssuesReferences: PullRequestClosingIssueArray.pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  isDraft: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  autoMergeRequest: Schema.optional(Schema.NullOr(Schema.Unknown)),
  reviewRequests: GitHubActorArray.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  latestReviews: PullRequestReviewArray.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
}) {}

export const PullRequestArray = Schema.Array(PullRequest);

export class PreparedTarget extends Schema.Class<PreparedTarget>("PreparedTarget")({
  path: Schema.String,
  branch: DeliveryBranch,
  baseSha: Schema.String,
}) {}

export class ReviewedIssue extends Schema.Class<ReviewedIssue>("ReviewedIssue")({
  issue: TrackerIssue,
  branch: Schema.String,
  reviewedCommit: Schema.String,
  specificationFingerprint: Schema.String,
}) {}
