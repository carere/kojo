import { fileURLToPath } from "node:url";
import { linkDevelopmentRuntime } from "../contexts/project/adapters/linkDevelopmentRuntime.ts";

const project = process.argv[2];
if (project === undefined || process.argv.length !== 3) {
  console.error("Usage: moon run kojo:link-runtime -- /absolute/path/to/project");
  process.exitCode = 2;
} else {
  try {
    for (const line of linkDevelopmentRuntime(
      project,
      fileURLToPath(new URL("../../", import.meta.url)),
    ))
      console.log(line);
    console.log(
      "Project manifests are unchanged. Run this command again after bun install replaces the links.",
    );
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
