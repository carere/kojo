import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import {
  requiresFullEvidence,
  selectPredecessor,
} from "../../packages/kojo/src/scripts/release/ReleasePolicy.ts";
import { parseReleaseVersion } from "../../packages/kojo/src/scripts/release/ReleaseVersion.ts";

const run = (command: string[]): string => {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command[0]} ${command[1]} failed.`);
  return result.stdout.toString().trim();
};
const version = process.env.RELEASE_VERSION ?? "";
const release = parseReleaseVersion(version);
if (process.env.GITHUB_REF !== "refs/heads/main") {
  throw new Error("Start the Release workflow from main.");
}
if (run(["git", "status", "--porcelain"]) !== "") throw new Error("Release checkout is not clean.");
const sourceRevision = run(["git", "rev-parse", "HEAD"]);
const current = JSON.parse(readFileSync("packages/kojo/package.json", "utf8")).version as string;
if (Bun.semver.order(version, current) <= 0)
  throw new Error(`${version} must be newer than ${current}.`);
const repository = process.env.GITHUB_REPOSITORY;
if (!repository) throw new Error("GITHUB_REPOSITORY is required.");
const releases = JSON.parse(
  run(["gh", "api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]),
) as Array<
  Array<{ draft: boolean; prerelease: boolean; tag_name: string; assets: Array<{ name: string }> }>
>;
const acceptedVersions = releases
  .flat()
  .filter(
    (item) =>
      !item.draft &&
      item.prerelease &&
      item.assets.some((asset) => asset.name === "release-manifest.json"),
  )
  .map((item) => item.tag_name.replace(/^v/, ""));
const predecessor = selectPredecessor(version, acceptedVersions);
mkdirSync(".release-train/previous", { recursive: true });
if (predecessor !== undefined) {
  run([
    "gh",
    "release",
    "download",
    `v${predecessor}`,
    "--repo",
    repository,
    "--pattern",
    "release-manifest.json",
    "--dir",
    ".release-train/previous",
  ]);
  run([
    "bash",
    ".github/scripts/verify-accepted-prerelease.sh",
    ".release-train/previous/release-manifest.json",
  ]);
}
// Refuse an already used version before Cocogitto creates immutable tags.
run(["bun", ".github/scripts/release-train.ts", "assert-unpublished", version]);
run(["cog", "bump", "--version", version, "--include-packages"]);
const revision = run(["git", "rev-parse", "HEAD"]);
run([
  "bun",
  ".github/scripts/release-train.ts",
  release.stage === "stable" ? "validate-stable" : "validate-prerelease",
  ...(release.stage === "stable" ? [] : [release.stage]),
  version,
  predecessor ?? "",
]);
if (release.stage === "stable") {
  run([
    "bun",
    ".github/scripts/release-train.ts",
    "validate-stable-source",
    ".release-train/previous/release-manifest.json",
    revision,
  ]);
}
// A bundle lets every validation job use the generated commit, even in a dry run. No remote refs
// need to change before validation succeeds. The workflow event SHA is the source, not this commit.
run(["git", "bundle", "create", ".release-train/source.bundle", "--all"]);
const output = process.env.GITHUB_OUTPUT;
if (!output) throw new Error("GITHUB_OUTPUT is required.");
appendFileSync(
  output,
  `revision=${revision}\nsource_revision=${sourceRevision}\nstage=${release.stage}\nfull_evidence=${requiresFullEvidence(version)}\n`,
);
