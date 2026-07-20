export const CONTAINER_PORT = 5173;
export const CONTAINER_WORKSPACE = "/home/agent/workspace";
export const CONTAINER_PATH = [
  "/home/agent/preview-bin",
  "/usr/local/bin",
  "/usr/local/bun-node-fallback-bin",
  "/home/agent/.proto/bin",
  "/home/agent/.cargo/bin",
  "/home/agent/.bun/bin",
  "/usr/local/sbin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
].join(":");

export const PREVIEW_LOG = "/tmp/delimoov-preview.log";
export const PREVIEW_LABEL = "dev.delimoov.preview";
export const REPOSITORY_LABEL = "dev.delimoov.preview.repository";
export const BRANCH_LABEL = "dev.delimoov.preview.branch";
export const HOSTNAME_LABEL = "dev.delimoov.preview.hostname";
export const WORKTREE_LABEL = "dev.delimoov.preview.worktree";
export const STARTUP_TIMEOUT_MS = 90_000;
