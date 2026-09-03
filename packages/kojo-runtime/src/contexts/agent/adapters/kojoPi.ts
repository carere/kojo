import type { AgentCommandOptions, AgentProvider, PrintCommand } from "@ai-hero/sandcastle";
import { pi } from "@ai-hero/sandcastle";
import {
  type AgentSessionStorage,
  type PiSessionRoots,
  piSessionStorage,
} from "../../sandbox/adapters/boundary.ts";

/**
 * pi, with the agent's identity still attached when the process starts.
 *
 * An agent is not a model. It is a **system prompt**, a **tool allowlist**, and a set of **harness
 * extensions**, and the roster (`models/AgentDefinition.ts`) declares all three because all three
 * decide what the agent does. Sandcastle's stock `pi()` builds
 * `pi -p --mode json --model X [--thinking Y] [--session Z]` and passes the prompt on stdin. There
 * is no `--system-prompt` in it, no `--tools`, and no extension flag — so a roster entry handed to
 * it arrives as a model name and nothing else, and the run still succeeds. That is the failure this
 * module exists to prevent: not a crash, a different agent.
 *
 * `AgentProvider` is a plain object interface — no class, no brand, no Effect — so Kojo supplies its
 * own rather than patching one. Reuse is then decided field by field:
 *
 * - **`parseStreamLine` is reused**, through a live `pi()` instance. It is the only way to reach it;
 *   the function is private and its return type is not exported.
 * - **`sessionStorage` is rewritten**, because pi's is the one Sandcastle keeps private. See
 *   `contexts/sandbox/adapters/boundary.ts`.
 * - **`claudeCode()` and `codex()` are not touched.** Their session helpers are already public, so
 *   wrapping them would add a second thing to keep in step with upstream and buy nothing.
 */

/** pi's reasoning effort, spelled the way `--thinking` spells it. */
export type PiThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Who this agent is, and how it is allowed to work. */
export interface KojoPiOptions {
  /** The model pattern or id `--model` takes. */
  readonly model: string;
  /**
   * The agent's identity, `--system-prompt`.
   *
   * pi replaces its default prompt with this and still appends context files and skills, so an
   * agent keeps the repository's own AGENTS.md while gaining its own character.
   */
  readonly system?: string;
  /**
   * What the agent may reach for, `--tools`.
   *
   * Empty means the flag is not passed at all, which is pi's own default set — the same reading
   * `AgentDefinition.tools` documents. An allowlist of `[]` meaning "no tools" would need
   * `--no-tools`, and a roster that says nothing must not silently mean that.
   */
  readonly tools?: ReadonlyArray<string>;
  /** Harness extensions, one `--extension` each. A path, an npm source, or a git source. */
  readonly extensions?: ReadonlyArray<string>;
  readonly thinking?: PiThinking;
  /** Environment injected at launch, merged with the sandbox provider's own. */
  readonly env?: Record<string, string>;
  /** When false, Sandcastle does not pull the transcript back to the host. Defaults to true. */
  readonly captureSessions?: boolean;
  /**
   * Where transcripts live, on either side.
   *
   * Passing a sandbox root also passes `--session-dir`, and **that flag changes pi's layout, not
   * only its location.** pi's own `SessionManager.create` reads
   * `sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)`, so a named root is
   * **flat** — `<root>/<timestamp>_<id>.jsonl` — and only pi's own default root carries the
   * `--<encoded cwd>--` directory.
   *
   * An earlier revision of this comment said the flag made the two sides "one string rather than
   * two that agree by luck". It did the opposite: Kojo passed the flag *and* read an encoded
   * subdirectory under it, which is a layout pi never writes. Nothing failed loudly — a captured
   * transcript simply landed where pi does not look, so a resumed turn would have started cold and
   * been billed as a whole prompt. Ticket 56. `piSessionSubdirectory` now holds the rule, and
   * `piSessionStorage` reads whichever layout the flag implies.
   *
   * Left alone, both sides are pi's own defaults and the flag is not passed at all.
   */
  readonly sessions?: PiSessionRoots;
}

/**
 * What one stream line parses to.
 *
 * `ParsedStreamEvent` is not on Sandcastle's export list, so the type is read back out of the
 * method that returns it. This is the shape `text`, `result`, `tool_call`, `session_id` and `usage`
 * arrive in, and a Kojo invoker reading the stream types against this rather than against `unknown`.
 */
export type ParsedStreamEvents = ReturnType<AgentProvider["parseStreamLine"]>;

/** One `AgentProvider` that is certain to carry storage — pi always has some. */
export type PiAgentProvider = AgentProvider & { readonly sessionStorage: AgentSessionStorage };

/**
 * One argument, safe inside the single command string Sandcastle runs through a shell.
 *
 * Single quotes with the close-reopen trick, because a system prompt is prose: it has apostrophes,
 * newlines, dollar signs and backticks in it, and any of those unquoted would be the shell's rather
 * than the agent's.
 */
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Every flag that says who the agent is, in the order a human would read them.
 *
 * Shared by the print command and the interactive one on purpose. An identity that survived
 * a Workflow execution and vanished in an interactive session would be the same bug in a second
 * place.
 */
const identityFlags = (options: KojoPiOptions): ReadonlyArray<readonly [string, string]> => [
  ["--model", options.model],
  ...(options.thinking === undefined ? [] : [["--thinking", options.thinking] as const]),
  ...(options.system === undefined ? [] : [["--system-prompt", options.system] as const]),
  ...(options.tools === undefined || options.tools.length === 0
    ? []
    : [["--tools", options.tools.join(",")] as const]),
  ...(options.extensions ?? []).map((source) => ["--extension", source] as const),
  ...(options.sessions?.sandbox === undefined
    ? []
    : [["--session-dir", options.sessions.sandbox] as const]),
];

/**
 * The flag that re-enters a transcript, or the one that branches off it.
 *
 * pi spells fork as `--fork <id>`, a **replacement** for `--session <id>` rather than a companion
 * to it — which is why the stock provider dropping `forkSession` is a silent drop rather than a
 * compile error. Both take the id, and both resolve it against the encoded directory of the project
 * pi is running in. That is the quirk the capture half is built around.
 */
const sessionFlag = (options: AgentCommandOptions): ReadonlyArray<readonly [string, string]> =>
  options.resumeSession === undefined
    ? []
    : [[options.forkSession === true ? "--fork" : "--session", options.resumeSession] as const];

/**
 * The prompt travels on **stdin**, never in argv.
 *
 * Sandcastle's own reason, kept: Linux caps a single argument at 128 KB, and a prompt carrying an
 * envelope's JSON Schema plus a diff reaches that. The system prompt does go in argv, because
 * `--system-prompt` takes text and pi has no file form of it — an identity that large would be a
 * different design problem.
 */
const printCommand = (options: KojoPiOptions, call: AgentCommandOptions): PrintCommand => ({
  command: [
    "pi -p --mode json",
    ...[...identityFlags(options), ...sessionFlag(call)].map(
      ([flag, value]) => `${flag} ${quote(value)}`,
    ),
  ].join(" "),
  stdin: call.prompt,
});

/** The same identity as an argv, for the interactive path, where nothing needs quoting. */
const interactiveArgs = (options: KojoPiOptions, call: AgentCommandOptions): Array<string> => {
  const args = ["pi"];
  for (const [flag, value] of [...identityFlags(options), ...sessionFlag(call)]) {
    args.push(flag, value);
  }
  if (call.prompt !== "") args.push(call.prompt);
  return args;
};

/**
 * The provider Kojo hands Sandcastle when the agent is pi.
 *
 * Named `"pi"` rather than `"kojo-pi"`: the name is what binary runs and what a trace row reads,
 * and Kojo never constructs the stock one, so a second name would only make the same agent look
 * like two.
 */
export const kojoPi = (options: KojoPiOptions): PiAgentProvider => {
  // One instance, built once, held only for its parser. Constructing it costs nothing — `pi()`
  // returns a plain object — and it is the sole route to `parsePiStreamLine`.
  const parser = pi(options.model);

  return {
    name: "pi",
    env: options.env ?? {},
    captureSessions: options.captureSessions ?? true,
    sessionStorage: piSessionStorage(options.sessions),
    buildPrintCommand: (call) => printCommand(options, call),
    buildInteractiveArgs: (call) => interactiveArgs(options, call),
    parseStreamLine: (line: string): ParsedStreamEvents => parser.parseStreamLine(line),
  };
};
