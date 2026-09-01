import { describe, expect, it } from "vitest";
import { kojoPi } from "../../../../../src/contexts/agent/adapters/kojoPi.ts";

describe("Kojo pi provider", () => {
  it("keeps authored identity and captured session storage on the provider", () => {
    const provider = kojoPi({
      model: "fixture-model",
      system: "Inspect only.",
      tools: ["read", "grep"],
      sessions: { host: "/tmp/kojo-pi-host", sandbox: "/tmp/kojo-pi-sandbox" },
    });
    const command = provider.buildPrintCommand({
      prompt: "inspect",
      dangerouslySkipPermissions: true,
    });

    expect(command.command).toContain("--system-prompt 'Inspect only.'");
    expect(command.command).toContain("--tools 'read,grep'");
    expect(command.stdin).toBe("inspect");
    expect(provider.sessionStorage).toBeDefined();
  });
});
