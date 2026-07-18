export type RunStatus = "idle" | "running" | "interrupted" | "succeeded" | "discarded";
export type SandboxStatus = "absent" | "active" | "must-recreate" | "closed";
export type NextAction =
  | "start"
  | "create-sandbox"
  | "agent-step"
  | "code-step"
  | "finish"
  | "done";
export type Step = "Agent Step" | "Code Step";

export interface PrototypeState {
  durable: {
    storage: "SQLite (simulated)";
    runStatus: RunStatus;
    workflowRevision: string;
    nextAction: NextAction;
    lastCompletedStep: Step | null;
    sandboxName: string;
    branch: string;
    sandboxStatus: SandboxStatus;
    sandboxInstance: number;
    lastSavedCommit: string | null;
  };
  process: {
    online: boolean;
    startCount: number;
    sandboxReference: string | null;
    inFlightStep: Step | null;
    workingFiles: "saved" | "uncommitted AI changes";
  };
  sandcastle: {
    possiblyOrphanedSandboxes: number;
  };
  message: string;
}

export type Action =
  | { type: "begin" }
  | { type: "create-sandbox" }
  | { type: "agent-step" }
  | { type: "code-step" }
  | { type: "record-step" }
  | { type: "crash" }
  | { type: "crash-during-create" }
  | { type: "restart" }
  | { type: "succeed" }
  | { type: "discard" }
  | { type: "reset" };

export const initialState = (): PrototypeState => ({
  durable: {
    storage: "SQLite (simulated)",
    runStatus: "idle",
    workflowRevision: "delivery@1 / fingerprint abc123",
    nextAction: "start",
    lastCompletedStep: null,
    sandboxName: "delivery",
    branch: "kojo/run-42/delivery",
    sandboxStatus: "absent",
    sandboxInstance: 0,
    lastSavedCommit: null,
  },
  process: {
    online: true,
    startCount: 1,
    sandboxReference: null,
    inFlightStep: null,
    workingFiles: "saved",
  },
  sandcastle: {
    possiblyOrphanedSandboxes: 0,
  },
  message: "Start a Workflow Run. SQLite will remember which action should happen next.",
});

const withMessage = (state: PrototypeState, message: string): PrototypeState => ({
  ...state,
  message,
});

const expectedStep = (nextAction: NextAction): Step | null => {
  if (nextAction === "agent-step") return "Agent Step";
  if (nextAction === "code-step") return "Code Step";
  return null;
};

const canUseSandbox = (state: PrototypeState): boolean =>
  state.process.online &&
  state.process.sandboxReference !== null &&
  state.durable.runStatus === "running" &&
  state.durable.sandboxStatus === "active";

const runStep = (state: PrototypeState, step: Step): PrototypeState => {
  if (!canUseSandbox(state)) {
    return withMessage(state, `${step} cannot run until Kojo has created a fresh Sandbox.`);
  }
  if (expectedStep(state.durable.nextAction) !== step) {
    return withMessage(
      state,
      `${step} is not next. SQLite says to ${describeNextAction(state.durable.nextAction)}.`,
    );
  }
  if (state.process.inFlightStep !== null) {
    return withMessage(
      state,
      `${state.process.inFlightStep} is already in progress. Record its result first.`,
    );
  }

  return {
    ...state,
    process: {
      ...state.process,
      inFlightStep: step,
      workingFiles: "uncommitted AI changes",
    },
    message:
      `${step} produced uncommitted AI changes. SQLite still says ${step} is next ` +
      "until the committed result is recorded.",
  };
};

const nextCommit = (state: PrototypeState): string => {
  const ordinal = state.durable.lastCompletedStep === null ? 1 : 2;
  return `commit-${String(ordinal).padStart(2, "0")}`;
};

export const describeNextAction = (action: NextAction): string =>
  ({
    start: "start the Workflow Run",
    "create-sandbox": "create the shared Sandbox",
    "agent-step": "run the Agent Step",
    "code-step": "run the Code Step",
    finish: "finish the Workflow Run and close the Sandbox",
    done: "do nothing; the Workflow Run is finished",
  })[action];

export const transition = (state: PrototypeState, action: Action): PrototypeState => {
  switch (action.type) {
    case "begin":
      if (state.durable.nextAction !== "start" || !state.process.online) {
        return withMessage(state, "This Workflow Run cannot be started from its current state.");
      }
      return {
        ...state,
        durable: {
          ...state.durable,
          runStatus: "running",
          nextAction: "create-sandbox",
        },
        message:
          "SQLite recorded the Workflow Run and says the next action is to create its shared Sandbox.",
      };

    case "create-sandbox": {
      if (!state.process.online || state.durable.runStatus !== "running") {
        return withMessage(state, "Start Kojo and the Workflow Run before creating a Sandbox.");
      }
      if (
        state.durable.sandboxStatus !== "absent" &&
        state.durable.sandboxStatus !== "must-recreate"
      ) {
        return withMessage(state, "This Kojo process already has a usable Sandbox.");
      }
      if (
        state.durable.sandboxStatus === "absent" &&
        state.durable.nextAction !== "create-sandbox"
      ) {
        return withMessage(state, "SQLite does not currently ask Kojo to create a Sandbox.");
      }

      const firstCreation = state.durable.nextAction === "create-sandbox";
      const instance = state.durable.sandboxInstance + 1;
      return {
        ...state,
        durable: {
          ...state.durable,
          nextAction: firstCreation ? "agent-step" : state.durable.nextAction,
          sandboxStatus: "active",
          sandboxInstance: instance,
        },
        process: {
          ...state.process,
          sandboxReference: `temporary Sandbox object #${instance}`,
          workingFiles: "saved",
        },
        message:
          instance === 1
            ? "Sandcastle returned a temporary Sandbox object. Agent and Code Steps can reuse it while Kojo keeps running."
            : `Sandcastle created Sandbox #${instance} from branch ${state.durable.branch} at ${state.durable.lastSavedCommit ?? "its base commit"}.`,
      };
    }

    case "agent-step":
      return runStep(state, "Agent Step");

    case "code-step":
      return runStep(state, "Code Step");

    case "record-step": {
      const step = state.process.inFlightStep;
      if (step === null || !canUseSandbox(state)) {
        return withMessage(state, "There is no completed Step result to commit and record.");
      }

      const commit = nextCommit(state);
      return {
        ...state,
        durable: {
          ...state.durable,
          lastCompletedStep: step,
          lastSavedCommit: commit,
          nextAction: step === "Agent Step" ? "code-step" : "finish",
        },
        process: {
          ...state.process,
          inFlightStep: null,
          workingFiles: "saved",
        },
        message:
          `${step} committed its changes as ${commit}. SQLite recorded the completed Step ` +
          `and now says to ${describeNextAction(step === "Agent Step" ? "code-step" : "finish")}.`,
      };
    }

    case "crash": {
      if (!state.process.online) {
        return withMessage(state, "Kojo is already stopped.");
      }

      const lostStep = state.process.inFlightStep;
      const lostReference = state.process.sandboxReference !== null;
      return {
        ...state,
        durable: {
          ...state.durable,
          runStatus:
            state.durable.runStatus === "running" ? "interrupted" : state.durable.runStatus,
          sandboxStatus: lostReference ? "must-recreate" : state.durable.sandboxStatus,
        },
        process: {
          ...state.process,
          online: false,
          sandboxReference: null,
          inFlightStep: null,
          workingFiles: "saved",
        },
        sandcastle: {
          possiblyOrphanedSandboxes:
            state.sandcastle.possiblyOrphanedSandboxes + (lostReference ? 1 : 0),
        },
        message:
          lostStep === null
            ? "Kojo stopped and lost the Sandbox object. SQLite still remembers the next action and the branch."
            : `${lostStep}'s uncommitted AI changes were lost. SQLite still says ${lostStep} is next, so Kojo will rerun it.`,
      };
    }

    case "crash-during-create":
      if (
        !state.process.online ||
        state.durable.runStatus !== "running" ||
        state.durable.nextAction !== "create-sandbox"
      ) {
        return withMessage(
          state,
          "This scenario requires a running Workflow Run that is ready to create its Sandbox.",
        );
      }
      return {
        ...state,
        durable: {
          ...state.durable,
          runStatus: "interrupted",
          sandboxStatus: "must-recreate",
        },
        process: {
          ...state.process,
          online: false,
          sandboxReference: null,
        },
        sandcastle: {
          possiblyOrphanedSandboxes: state.sandcastle.possiblyOrphanedSandboxes + 1,
        },
        message:
          "Sandcastle may have created a Sandbox, but Kojo stopped before receiving the object. SQLite still says creation is next.",
      };

    case "restart":
      if (state.process.online) {
        return withMessage(state, "Kojo is already running.");
      }
      return {
        ...state,
        durable: {
          ...state.durable,
          runStatus:
            state.durable.runStatus === "interrupted" ? "running" : state.durable.runStatus,
        },
        process: {
          ...state.process,
          online: true,
          startCount: state.process.startCount + 1,
          sandboxReference: null,
          inFlightStep: null,
          workingFiles: "saved",
        },
        message:
          `Kojo loaded the Workflow Run from SQLite. It still needs to ` +
          `${describeNextAction(state.durable.nextAction)}, but must create a fresh Sandbox first.`,
      };

    case "succeed":
      if (
        state.durable.nextAction !== "finish" ||
        !canUseSandbox(state) ||
        state.process.inFlightStep !== null
      ) {
        return withMessage(
          state,
          "The Workflow Run can finish only after both Steps are recorded and a Sandbox is active.",
        );
      }
      return {
        ...state,
        durable: {
          ...state.durable,
          runStatus: "succeeded",
          nextAction: "done",
          sandboxStatus: "closed",
        },
        process: {
          ...state.process,
          sandboxReference: null,
        },
        message:
          "The Workflow Run finished. Kojo used the temporary object to ask Sandcastle to close the current Sandbox.",
      };

    case "discard":
      if (!["running", "interrupted"].includes(state.durable.runStatus)) {
        return withMessage(state, "Only an unfinished Workflow Run can be discarded.");
      }
      return {
        ...state,
        durable: {
          ...state.durable,
          runStatus: "discarded",
          nextAction: "done",
          sandboxStatus: "closed",
        },
        process: {
          ...state.process,
          sandboxReference: null,
          inFlightStep: null,
          workingFiles: "saved",
        },
        message:
          state.process.sandboxReference === null
            ? "The Workflow Run was discarded. Kojo had no Sandbox object left to close."
            : "The Workflow Run was discarded, and Kojo closed the current Sandbox before releasing its object.",
      };

    case "reset":
      return initialState();
  }
};
