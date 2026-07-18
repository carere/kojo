import {
  type Action,
  describeNextAction,
  initialState,
  type PrototypeState,
  transition,
} from "./model";

const bold = "\u001b[1m";
const dim = "\u001b[2m";
const reset = "\u001b[0m";

const actionByKey: Record<string, Action> = {
  b: { type: "begin" },
  m: { type: "create-sandbox" },
  a: { type: "agent-step" },
  c: { type: "code-step" },
  p: { type: "record-step" },
  k: { type: "crash" },
  o: { type: "crash-during-create" },
  r: { type: "restart" },
  s: { type: "succeed" },
  x: { type: "discard" },
  z: { type: "reset" },
};

const field = (name: string, value: unknown): string =>
  `${bold}${name.padEnd(27)}${reset} ${String(value)}`;

const runStatus = (status: PrototypeState["durable"]["runStatus"]): string =>
  ({
    idle: "not started",
    running: "running",
    interrupted: "stopped unexpectedly",
    succeeded: "finished successfully",
    discarded: "discarded",
  })[status];

const sandboxStatus = (status: PrototypeState["durable"]["sandboxStatus"]): string =>
  ({
    absent: "not created",
    active: "usable by this Kojo program",
    "must-recreate": "must be recreated from the branch",
    closed: "closed or no longer owned by Kojo",
  })[status];

const yesNo = (value: boolean): string => (value ? "yes" : "no");

const render = (state: PrototypeState): void => {
  console.clear();
  console.log(`${bold}PROTOTYPE — Resume a Workflow Run after losing its Sandbox object${reset}`);
  console.log(
    `${dim}Only SQLite workflow state and committed Git work are guaranteed to survive.${reset}\n`,
  );

  console.log(`${bold}WHAT SQLITE REMEMBERS${reset}`);
  console.log(field("Workflow Run", runStatus(state.durable.runStatus)));
  console.log(field("pinned Workflow Revision", state.durable.workflowRevision));
  console.log(field("next action", describeNextAction(state.durable.nextAction)));
  console.log(field("last completed Step", state.durable.lastCompletedStep ?? "none"));
  console.log(field("Reusable Sandbox name", state.durable.sandboxName));
  console.log(field("branch", state.durable.branch));
  console.log(field("last committed work", state.durable.lastSavedCommit ?? "branch base"));
  console.log(field("Sandbox state", sandboxStatus(state.durable.sandboxStatus)));
  console.log(field("Sandboxes created so far", state.durable.sandboxInstance));

  console.log(`\n${bold}WHAT THE CURRENT KOJO PROGRAM HAS IN MEMORY${reset}`);
  console.log(field("Kojo running", yesNo(state.process.online)));
  console.log(field("times Kojo has started", state.process.startCount));
  console.log(field("temporary Sandbox object", state.process.sandboxReference ?? "none"));
  console.log(field("Step currently running", state.process.inFlightStep ?? "none"));
  console.log(field("working files", state.process.workingFiles));

  console.log(`\n${bold}WHAT A HARD CRASH CANNOT RECOVER${reset}`);
  console.log(field("possibly orphaned Sandboxes", state.sandcastle.possiblyOrphanedSandboxes));
  console.log(field("uncommitted AI changes", "accepted as lost"));
  console.log(field("recovery rule", "create a fresh Sandbox from the same branch"));

  console.log(`\n${bold}WHAT JUST HAPPENED${reset}\n${state.message}`);
  console.log(
    `\n${bold}[b]${reset}${dim} start Workflow Run${reset}  ${bold}[m]${reset}${dim} create/recreate Sandbox${reset}  ${bold}[a]${reset}${dim} run Agent Step${reset}`,
  );
  console.log(
    `${bold}[c]${reset}${dim} run Code Step${reset}  ${bold}[p]${reset}${dim} commit and record Step${reset}  ${bold}[k]${reset}${dim} stop Kojo unexpectedly${reset}`,
  );
  console.log(
    `${bold}[o]${reset}${dim} stop while creating${reset}  ${bold}[r]${reset}${dim} start Kojo again${reset}  ${bold}[s]${reset}${dim} finish and close Sandbox${reset}`,
  );
  console.log(
    `${bold}[x]${reset}${dim} discard Workflow Run${reset}  ${bold}[z]${reset}${dim} reset demo${reset}  ${bold}[q]${reset}${dim} quit${reset}`,
  );
};

let state = initialState();
render(state);

process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (key: string) => {
  if (key === "q" || key === "\u0003") {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    console.clear();
    process.exit(0);
  }

  const action = actionByKey[key];
  if (action !== undefined) {
    state = transition(state, action);
    render(state);
  }
});
