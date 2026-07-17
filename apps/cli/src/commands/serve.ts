import { Argument, Command, Flag } from "effect/unstable/cli";
import { runServer } from "../server";

const project = Argument.directory("project", { mustExist: true }).pipe(
  Argument.withDescription("Path to the project managed by this Kojo server"),
);

const port = Flag.integer("port").pipe(
  Flag.withDefault(3000),
  Flag.withDescription("Port on which the Kojo server listens"),
);

export const serveCommand = Command.make("serve", { port, project }, ({ port, project }) =>
  runServer({ port, project }),
).pipe(Command.withDescription("Start the webhook and visualizer server for a project"));
