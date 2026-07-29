import type { HostOverview } from "@kojo/control";

export const renderHostOverview = (overview: HostOverview, json: boolean) => {
  if (json) {
    return `${JSON.stringify({ version: 1, command: "project.list", data: overview })}\n`;
  }

  const { host, projects } = overview;
  const projectLines =
    projects.length === 0
      ? "No Kojo Projects."
      : projects.map((project) => `${project.identity}\t${project.path}`).join("\n");

  return `Kojo Host ${host.hostVersion} (protocol ${host.protocol.major}.${host.protocol.minor})\n${projectLines}\n`;
};
