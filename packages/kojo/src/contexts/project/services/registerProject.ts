import { Effect } from "effect";
import type { RegisterProjectRequest } from "../models/Project.ts";
import { ProjectRepository } from "../ports/ProjectRepository.ts";

/** Register one exact Project location through the catalogue port. */
export const registerProject = (request: RegisterProjectRequest) =>
  Effect.flatMap(ProjectRepository, (repository) => repository.register(request));
