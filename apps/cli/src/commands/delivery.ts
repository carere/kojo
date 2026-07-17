import { resolve } from "node:path";
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";

const project = Argument.directory("project", { mustExist: true }).pipe(
  Argument.withDescription("Path to the project whose delivery workflow should run"),
);

export const deliveryCommand = Command.make("delivery", { project }, ({ project }) =>
  Effect.logWarning(`Delivery workflow extraction is pending for ${resolve(project)}`),
).pipe(Command.withDescription("Run the delivery workflow directly for a project"));
