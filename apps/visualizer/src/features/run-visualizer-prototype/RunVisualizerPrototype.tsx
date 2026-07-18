import { createMemo, createSignal, For, Show } from "solid-js";

type PrototypeVariant = "A" | "B" | "C";
type ServerState = "connected" | "connecting" | "unavailable";
type TraceStatus = "completed" | "failed" | "running" | "waiting" | "info";

type TraceNode = {
  actor: string;
  attempt: number;
  detail: string;
  depth: number;
  duration: string;
  id: string;
  kind: string;
  ordinal: number;
  status: TraceStatus;
  time: string;
  title: string;
};

const workflows = [
  { name: "delivery", revision: "a8c41f2", detail: "3 runs", selected: true },
  { name: "issue-triage", revision: "81de903", detail: "1 run", selected: false },
  { name: "release-note-draft", revision: "5ac9d70", detail: "No runs", selected: false },
];

const runs = [
  { id: "01JY7…N4D", label: "Deliver product search", state: "Failed", age: "2m" },
  { id: "01JY6…8PK", label: "Fix checkout retry", state: "Completed", age: "3h" },
  { id: "01JXW…72M", label: "Add saved filters", state: "Discarded", age: "1d" },
];

const traceNodes: TraceNode[] = [
  {
    actor: "Kojo",
    attempt: 1,
    detail:
      "Pinned delivery@2026.07 to revision a8c41f2 and captured the provider configuration used by this run.",
    depth: 0,
    duration: "11ms",
    id: "run-started",
    kind: "Workflow Run",
    ordinal: 1,
    status: "completed",
    time: "10:42:03.018",
    title: "delivery started",
  },
  {
    actor: "delivery",
    attempt: 1,
    detail:
      "Deterministic scheduling selected product-search before the independent documentation ticket.",
    depth: 1,
    duration: "2ms",
    id: "route-selected",
    kind: "Execution Decision",
    ordinal: 2,
    status: "info",
    time: "10:42:03.029",
    title: "Selected next ticket: product-search",
  },
  {
    actor: "delivery",
    attempt: 1,
    detail:
      "Created a durable Child Workflow Run using the stable invocation key ticket/product-search.",
    depth: 1,
    duration: "7ms",
    id: "child-started",
    kind: "Child Workflow",
    ordinal: 3,
    status: "completed",
    time: "10:42:03.031",
    title: "ticket-delivery / product-search",
  },
  {
    actor: "local-docker",
    attempt: 1,
    detail:
      "Created named Sandbox product-search on branch kojo/run-01JY7-product-search. Provider detail is display-safe.",
    depth: 2,
    duration: "4.8s",
    id: "sandbox-created",
    kind: "Sandbox",
    ordinal: 4,
    status: "completed",
    time: "10:42:03.038",
    title: "Sandbox “product-search”",
  },
  {
    actor: "claude-code / sonnet-4",
    attempt: 1,
    detail:
      "Implementer changed 8 files, committed 61c0ae9, and produced a transcript artifact. Secret-bearing configuration was omitted.",
    depth: 3,
    duration: "6m 12s",
    id: "implementer",
    kind: "Agent Step",
    ordinal: 5,
    status: "completed",
    time: "10:42:07.841",
    title: "Implement product search",
  },
  {
    actor: "bun",
    attempt: 1,
    detail: "moon run :test completed successfully. 128 tests passed and 4 were skipped.",
    depth: 3,
    duration: "38.4s",
    id: "test-command",
    kind: "Code Step",
    ordinal: 6,
    status: "completed",
    time: "10:48:19.901",
    title: "Run affected tests",
  },
  {
    actor: "delivery",
    attempt: 1,
    detail: "Entered one-based Review Loop “quality-gate” with a maximum of 3 iterations.",
    depth: 3,
    duration: "—",
    id: "loop-start",
    kind: "Loop",
    ordinal: 7,
    status: "info",
    time: "10:48:58.306",
    title: "Review Loop · iteration 1 of 3",
  },
  {
    actor: "claude-code / opus-4",
    attempt: 1,
    detail:
      "Read-only review of exact commit 61c0ae9 returned one P2 finding: the empty-query path scans the complete index.",
    depth: 4,
    duration: "2m 04s",
    id: "review-one",
    kind: "Reviewer Step",
    ordinal: 8,
    status: "completed",
    time: "10:48:58.309",
    title: "Review exact commit 61c0ae9",
  },
  {
    actor: "delivery",
    attempt: 1,
    detail:
      "The Review Loop continues because every P1, P2, or P3 finding returns control to the implementer.",
    depth: 4,
    duration: "1ms",
    id: "loop-continue",
    kind: "Execution Decision",
    ordinal: 9,
    status: "info",
    time: "10:51:02.751",
    title: "Continue: 1 finding remains",
  },
  {
    actor: "claude-code / sonnet-4",
    attempt: 1,
    detail:
      "Implementer addressed the P2 finding and committed 9da3b0c in the same Reusable Sandbox.",
    depth: 4,
    duration: "3m 31s",
    id: "remediate",
    kind: "Agent Step",
    ordinal: 10,
    status: "completed",
    time: "10:51:02.752",
    title: "Remediate review findings",
  },
  {
    actor: "claude-code / opus-4",
    attempt: 1,
    detail:
      "Read-only review of exact commit 9da3b0c found no P1, P2, or P3 findings. A structured report artifact is attached.",
    depth: 4,
    duration: "1m 47s",
    id: "review-two",
    kind: "Reviewer Step",
    ordinal: 11,
    status: "completed",
    time: "10:54:34.116",
    title: "Review Loop · iteration 2 of 3",
  },
  {
    actor: "delivery",
    attempt: 1,
    detail: "Exited Review Loop “quality-gate” because the structured finding set was empty.",
    depth: 3,
    duration: "1ms",
    id: "loop-exit",
    kind: "Execution Decision",
    ordinal: 12,
    status: "completed",
    time: "10:56:21.740",
    title: "Exit: quality gate passed",
  },
  {
    actor: "git",
    attempt: 1,
    detail:
      "The external push may have completed, but the process lost ownership before its result was durably recorded. Reconciliation is required before retry.",
    depth: 3,
    duration: "30.0s",
    id: "publish-uncertain",
    kind: "Activity Attempt",
    ordinal: 13,
    status: "failed",
    time: "10:56:21.742",
    title: "Publish branch · outcome uncertain",
  },
  {
    actor: "Kojo",
    attempt: 1,
    detail:
      "The Typed Failure github.rate-limited is explicitly resumable. Compensation completed; the run may resume as Execution Attempt 2.",
    depth: 0,
    duration: "3ms",
    id: "run-failed",
    kind: "Typed Failure",
    ordinal: 14,
    status: "failed",
    time: "10:56:51.744",
    title: "Workflow Run failed",
  },
];

const statusLabel: Record<TraceStatus, string> = {
  completed: "Completed",
  failed: "Failed",
  info: "Decision",
  running: "Running",
  waiting: "Waiting",
};

const statusDot: Record<TraceStatus, string> = {
  completed: "bg-emerald-500",
  failed: "bg-rose-500",
  info: "bg-sky-500",
  running: "bg-amber-500",
  waiting: "bg-zinc-400",
};

function ServerBadge(props: { state: ServerState; dark?: boolean }) {
  return (
    <div
      class={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] ${
        props.dark
          ? "border-white/10 bg-white/5 text-zinc-300"
          : "border-zinc-200 bg-white text-zinc-600"
      }`}
    >
      <span
        class={`size-1.5 rounded-full ${
          props.state === "connected"
            ? "bg-emerald-500"
            : props.state === "connecting"
              ? "bg-amber-500"
              : "bg-rose-500"
        }`}
      />
      {props.state === "connected"
        ? "Local store"
        : props.state === "connecting"
          ? "Connecting"
          : "Mock evidence"}
    </div>
  );
}

function StateBadge(props: { children: string; state?: "danger" | "good" | "neutral" }) {
  const color = () =>
    props.state === "danger"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : props.state === "good"
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : "border-zinc-200 bg-zinc-50 text-zinc-600";

  return (
    <span class={`inline-flex rounded-full border px-2 py-0.5 font-medium text-[11px] ${color()}`}>
      {props.children}
    </span>
  );
}

function RunActions(props: { dark?: boolean }) {
  return (
    <div class="flex items-center gap-2">
      <button
        class={`rounded-md border px-3 py-1.5 font-medium text-xs ${
          props.dark
            ? "border-white/15 text-zinc-300 hover:bg-white/10"
            : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
        }`}
        type="button"
      >
        Discard…
      </button>
      <button
        class={`rounded-md px-3 py-1.5 font-semibold text-xs ${
          props.dark
            ? "bg-lime-300 text-zinc-950 hover:bg-lime-200"
            : "bg-zinc-950 text-white hover:bg-zinc-800"
        }`}
        type="button"
      >
        Resume run
      </button>
    </div>
  );
}

export function RunVisualizerPrototype(props: {
  serverState: ServerState;
  variant: PrototypeVariant;
}) {
  const [selectedId, setSelectedId] = createSignal("publish-uncertain");
  const selectedNode = createMemo(
    () => traceNodes.find((node) => node.id === selectedId()) ?? traceNodes[0],
  );

  return (
    <Show
      when={props.variant !== "A"}
      fallback={
        <TraceInspector
          selectedId={selectedId()}
          selectedNode={selectedNode()}
          serverState={props.serverState}
          setSelectedId={setSelectedId}
        />
      }
    >
      <Show
        when={props.variant === "B"}
        fallback={
          <EvidenceLedger
            selectedId={selectedId()}
            selectedNode={selectedNode()}
            serverState={props.serverState}
            setSelectedId={setSelectedId}
          />
        }
      >
        <RunStory
          selectedId={selectedId()}
          selectedNode={selectedNode()}
          serverState={props.serverState}
          setSelectedId={setSelectedId}
        />
      </Show>
    </Show>
  );
}

type VariantProps = {
  selectedId: string;
  selectedNode: TraceNode;
  serverState: ServerState;
  setSelectedId: (id: string) => void;
};

function TraceInspector(props: VariantProps) {
  return (
    <main class="min-h-svh bg-zinc-100 pb-24 text-zinc-950">
      <header class="flex h-14 items-center justify-between border-zinc-200 border-b bg-white px-5">
        <div class="flex items-center gap-5">
          <div class="flex items-center gap-2 font-semibold">
            <span class="grid size-7 place-items-center rounded-md bg-zinc-950 text-white text-xs">
              工
            </span>
            Kojo
          </div>
          <div class="h-5 w-px bg-zinc-200" />
          <p class="text-sm text-zinc-500">Developer Workflows</p>
        </div>
        <ServerBadge state={props.serverState} />
      </header>

      <div class="grid min-h-[calc(100svh-3.5rem)] grid-cols-[220px_minmax(420px,1fr)_280px] xl:grid-cols-[260px_minmax(520px,1fr)_330px]">
        <aside class="border-zinc-200 border-r bg-white">
          <div class="border-zinc-200 border-b p-4">
            <p class="font-semibold text-[11px] text-zinc-400 uppercase tracking-[0.14em]">
              Discovered workflows
            </p>
            <div class="mt-3 space-y-1">
              <For each={workflows}>
                {(workflow) => (
                  <button
                    class={`w-full rounded-lg px-3 py-2 text-left ${
                      workflow.selected ? "bg-zinc-950 text-white" : "hover:bg-zinc-100"
                    }`}
                    type="button"
                  >
                    <div class="flex items-center justify-between">
                      <span class="font-semibold text-sm">{workflow.name}</span>
                      <span
                        class={`font-mono text-[10px] ${
                          workflow.selected ? "text-zinc-400" : "text-zinc-400"
                        }`}
                      >
                        {workflow.revision}
                      </span>
                    </div>
                    <p
                      class={`mt-1 text-xs ${
                        workflow.selected ? "text-zinc-400" : "text-zinc-500"
                      }`}
                    >
                      {workflow.detail}
                    </p>
                  </button>
                )}
              </For>
            </div>
          </div>

          <div class="p-4">
            <div class="flex items-center justify-between">
              <p class="font-semibold text-[11px] text-zinc-400 uppercase tracking-[0.14em]">
                Workflow Runs
              </p>
              <span class="text-[10px] text-zinc-400">Newest</span>
            </div>
            <div class="mt-3 space-y-1">
              <For each={runs}>
                {(run, index) => (
                  <button
                    class={`w-full rounded-lg border px-3 py-2.5 text-left ${
                      index() === 0
                        ? "border-rose-200 bg-rose-50"
                        : "border-transparent hover:bg-zinc-100"
                    }`}
                    type="button"
                  >
                    <div class="flex items-start justify-between gap-2">
                      <p class="font-medium text-xs leading-5">{run.label}</p>
                      <span class="text-[10px] text-zinc-400">{run.age}</span>
                    </div>
                    <div class="mt-1 flex items-center gap-2 text-[10px] text-zinc-500">
                      <span
                        class={`size-1.5 rounded-full ${
                          run.state === "Failed"
                            ? "bg-rose-500"
                            : run.state === "Completed"
                              ? "bg-emerald-500"
                              : "bg-zinc-400"
                        }`}
                      />
                      {run.state}
                      <span class="font-mono">{run.id}</span>
                    </div>
                  </button>
                )}
              </For>
            </div>
          </div>
        </aside>

        <section class="min-w-0 bg-white">
          <div class="border-zinc-200 border-b px-6 py-5">
            <div class="flex items-start justify-between gap-6">
              <div>
                <div class="flex items-center gap-2">
                  <StateBadge state="danger">Failed</StateBadge>
                  <span class="font-mono text-[11px] text-zinc-400">01JY7AW4Y4K8P38MN4D</span>
                </div>
                <h1 class="mt-2 font-semibold text-xl tracking-tight">Deliver product search</h1>
                <p class="mt-1 text-xs text-zinc-500">
                  delivery@2026.07 · revision a8c41f2 · started 14 minutes ago
                </p>
              </div>
              <RunActions />
            </div>
            <div class="mt-5 grid grid-cols-4 divide-x divide-zinc-200 rounded-lg border border-zinc-200 bg-zinc-50">
              <RunFact label="State" value="Failed" />
              <RunFact label="Resume compatibility" value="Exact match" />
              <RunFact label="Runtime configuration" value="Compatible" />
              <RunFact label="Execution attempts" value="1" />
            </div>
          </div>

          <div class="flex items-center justify-between border-zinc-200 border-b px-6 py-3">
            <div class="flex items-center gap-5">
              <button class="border-zinc-950 border-b-2 py-2 font-semibold text-xs" type="button">
                Actual trace
              </button>
              <button class="py-2 text-xs text-zinc-500" type="button">
                Run tree <span class="ml-1 rounded bg-zinc-100 px-1.5 py-0.5">2</span>
              </button>
              <button class="py-2 text-xs text-zinc-500" type="button">
                Artifacts <span class="ml-1 rounded bg-zinc-100 px-1.5 py-0.5">6</span>
              </button>
            </div>
            <p class="text-[11px] text-zinc-400">14 evidence events · chronological</p>
          </div>

          <div class="px-6 py-4">
            <div class="mb-3 flex items-center gap-3">
              <span class="rounded bg-zinc-950 px-2 py-1 font-semibold text-[10px] text-white">
                EXECUTION ATTEMPT 1
              </span>
              <div class="h-px flex-1 bg-zinc-200" />
              <span class="text-[10px] text-zinc-400">10:42:03–10:56:51</span>
            </div>
            <For each={traceNodes}>
              {(node) => (
                <button
                  class={`group grid w-full grid-cols-[18px_minmax(0,1fr)_72px] items-start gap-3 rounded-md py-2.5 pr-3 text-left ${
                    props.selectedId === node.id
                      ? "bg-sky-50 ring-1 ring-sky-200"
                      : "hover:bg-zinc-50"
                  }`}
                  onClick={() => props.setSelectedId(node.id)}
                  style={{ "padding-left": `${10 + node.depth * 20}px` }}
                  type="button"
                >
                  <div class="relative flex justify-center pt-1.5">
                    <span class={`relative z-10 size-2 rounded-full ${statusDot[node.status]}`} />
                    <span class="absolute top-3 h-[calc(100%+1rem)] w-px bg-zinc-200 group-last:hidden" />
                  </div>
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <p class="truncate font-medium text-xs">{node.title}</p>
                      <span class="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] text-zinc-500">
                        {node.kind}
                      </span>
                    </div>
                    <p class="mt-1 truncate text-[11px] text-zinc-500">{node.detail}</p>
                  </div>
                  <div class="text-right font-mono text-[10px] text-zinc-400">
                    <p>{node.time.slice(0, 8)}</p>
                    <p class="mt-1">{node.duration}</p>
                  </div>
                </button>
              )}
            </For>
          </div>
        </section>

        <EvidenceDetail node={props.selectedNode} />
      </div>
    </main>
  );
}

function RunFact(props: { label: string; value: string }) {
  return (
    <div class="px-3 py-2.5">
      <p class="text-[9px] text-zinc-400 uppercase tracking-wider">{props.label}</p>
      <p class="mt-1 font-semibold text-[11px]">{props.value}</p>
    </div>
  );
}

function EvidenceDetail(props: { node: TraceNode }) {
  return (
    <aside class="border-zinc-200 border-l bg-zinc-50 p-5">
      <p class="font-semibold text-[10px] text-zinc-400 uppercase tracking-[0.15em]">
        Selected evidence
      </p>
      <div class="mt-4 flex items-center gap-2">
        <span class={`size-2 rounded-full ${statusDot[props.node.status]}`} />
        <StateBadge state={props.node.status === "failed" ? "danger" : "good"}>
          {statusLabel[props.node.status]}
        </StateBadge>
      </div>
      <h2 class="mt-3 font-semibold text-lg leading-6">{props.node.title}</h2>
      <p class="mt-3 text-xs text-zinc-600 leading-5">{props.node.detail}</p>

      <dl class="mt-6 space-y-3 border-zinc-200 border-t pt-5 text-xs">
        <DetailRow label="Evidence order" value={`#${props.node.ordinal}`} />
        <DetailRow label="Execution Attempt" value={String(props.node.attempt)} />
        <DetailRow label="Actor" value={props.node.actor} />
        <DetailRow label="Started" value={props.node.time} />
        <DetailRow label="Duration" value={props.node.duration} />
        <DetailRow label="Parent span" value={props.node.depth ? "product-search" : "—"} />
      </dl>

      <Show when={props.node.id === "publish-uncertain"}>
        <div class="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p class="font-semibold text-[11px] text-amber-900">Reconciliation required</p>
          <p class="mt-1 text-[11px] text-amber-800 leading-4">
            Resume will check whether the remote branch exists before this Activity can retry.
          </p>
        </div>
      </Show>

      <div class="mt-6">
        <p class="font-semibold text-[10px] text-zinc-400 uppercase tracking-[0.15em]">
          Referenced artifacts
        </p>
        <button
          class="mt-3 flex w-full items-center justify-between rounded-lg border border-zinc-200 bg-white p-3 text-left hover:border-zinc-300"
          type="button"
        >
          <div>
            <p class="font-medium text-[11px]">activity-output.txt</p>
            <p class="mt-1 font-mono text-[9px] text-zinc-400">sha256:71d8…93a</p>
          </div>
          <span class="text-zinc-400">↗</span>
        </button>
      </div>
    </aside>
  );
}

function DetailRow(props: { label: string; value: string }) {
  return (
    <div class="flex items-start justify-between gap-4">
      <dt class="text-zinc-400">{props.label}</dt>
      <dd class="max-w-40 text-right font-medium text-zinc-700">{props.value}</dd>
    </div>
  );
}

function RunStory(props: VariantProps) {
  const importantNodes = () =>
    traceNodes.filter((node) =>
      [
        "run-started",
        "child-started",
        "implementer",
        "review-one",
        "loop-continue",
        "review-two",
        "publish-uncertain",
        "run-failed",
      ].includes(node.id),
    );

  return (
    <main class="min-h-svh bg-[#111714] pb-28 text-[#eef5ef]">
      <header class="mx-auto flex max-w-7xl items-center justify-between px-7 py-6">
        <div class="flex items-center gap-3">
          <span class="grid size-9 place-items-center rounded-full border border-lime-300/40 bg-lime-300/10 font-semibold text-lime-300">
            工
          </span>
          <div>
            <p class="font-semibold text-sm">Kojo</p>
            <p class="text-[10px] text-zinc-500">Actual runs, told truthfully</p>
          </div>
        </div>
        <div class="flex items-center gap-4">
          <button class="text-xs text-zinc-400 hover:text-white" type="button">
            All workflows
          </button>
          <ServerBadge dark state={props.serverState} />
        </div>
      </header>

      <section class="mx-auto max-w-7xl px-7 pt-10">
        <div class="grid gap-12 border-white/10 border-b pb-12 lg:grid-cols-[1fr_300px]">
          <div>
            <div class="flex items-center gap-3 text-xs">
              <span class="rounded-full border border-rose-400/30 bg-rose-400/10 px-2.5 py-1 font-semibold text-rose-300">
                Failed
              </span>
              <span class="font-mono text-zinc-500">01JY7AW4Y4K8P38MN4D</span>
            </div>
            <h1 class="mt-7 max-w-4xl font-medium text-5xl leading-[1.02] tracking-[-0.04em] sm:text-7xl">
              Deliver product search
            </h1>
            <p class="mt-6 max-w-2xl text-base text-zinc-400 leading-7">
              A fourteen-minute run that implemented and reviewed the change successfully, then lost
              certainty while publishing its branch.
            </p>
          </div>
          <div class="flex flex-col justify-between gap-8">
            <RunActions dark />
            <div class="grid grid-cols-2 gap-5 border-white/10 border-t pt-5">
              <StoryFact label="Workflow" value="delivery@2026.07" />
              <StoryFact label="Revision" value="a8c41f2" />
              <StoryFact label="Can resume?" value="Yes · exact match" accent />
              <StoryFact label="Attempts" value="1 of —" />
            </div>
          </div>
        </div>

        <div class="grid gap-12 pt-12 lg:grid-cols-[220px_minmax(0,680px)_1fr]">
          <aside class="lg:sticky lg:top-8 lg:self-start">
            <p class="font-semibold text-[10px] text-zinc-600 uppercase tracking-[0.18em]">
              In this run
            </p>
            <ol class="mt-5 space-y-4 text-xs text-zinc-400">
              <li class="flex items-center justify-between border-lime-300 border-r-2 pr-3 text-lime-200">
                <span>Run story</span>
                <span>8</span>
              </li>
              <li class="flex items-center justify-between pr-3">
                <span>All evidence</span>
                <span>14</span>
              </li>
              <li class="flex items-center justify-between pr-3">
                <span>Artifacts</span>
                <span>6</span>
              </li>
              <li class="flex items-center justify-between pr-3">
                <span>Child runs</span>
                <span>1</span>
              </li>
            </ol>

            <div class="mt-10 rounded-xl border border-white/10 bg-white/[0.025] p-4">
              <p class="text-[10px] text-zinc-600 uppercase tracking-wider">Run tree</p>
              <div class="mt-4 space-y-3 text-xs">
                <div class="flex items-center gap-2">
                  <span class="size-2 rounded-full bg-rose-400" />
                  <span>delivery</span>
                </div>
                <div class="ml-1 border-white/10 border-l pl-4">
                  <div class="flex items-center gap-2">
                    <span class="size-2 rounded-full bg-emerald-400" />
                    <span>ticket-delivery</span>
                  </div>
                  <p class="mt-1 pl-4 text-[10px] text-zinc-600">product-search</p>
                </div>
              </div>
            </div>
          </aside>

          <section>
            <div class="mb-7 flex items-center gap-4">
              <p class="font-mono text-[10px] text-lime-300">EXECUTION ATTEMPT 1</p>
              <div class="h-px flex-1 bg-white/10" />
              <p class="font-mono text-[10px] text-zinc-600">10:42–10:56</p>
            </div>
            <div class="relative">
              <div class="absolute top-2 bottom-8 left-[7px] w-px bg-white/10" />
              <For each={importantNodes()}>
                {(node) => (
                  <button
                    class="group relative grid w-full grid-cols-[16px_1fr] gap-5 pb-9 text-left"
                    onClick={() => props.setSelectedId(node.id)}
                    type="button"
                  >
                    <span
                      class={`relative z-10 mt-1 size-[15px] rounded-full border-[#111714] border-[4px] ${
                        props.selectedId === node.id
                          ? "bg-lime-300 ring-2 ring-lime-300/25"
                          : statusDot[node.status]
                      }`}
                    />
                    <article
                      class={`rounded-xl border p-5 transition ${
                        props.selectedId === node.id
                          ? "border-lime-300/35 bg-lime-300/[0.06]"
                          : "border-white/10 bg-white/[0.025] group-hover:bg-white/[0.05]"
                      }`}
                    >
                      <div class="flex items-start justify-between gap-4">
                        <div>
                          <p class="font-mono text-[10px] text-zinc-600">
                            {node.time.slice(0, 8)} · {node.kind}
                          </p>
                          <h2 class="mt-2 font-medium text-lg">{node.title}</h2>
                        </div>
                        <span class="font-mono text-[10px] text-zinc-600">{node.duration}</span>
                      </div>
                      <p class="mt-3 text-sm text-zinc-400 leading-6">{node.detail}</p>
                      <Show when={node.id === "review-one"}>
                        <div class="mt-4 rounded-lg border border-amber-300/15 bg-amber-300/[0.06] p-3">
                          <p class="font-semibold text-[10px] text-amber-200">P2 · Performance</p>
                          <p class="mt-1 text-amber-100/60 text-xs">
                            Empty-query path scans the complete index.
                          </p>
                        </div>
                      </Show>
                    </article>
                  </button>
                )}
              </For>
            </div>
          </section>

          <aside class="lg:sticky lg:top-8 lg:self-start">
            <p class="font-semibold text-[10px] text-zinc-600 uppercase tracking-[0.18em]">
              Why the run stopped
            </p>
            <div class="mt-5 rounded-2xl border border-rose-300/20 bg-rose-300/[0.06] p-5">
              <p class="font-mono text-[10px] text-rose-300">github.rate-limited</p>
              <h2 class="mt-3 font-medium text-xl">Publication needs reconciliation</h2>
              <p class="mt-3 text-sm text-zinc-400 leading-6">
                Git may have pushed the branch before execution ownership was lost. Kojo will check
                the remote before retrying.
              </p>
              <div class="mt-5 border-white/10 border-t pt-4 text-xs">
                <div class="flex justify-between">
                  <span class="text-zinc-600">Failure kind</span>
                  <span>Typed Failure</span>
                </div>
                <div class="mt-3 flex justify-between">
                  <span class="text-zinc-600">Recovery</span>
                  <span class="text-lime-300">Resumable</span>
                </div>
              </div>
            </div>

            <p class="mt-8 font-semibold text-[10px] text-zinc-600 uppercase tracking-[0.18em]">
              Selected moment
            </p>
            <div class="mt-4 border-white/10 border-l pl-4">
              <p class="font-medium text-sm">{props.selectedNode.title}</p>
              <p class="mt-2 text-xs text-zinc-500 leading-5">{props.selectedNode.actor}</p>
              <p class="mt-3 font-mono text-[10px] text-zinc-600">
                Evidence #{props.selectedNode.ordinal}
              </p>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}

function StoryFact(props: { accent?: boolean; label: string; value: string }) {
  return (
    <div>
      <p class="text-[9px] text-zinc-600 uppercase tracking-wider">{props.label}</p>
      <p class={`mt-1 text-xs ${props.accent ? "text-lime-300" : "text-zinc-300"}`}>
        {props.value}
      </p>
    </div>
  );
}

function EvidenceLedger(props: VariantProps) {
  return (
    <main class="min-h-svh bg-[#f4f2ec] pb-24 font-mono text-[#22221f]">
      <header class="border-[#292923] border-b-2 bg-[#f4f2ec]">
        <div class="flex h-12 items-center justify-between px-4">
          <div class="flex items-center gap-4 text-xs">
            <span class="bg-[#292923] px-2 py-1 font-bold text-[#f4f2ec]">KOJO / EVIDENCE</span>
            <span class="text-[#77766d]">WORKFLOW REGISTRY: 3 DISCOVERED</span>
          </div>
          <ServerBadge state={props.serverState} />
        </div>
        <div class="grid grid-cols-[1fr_auto] items-end gap-6 border-[#b8b6ad] border-t px-4 py-3">
          <div>
            <div class="flex items-center gap-3 text-[10px]">
              <span>DELIVERY@2026.07</span>
              <span class="text-[#8b8980]">/</span>
              <span>REV A8C41F2</span>
              <span class="text-[#8b8980]">/</span>
              <span>RUN 01JY7AW4Y4K8P38MN4D</span>
            </div>
            <div class="mt-2 flex items-baseline gap-4">
              <h1 class="font-sans font-semibold text-2xl tracking-tight">
                Deliver product search
              </h1>
              <span class="bg-[#c7392f] px-2 py-0.5 font-bold text-[10px] text-white">FAILED</span>
            </div>
          </div>
          <RunActions />
        </div>
      </header>

      <section class="grid min-h-[calc(100svh-7.25rem)] grid-cols-[290px_minmax(720px,1fr)]">
        <aside class="border-[#b8b6ad] border-r">
          <div class="border-[#b8b6ad] border-b p-4">
            <p class="font-bold text-[10px]">RUN TREE</p>
            <div class="mt-4 text-[11px]">
              <div class="flex items-center justify-between bg-[#292923] px-2 py-2 text-white">
                <span>└─ delivery</span>
                <span class="text-[#ff8c83]">FAILED</span>
              </div>
              <div class="mt-1 flex items-center justify-between px-2 py-2">
                <span>   └─ ticket-delivery</span>
                <span class="text-emerald-700">DONE</span>
              </div>
              <div class="flex items-center justify-between px-2 py-2 text-[#77766d]">
                <span>      └─ sandbox:product-search</span>
                <span>CLOSED</span>
              </div>
            </div>
          </div>

          <div class="border-[#b8b6ad] border-b p-4">
            <p class="font-bold text-[10px]">STATE VECTORS</p>
            <dl class="mt-4 space-y-2 text-[10px]">
              <LedgerFact label="RUN.STATE" value="FAILED" danger />
              <LedgerFact label="RESUME.REVISION" value="EXACT" />
              <LedgerFact label="RESUME.CONFIG" value="COMPATIBLE" />
              <LedgerFact label="FAILURE.RESUMABLE" value="TRUE" />
              <LedgerFact label="ATTEMPT.CURRENT" value="1" />
              <LedgerFact label="EVENT.COUNT" value="14" />
            </dl>
          </div>

          <div class="p-4">
            <p class="font-bold text-[10px]">FILTER EVENT TYPE</p>
            <div class="mt-3 flex flex-wrap gap-1.5">
              <For each={["ALL 14", "DECISION 3", "ACTIVITY 6", "FAILURE 2", "ARTIFACT 6"]}>
                {(filter, index) => (
                  <button
                    class={`border px-2 py-1 text-[9px] ${
                      index() === 0
                        ? "border-[#292923] bg-[#292923] text-white"
                        : "border-[#b8b6ad] hover:border-[#292923]"
                    }`}
                    type="button"
                  >
                    {filter}
                  </button>
                )}
              </For>
            </div>
          </div>
        </aside>

        <div class="min-w-0">
          <div class="grid grid-cols-[48px_54px_86px_110px_minmax(260px,1fr)_100px] border-[#292923] border-b bg-[#dedcd4] px-3 py-2 font-bold text-[9px]">
            <span>ORD</span>
            <span>ATT</span>
            <span>TIME</span>
            <span>ACTOR</span>
            <span>EVENT / SUBJECT</span>
            <span>RESULT</span>
          </div>
          <div>
            <For each={traceNodes}>
              {(node) => (
                <button
                  class={`grid w-full grid-cols-[48px_54px_86px_110px_minmax(260px,1fr)_100px] border-[#d2d0c7] border-b px-3 py-2.5 text-left text-[10px] hover:bg-[#ebe9e2] ${
                    props.selectedId === node.id ? "bg-[#fff8ca]" : ""
                  }`}
                  onClick={() => props.setSelectedId(node.id)}
                  type="button"
                >
                  <span class="text-[#77766d]">{String(node.ordinal).padStart(3, "0")}</span>
                  <span>{node.attempt}</span>
                  <span class="text-[#77766d]">{node.time.slice(0, 8)}</span>
                  <span class="truncate pr-4">{node.actor.split(" / ")[0]}</span>
                  <span class="min-w-0">
                    <span style={{ "padding-left": `${node.depth * 13}px` }}>
                      {node.depth ? "└─ " : ""}
                      <strong>{node.kind.toUpperCase()}</strong>
                      <span class="mx-2 text-[#aaa89f]">/</span>
                      {node.title}
                    </span>
                  </span>
                  <span
                    class={
                      node.status === "failed"
                        ? "font-bold text-[#c7392f]"
                        : node.status === "completed"
                          ? "text-emerald-700"
                          : "text-sky-700"
                    }
                  >
                    {statusLabel[node.status].toUpperCase()}
                  </span>
                </button>
              )}
            </For>
          </div>

          <section class="grid grid-cols-[minmax(0,1fr)_260px] border-[#292923] border-t-2 bg-[#e7e5dd]">
            <div class="p-4">
              <div class="flex items-center justify-between">
                <p class="font-bold text-[10px]">EVENT {props.selectedNode.ordinal} / DETAILS</p>
                <span class="text-[#77766d] text-[9px]">SCHEMA V1</span>
              </div>
              <h2 class="mt-3 font-sans font-semibold text-lg">{props.selectedNode.title}</h2>
              <p class="mt-2 max-w-3xl font-sans text-[#55544e] text-xs leading-5">
                {props.selectedNode.detail}
              </p>
              <div class="mt-4 flex gap-6 text-[9px]">
                <span>
                  CAUSED_BY: EVT-
                  {String(Math.max(1, props.selectedNode.ordinal - 1)).padStart(3, "0")}
                </span>
                <span>PARENT: SPAN-PRODUCT-SEARCH</span>
                <span>DURATION: {props.selectedNode.duration}</span>
              </div>
            </div>
            <div class="border-[#b8b6ad] border-l p-4">
              <p class="font-bold text-[10px]">REFERENCES</p>
              <div class="mt-3 border border-[#b8b6ad] bg-[#f4f2ec] p-2.5 text-[9px]">
                <p>ARTIFACT / activity-output.txt</p>
                <p class="mt-1 text-[#77766d]">SHA256 71d8…93a</p>
              </div>
              <button class="mt-2 text-[9px] underline underline-offset-2" type="button">
                OPEN IMMUTABLE ARTIFACT ↗
              </button>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

function LedgerFact(props: { danger?: boolean; label: string; value: string }) {
  return (
    <div class="flex items-center justify-between">
      <dt class="text-[#77766d]">{props.label}</dt>
      <dd class={props.danger ? "font-bold text-[#c7392f]" : "font-bold"}>{props.value}</dd>
    </div>
  );
}
