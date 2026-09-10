FROM oven/bun:1.3.14-debian
ARG AGENT_UID=1000
ARG AGENT_GID=1000
ENV BUN_INSTALL=/usr/local
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates python3 make g++ chromium && rm -rf /var/lib/apt/lists/*
RUN bun add --global --trust @openai/codex@0.150.1 agent-browser@0.33.2 @moonrepo/cli@2.5.0
RUN groupadd -o -g "$AGENT_GID" agent && useradd -m -o -u "$AGENT_UID" -g agent -s /bin/bash agent
COPY ui-process.py /usr/local/lib/kojo-ui-process.py
COPY skills /home/agent/.agents/skills
RUN mkdir -p /home/agent/.codex && touch /home/agent/.codex/auth.json && chown -R "$AGENT_UID:$AGENT_GID" /home/agent
ENV HOME=/home/agent
USER agent
WORKDIR /workspace
CMD ["sleep", "infinity"]
