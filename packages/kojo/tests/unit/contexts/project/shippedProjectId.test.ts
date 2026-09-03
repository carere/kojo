import { describe, expect, it } from "vitest";
import { shippedProjectId } from "../../../support/release/ShippedMacosEvidence.ts";

describe("shipped macOS Project identity evidence", () => {
  it("accepts the same UUID Project ID from register and list output", () => {
    const projectId = "65a70f2b-600f-426e-847e-4bb04a202638";
    const registered = [
      "request 5aa06a3d-9004-4fec-91eb-59aeb07e2b9d",
      `registered Project ${projectId}`,
      "Factory available. No Workflow was started.",
      "",
    ].join("\n");
    const listed = `${projectId}\tavailable\tavailable\tsteady\tactive-location\t/project\n`;

    expect(shippedProjectId(registered, listed)).toBe(projectId);
  });

  it("rejects different Project identities from register and list output", () => {
    const registered = [
      "request 5aa06a3d-9004-4fec-91eb-59aeb07e2b9d",
      "registered Project 65a70f2b-600f-426e-847e-4bb04a202638",
      "Factory available. No Workflow was started.",
      "",
    ].join("\n");
    const listed =
      "d7690374-54ec-46b8-9dd6-c4b50e98147c\tavailable\tavailable\tsteady\tactive-location\t/project\n";

    expect(() => shippedProjectId(registered, listed)).toThrow(
      "shipped Project identity differs between registration (65a70f2b-600f-426e-847e-4bb04a202638) and list (d7690374-54ec-46b8-9dd6-c4b50e98147c)",
    );
  });
});
