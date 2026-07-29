import { ProjectIdentity } from "@kojo/workflow";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
export const CONTROL_CAPABILITIES = ["projects:list"] as const;

export const ControlCapability = Schema.Literals(CONTROL_CAPABILITIES);
export type ControlCapability = typeof ControlCapability.Type;

export const ProtocolVersion = Schema.Struct({
  major: Schema.Number,
  minor: Schema.Number,
});

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

export const KojoControl = RpcGroup.make(Negotiate, ListProjects);
