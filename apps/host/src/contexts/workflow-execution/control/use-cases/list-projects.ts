import type { ProjectList } from "@kojo/control";
import { Effect } from "effect";
import { ProjectIndex } from "../../../workflow-authoring/projects/services/project-index";

export const listProjects: Effect.Effect<ProjectList, never, ProjectIndex> = Effect.gen(
  function* () {
    const index = yield* ProjectIndex;
    return { projects: yield* index.list };
  },
);
