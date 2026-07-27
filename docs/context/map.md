# Context Map

## Contexts

- [Workflow Authoring](./workflow-authoring.md): defines Kojo Projects, the workflows developers make available, and the schedules that may trigger them
- [Workflow Execution](./workflow-execution.md): runs workflow definitions, controls their lifecycle, and records what happened

## Relationships

- **Workflow Authoring -> Workflow Execution**: Workflow Authoring owns the Kojo Project, Workflow Definition, and Workflow Schedule language. Workflow Execution loads definitions from an initialized project, manages operational schedule state and occurrences, and records the definition identity used by each Workflow Run.
- **Workflow Execution -> Visualizer and CLI**: Workflow Execution exposes run state, execution traces, and lifecycle controls. The visualizer and CLI are user-facing adapters over that behavior rather than domain contexts.
