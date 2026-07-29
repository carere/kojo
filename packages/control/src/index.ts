import { ProjectIdentity } from "@kojo/workflow";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export { ProjectIdentity } from "@kojo/workflow";

export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
export const CONTROL_CAPABILITIES = [
  "projects:list",
  "projects:show",
  "projects:register",
  "projects:forget",
] as const;

export const ControlCapability = Schema.Literals(CONTROL_CAPABILITIES);
export type ControlCapability = typeof ControlCapability.Type;

export const ProtocolVersion = Schema.Struct({
  major: Schema.Number,
  minor: Schema.Number,
});

export const RequestKey = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, {
    expected: "a full Request Key",
  }),
).pipe(Schema.brand("RequestKey"));
export type RequestKey = typeof RequestKey.Type;

export const HostInformation = Schema.Struct({
  protocol: ProtocolVersion,
  hostVersion: Schema.String,
  capabilities: Schema.Array(ControlCapability),
});
export type HostInformation = typeof HostInformation.Type;

export const ProjectSnapshot = Schema.Struct({
  identity: ProjectIdentity,
  path: Schema.String,
});
export type ProjectSnapshot = typeof ProjectSnapshot.Type;

export const ProjectList = Schema.Struct({
  projects: Schema.Array(ProjectSnapshot),
});
export type ProjectList = typeof ProjectList.Type;

export const ProjectOperationError = Schema.Struct({
  code: Schema.Literals([
    "project-not-found",
    "project-identity-duplicate",
    "project-layout-invalid",
    "project-forget-blocked",
    "request-key-conflict",
  ]),
  message: Schema.String,
  next: Schema.String,
});
export type ProjectOperationError = typeof ProjectOperationError.Type;

export const ProjectQueryResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), project: ProjectSnapshot }),
  Schema.Struct({ ok: Schema.Literal(false), error: ProjectOperationError }),
]);
export type ProjectQueryResult = typeof ProjectQueryResult.Type;

export const ProjectMutationResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    project: ProjectSnapshot,
    alreadyApplied: Schema.Boolean,
    requestKey: RequestKey,
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: ProjectOperationError }),
]);
export type ProjectMutationResult = typeof ProjectMutationResult.Type;

export const HostOverview = Schema.Struct({
  host: HostInformation,
  projects: Schema.Array(ProjectSnapshot),
});
export type HostOverview = typeof HostOverview.Type;

export const Negotiate = Rpc.make("Negotiate", {
  success: HostInformation,
});

export const ListProjects = Rpc.make("ListProjects", {
  success: ProjectList,
});

export const ShowProject = Rpc.make("ShowProject", {
  payload: { identity: ProjectIdentity },
  success: ProjectQueryResult,
});

export const RegisterProject = Rpc.make("RegisterProject", {
  payload: { path: Schema.String, requestKey: RequestKey },
  success: ProjectMutationResult,
});

export const ForgetProject = Rpc.make("ForgetProject", {
  payload: { identity: ProjectIdentity, requestKey: RequestKey },
  success: ProjectMutationResult,
});

export const KojoControl = RpcGroup.make(
  Negotiate,
  ListProjects,
  ShowProject,
  RegisterProject,
  ForgetProject,
);
