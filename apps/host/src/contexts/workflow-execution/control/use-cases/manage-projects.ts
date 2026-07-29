import type { ProjectIdentity } from "@kojo/control";
import { Effect } from "effect";
import { ProjectIndex } from "../../../workflow-authoring/projects/services/project-index";

export const showProject = (identity: ProjectIdentity) =>
  Effect.flatMap(ProjectIndex, (index) => index.show(identity));

export const registerProject = (path: string) =>
  Effect.flatMap(ProjectIndex, (index) => index.register(path));

export const forgetProject = (identity: ProjectIdentity) =>
  Effect.flatMap(ProjectIndex, (index) => index.forget(identity));
