import { createFileRoute } from "@tanstack/solid-router";
import { DaemonConsole } from "../contexts/daemon/components/DaemonConsole.tsx";

export const Route = createFileRoute("/daemon")({ component: DaemonConsole });
