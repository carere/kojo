import { join } from "node:path";
import type { DaemonPaths } from "../models/DaemonPaths.ts";

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const entry = (key: string, value: string): string =>
  `    <key>${key}</key>\n    <string>${escapeXml(value)}</string>`;

export const launchAgentDocument = (
  paths: DaemonPaths,
  options: { readonly label?: string; readonly home?: string } = {},
): string => {
  const label = options.label ?? "dev.kojo.daemon";
  const home = options.home ?? process.env.HOME ?? "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entry("Label", label)}
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(paths.managedLauncher)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${entry("HOME", home)}
${entry("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")}
${entry("KOJO_MANAGED_INSTALLATION", paths.installationRoot)}
${entry("KOJO_DAEMON_DATA", paths.dataRoot)}
${entry("KOJO_DAEMON_RUNTIME", paths.runtimeRoot)}
${entry("KOJO_DAEMON_CONFIG", paths.configurationRoot)}
${entry("KOJO_DAEMON_CACHE", paths.cacheRoot)}
    </dict>
${entry("WorkingDirectory", paths.installationRoot)}
${entry("StandardOutPath", join(paths.cacheRoot, "daemon.stdout.log"))}
${entry("StandardErrorPath", join(paths.cacheRoot, "daemon.stderr.log"))}
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>ExitTimeOut</key>
    <integer>30</integer>
    <key>ThrottleInterval</key>
    <integer>1</integer>
</dict>
</plist>
`;
};
