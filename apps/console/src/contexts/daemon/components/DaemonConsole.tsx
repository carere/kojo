import { type JSX, Match, Switch } from "solid-js";
import { ConsoleNavigation } from "../../shared/components/ConsoleNavigation.tsx";
import { useDaemon } from "../hooks/useDaemon.ts";
import { ConsoleAccessError } from "../services/browserAccess.ts";

const Detail = (props: { readonly name: string; readonly value: string }): JSX.Element => (
  <div class="border-border border-b py-3 last:border-0">
    <dt class="text-muted-foreground text-xs uppercase tracking-wide">{props.name}</dt>
    <dd class="mt-1 break-all font-medium text-sm">{props.value}</dd>
  </div>
);

export const DaemonConsole = (): JSX.Element => {
  const daemon = useDaemon();
  return (
    <div class="mx-auto grid min-h-screen max-w-6xl gap-8 p-4 lg:grid-cols-[13rem_1fr] lg:p-8">
      <ConsoleNavigation current="Daemon" />
      <main>
        <header class="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p class="text-muted-foreground text-sm">Local control plane</p>
            <h1 class="font-semibold text-3xl">Daemon</h1>
          </div>
          <span class="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-emerald-800 text-sm dark:text-emerald-200">
            {daemon.data === undefined ? "Connecting" : "Access active"}
          </span>
        </header>

        <Switch>
          <Match when={daemon.isPending}>
            <p role="status">Reading fresh Daemon state…</p>
          </Match>
          <Match when={daemon.data === undefined && daemon.error instanceof ConsoleAccessError}>
            <section class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-5">
              <h2 class="font-semibold text-lg">Console access is required</h2>
              <p class="mt-2">
                Run <code>kojo ui</code> again. The Console does not start the Daemon.
              </p>
            </section>
          </Match>
          <Match when={daemon.data === undefined && daemon.error !== null}>
            <section class="rounded-lg border border-red-500/40 bg-red-500/10 p-5">
              <h2 class="font-semibold text-lg">Daemon state is unavailable</h2>
              <p class="mt-2">
                Run <code>kojo daemon status</code> for the exact remedy.
              </p>
            </section>
          </Match>
          <Match when={daemon.data}>
            {(details) => (
              <div class="grid gap-6 xl:grid-cols-2">
                <section class="rounded-lg border border-border p-5">
                  <h2 class="font-semibold text-lg">Connection</h2>
                  <dl class="mt-3">
                    <Detail name="Access" value="Authenticated in this tab" />
                    <Detail name="Access expires" value={details().accessExpiresAt} />
                    <Detail name="Started" value={details().startedAt} />
                  </dl>
                </section>
                <section class="rounded-lg border border-border p-5">
                  <h2 class="font-semibold text-lg">Active managed release</h2>
                  <dl class="mt-3">
                    <Detail name="Release" value={details().releaseId} />
                    <Detail name="Kojo" value={details().packageVersion} />
                    <Detail name="Bun" value={details().bunVersion} />
                    <Detail name="Host" value={`${details().platform} ${details().architecture}`} />
                  </dl>
                </section>
                <section class="rounded-lg border border-border p-5 xl:col-span-2">
                  <h2 class="font-semibold text-lg">Identity</h2>
                  <dl class="mt-3 grid gap-x-8 md:grid-cols-2">
                    <Detail name="Daemon instance" value={details().instanceId} />
                    <Detail name="Daemon data" value={details().dataIdentity} />
                  </dl>
                </section>
                <section class="rounded-lg border border-border p-5 xl:col-span-2">
                  <h2 class="font-semibold text-lg">Projects</h2>
                  <p class="mt-2 text-muted-foreground">
                    {details().projectCount} Projects are registered. Opening this Console did not
                    start work.
                  </p>
                </section>
              </div>
            )}
          </Match>
        </Switch>
      </main>
    </div>
  );
};
