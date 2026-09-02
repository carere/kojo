import { useQueryClient } from "@tanstack/solid-query";
import { type JSX, Show } from "solid-js";
import { Notice } from "../../shared/components/Notice.tsx";
import {
  beginDaemonReconnect,
  completeDaemonReconnect,
  daemonConnectionState,
  requireDaemonReconnect,
} from "../services/connectionState.ts";

export const DaemonConnectionNotice = (): JSX.Element => {
  const client = useQueryClient();
  const reconnect = (): void => {
    beginDaemonReconnect();
    void client.resetQueries().then(completeDaemonReconnect, requireDaemonReconnect);
  };
  return (
    <Show when={daemonConnectionState() === "reconnect"}>
      <div class="mx-auto w-full max-w-5xl px-6 pt-4">
        <Notice tone="retrying" title="Reconnect to the Daemon">
          <p class="mt-1">Reads are stale. Kojo disabled all mutations.</p>
          <button class="mt-2 underline underline-offset-2" type="button" onClick={reconnect}>
            Reconnect
          </button>
        </Notice>
      </div>
    </Show>
  );
};
