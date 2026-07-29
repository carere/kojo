import type { ProjectList } from "@kojo/control";
import { Effect } from "effect";

export const listProjects: Effect.Effect<ProjectList> = Effect.succeed({ projects: [] });
