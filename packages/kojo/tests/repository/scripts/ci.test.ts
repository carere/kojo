import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Job {
  readonly needs?: string | string[];
  readonly steps?: Array<{ readonly run?: string }>;
}

const workflow = (file: string) =>
  Bun.YAML.parse(
    readFileSync(new URL(`../../../../../.github/workflows/${file}.yml`, import.meta.url), "utf8"),
  ) as { jobs: Record<string, Job> };

describe("CI completion", () => {
  const required = workflow("ci").jobs.required;
  const command = required?.steps?.map((step) => step.run ?? "").join("\n");
  if (!command) throw new Error("The required check has no executable result check.");

  // Execute the real result check. Its wording and shell layout can change freely.
  for (const core of ["success", "failure", "cancelled", "skipped"]) {
    it.each(["success", "failure", "cancelled", "skipped"])(
      `reports core=${core}, integration=%s`,
      (integration) => {
        const result = spawnSync("bash", ["-e", "-c", command], {
          env: { ...process.env, CORE_RESULT: core, INTEGRATION_RESULT: integration },
          encoding: "utf8",
        });
        expect(result.status === 0).toBe(core === "success" && integration === "success");
      },
    );
  }

  it("joins independent core and integration work before collecting release evidence", () => {
    const jobs = workflow("release-checks").jobs;
    expect(jobs.ci?.needs).toBeUndefined();
    expect(jobs.integration?.needs).toBeUndefined();
    expect(jobs["core-evidence"]?.needs).toEqual(expect.arrayContaining(["ci", "integration"]));
    expect(required?.needs).toEqual(expect.arrayContaining(["ci", "integration"]));
  });
});
