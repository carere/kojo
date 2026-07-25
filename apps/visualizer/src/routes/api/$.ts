import { createFileRoute } from "@tanstack/solid-router";
import { handleApiRequest } from "../../contexts/shared/server";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: ({ request }) => handleApiRequest(request),
    },
  },
});
