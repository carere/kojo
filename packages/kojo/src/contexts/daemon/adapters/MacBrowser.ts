import { spawnSync } from "node:child_process";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { BrowserService } from "../ports/BrowserService.ts";

export const macBrowser = (): BrowserService => ({
  open: (url) => {
    const opened = spawnSync("/usr/bin/open", [url], { stdio: "ignore" });
    if (opened.status !== 0) {
      throw new LifecycleError(
        "BROWSER_OPEN_FAILED",
        "the browser did not open; run `kojo ui --no-open` to receive a short-lived launch URL",
      );
    }
  },
});
