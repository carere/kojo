# Build from the repository root so the image can copy the canonical .prototools:
# moon run sandcastle:build-image
FROM oven/bun:1

# Install system dependencies
RUN apt-get update && apt-get install -y \
  build-essential \
  git \
  curl \
  gzip \
  jq \
  unzip \
  xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "bun" user and group to "agent", then align them
# with the host user so bind-mounted worktree files remain writable.
RUN groupmod -o -g "$AGENT_GID" -n agent bun \
  && usermod -o -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent bun

USER ${AGENT_UID}:${AGENT_GID}

WORKDIR /home/agent

# Keep global Bun packages in the agent's home so their launchers and package
# files remain accessible after dropping root privileges.
ENV BUN_INSTALL=/home/agent/.bun
ENV BUN_INSTALL_BIN=/home/agent/.bun/bin
ENV PROTO_HOME=/home/agent/.proto
ENV PATH=/home/agent/.proto/shims:/home/agent/.proto/bin:/home/agent/.cargo/bin:/home/agent/.bun/bin:${PATH}

# Install Proto without modifying shell profiles.
RUN bash -c 'bash <(curl -fsSL https://moonrepo.dev/install/proto.sh) --yes --no-profile'

# Install the repository toolchain once in the image. The runtime worktree has
# the same .prototools file, so Proto resolves the already-installed versions.
COPY --chown=${AGENT_UID}:${AGENT_GID} .prototools /home/agent/toolchain/.prototools
WORKDIR /home/agent/toolchain
RUN proto install --yes

# Vite runs on Node. Keep the executable outside Proto's version-resolving
# shims so bind-mounted worktrees do not trigger a network lookup for "latest".
RUN proto install node lts --yes

# The admin Moon task invokes `bun vite`. Vite 8 requires Node APIs that Bun
# does not implement, so previews put this narrow adapter before Bun on PATH.
RUN mkdir -p /home/agent/preview-bin \
  && printf '%s\n' \
    '#!/bin/sh' \
    'if [ "$1" = "vite" ]; then' \
    '  shift' \
    '  exec /home/agent/.proto/bin/node node_modules/vite/bin/vite.js "$@"' \
    'fi' \
    'exec /usr/local/bin/bun "$@"' \
    > /home/agent/preview-bin/bun \
  && chmod +x /home/agent/preview-bin/bun

# Codex is Sandcastle-specific and therefore does not belong in .prototools.
RUN bun add --global @openai/codex

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
