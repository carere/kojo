export type NotificationResource = "askings" | "daemon" | "projects" | "runs" | "workflows";

const encoder = new TextEncoder();

/** Bounded, best-effort invalidation notices. Authoritative snapshots remain the correctness state. */
export class DaemonNotifications {
  readonly #clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  #sequence = 0;

  readonly response = (signal: AbortSignal): Response => {
    const clients = this.#clients;
    let owned: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          owned = controller;
          clients.add(controller);
          this.#enqueue(controller, ["daemon", "projects", "workflows", "runs", "askings"]);
          signal.addEventListener("abort", () => clients.delete(controller), { once: true });
        },
        cancel: () => {
          if (owned !== undefined) clients.delete(owned);
        },
      },
      { highWaterMark: 4 },
    );
    return new Response(stream, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
      },
    });
  };

  readonly publish = (resources: ReadonlyArray<NotificationResource>): void => {
    this.#sequence += 1;
    for (const client of this.#clients) this.#enqueue(client, resources);
  };

  readonly close = (): void => {
    for (const client of this.#clients) client.close();
    this.#clients.clear();
  };

  readonly subscriberCount = (): number => this.#clients.size;

  #enqueue(
    client: ReadableStreamDefaultController<Uint8Array>,
    resources: ReadonlyArray<NotificationResource>,
  ): void {
    if ((client.desiredSize ?? 0) <= 0) {
      client.close();
      this.#clients.delete(client);
      return;
    }
    client.enqueue(
      encoder.encode(
        `event: invalidate\ndata: ${JSON.stringify({ notificationVersion: 1, sequence: this.#sequence, resources })}\n\n`,
      ),
    );
  }
}
