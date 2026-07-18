export interface Story {
  readonly title: string;
  readonly question: string;
  readonly snippet: string;
  readonly conclusion: string;
}

export interface PrototypeState {
  readonly storyIndex: number;
}

export type Action =
  | { readonly type: "next-story" }
  | { readonly type: "previous-story" }
  | { readonly type: "reset" };

export const publicSurface: ReadonlyArray<string> = [
  "Workflow.make / workflow.run",
  "Loop.run",
  "Sandbox.use",
  "Agent.run",
  "Command.run",
];

export const stories: ReadonlyArray<Story> = [
  {
    title: "1. Define and recursively invoke a Workflow",
    question:
      "Can one Workflow primitive represent both root and nested durable runs without hiding ordinary Effect composition?",
    snippet: `export const Delivery = Workflow.make("delivery", {
  version: "1",
  input: DeliveryInput,
  success: DeliveryResult,
  failure: DeliveryFailure,
  idempotencyKey: ({ issue }) => issue.url,
  run: deliver
})

export const Factory = Workflow.make("factory", {
  version: "1",
  input: FactoryInput,
  success: DeliveryResult,
  failure: FactoryFailure,
  idempotencyKey: ({ requestId }) => requestId,

  run: Effect.fn(function* (input) {
    const deliveryInput = yield* route(input)
    return yield* Delivery.run(deliveryInput)
    // From the CLI: a root Workflow Run.
    // From here: a linked child Workflow Run.
  })
})`,
    conclusion:
      "One definition and one invocation rule. Kojo detects the current Workflow Run context and records the parent link.",
  },
  {
    title: "2. Use the built-in durable operations",
    question:
      "Do direct Agent, Command, and scoped Sandbox calls cover the reference delivery workflow?",
    snippet: `const deliver = Effect.fn(function* (input: DeliveryInput) {
  return yield* Sandbox.use("delivery", {
    branch: \`kojo/\${input.runId}/delivery\`
  }, Effect.fn(function* (sandbox) {
    const change = yield* Agent.run("implement", {
      sandbox,
      agent: implementer,
      input,
      output: Change,
      failure: AgentFailure
    })

    const verification = yield* Command.run("verify", {
      sandbox,
      command: ["moon", "run", ":test"],
      output: Verification,
      failure: CommandInfrastructureFailure
    })

    return { change, verification }
  }))
})`,
    conclusion:
      "Agent and Command are Kojo's built-in durable Activities. Sandbox is a process-local scoped resource recreated during replay.",
  },
  {
    title: "3. Coordinate Activities with Loop",
    question:
      "Does Loop expose the author's control policy while keeping its Agent and Command Activities independently durable?",
    snippet: `const result = yield* Loop.run("implement-and-verify", {
  maxIterations: 3,

  effect: Effect.fn(function* ({ iteration, previous }) {
    const change = yield* Agent.run("implement", {
      sandbox,
      agent: implementer,
      input: {
        issue,
        previousVerification: previous?.verification
      },
      output: Change,
      failure: AgentFailure
    })

    const verification = yield* Command.run("verify", {
      sandbox,
      command: ["moon", "run", ":test"],
      output: CommandResult,
      failure: CommandInfrastructureFailure
    })

    return { iteration, change, verification }
  }),

  repeatWhile: ({ verification }) =>
    verification.outcome === "failed"
})`,
    conclusion:
      "Loop is durable control flow, not an Activity. It supplies the loop path and iteration to each visible Agent and Command Activity.",
  },
  {
    title: "4. Extend with Effect Workflow Activity",
    question: "How can an author add a durable operation without expanding Kojo's public API?",
    snippet: `import { Activity } from "effect/unstable/workflow"

const publishReceipt = (input: PublicationInput) =>
  Activity.make({
    name: "publish-receipt",
    success: PublicationReceipt,
    error: PublicationFailure,
    execute: publish(input)
  })

const receipt = yield* publishReceipt(input)

// Inside Loop.run, Kojo's loop context supplies the current
// durable attempt to this Activity just as it does for built-ins.`,
    conclusion:
      "Activity remains an Effect Workflow extension mechanism, not a Kojo primitive. Kojo documents how custom Activities participate in its identity context.",
  },
];

export const initialState = (): PrototypeState => ({
  storyIndex: 0,
});

const cycle = (value: number, length: number): number => (value + length) % length;

export const transition = (state: PrototypeState, action: Action): PrototypeState => {
  switch (action.type) {
    case "next-story":
      return {
        storyIndex: cycle(state.storyIndex + 1, stories.length),
      };
    case "previous-story":
      return {
        storyIndex: cycle(state.storyIndex - 1, stories.length),
      };
    case "reset":
      return initialState();
  }
};
