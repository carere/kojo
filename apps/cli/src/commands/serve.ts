import { Command, Flag } from "effect/unstable/cli";
import { runServer } from "../server";

const port = Flag.integer("port").pipe(
  Flag.withDefault(3000),
  Flag.withDescription("Port on which the Kojo server listens"),
);

export const serveCommand = Command.make("serve", { port }, ({ port }) => runServer({ port })).pipe(
  Command.withDescription("Serve the Dense Inspector API for the local System Process"),
);
