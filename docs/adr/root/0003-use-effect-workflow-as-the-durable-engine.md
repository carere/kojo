---
status: accepted
---

# Use Effect Workflow as the durable execution engine

Kojo uses Effect Workflow's complete unstable durable engine as the authority for workflow execution, including Activity replay, suspension, resume, nested executions, and recovery. This replaces both a Kojo-owned workflow engine and the lighter option of using Effect Workflow only as an authoring and orchestration API; Kojo will pin the unstable dependency while reopened decisions define its process ownership, public lifecycle, and durable record.
