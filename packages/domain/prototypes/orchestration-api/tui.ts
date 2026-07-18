import {
  type Action,
  initialState,
  type PrototypeState,
  publicSurface,
  stories,
  transition,
} from "./model";

const bold = "\u001b[1m";
const dim = "\u001b[2m";
const cyan = "\u001b[36m";
const yellow = "\u001b[33m";
const reset = "\u001b[0m";

const actionByKey: Record<string, Action> = {
  n: { type: "next-story" },
  p: { type: "previous-story" },
  z: { type: "reset" },
};

const render = (state: PrototypeState): void => {
  const story = stories[state.storyIndex];

  console.clear();
  console.log(`${bold}PROTOTYPE — Kojo's Effect-native orchestration API${reset}`);
  console.log(
    `${dim}Validated public surface: Workflow, Loop, Sandbox, Agent, and Command.${reset}\n`,
  );

  console.log(`${bold}${cyan}PUBLIC SURFACE${reset}`);
  console.log(publicSurface.map((entry) => `  ${entry}`).join("\n"));

  console.log(`\n${bold}${story.title}${reset}`);
  console.log(`${dim}${story.question}${reset}\n`);
  console.log(story.snippet);

  console.log(`\n${bold}${yellow}CONCLUSION${reset}`);
  console.log(story.conclusion);

  console.log(
    `\n${bold}[p]${reset}${dim} previous story${reset}  ${bold}[n]${reset}${dim} next story${reset}`,
  );
  console.log(
    `${bold}[z]${reset}${dim} reset${reset}  ${bold}[q]${reset}${dim} quit${reset}  ${dim}story ${state.storyIndex + 1}/${stories.length}${reset}`,
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
