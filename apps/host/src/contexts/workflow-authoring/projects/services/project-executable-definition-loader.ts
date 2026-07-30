import { pathToFileURL } from "node:url";
import type { ProjectDefinitionSnapshot } from "@kojo/control/project-definition-validation";
import { validateProjectDefinitionValue } from "@kojo/control/project-definition-validation";
import type { AnyWorkflowDefinition } from "@kojo/workflow";

/**
 * Loads executable Project code only after the Project Runtime has accepted the
 * corresponding serializable Definition Snapshot. This is deliberately a Host
 * adapter: handlers never cross the public control contract.
 */
export const loadExecutableWorkflowDefinitions = async (
  configurationPath: string,
  accepted: ProjectDefinitionSnapshot,
): Promise<ReadonlyArray<AnyWorkflowDefinition>> => {
  const location = pathToFileURL(configurationPath);
  location.searchParams.set("kojo-runtime", crypto.randomUUID());
  const configuration = (await import(location.href)).default;
  const validation = validateProjectDefinitionValue(configuration);
  if (!validation.ok || validation.snapshot.snapshotId !== accepted.snapshotId) {
    throw new Error("Executable Workflow Definitions do not match the accepted Project snapshot");
  }
  return configuration.workflows as ReadonlyArray<AnyWorkflowDefinition>;
};
