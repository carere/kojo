import {
  decodePayloadText as decodeWorkflowPayloadText,
  workflowLines as presentWorkflowLines,
  workflow as workflowCommand,
  timeoutMillis as workflowTimeoutMillis,
} from "../contexts/workflow/adapters/WorkflowCommand.ts";

export const workflow = workflowCommand;
export const workflowLines = presentWorkflowLines;
export const decodePayloadText = decodeWorkflowPayloadText;
export const timeoutMillis = workflowTimeoutMillis;
