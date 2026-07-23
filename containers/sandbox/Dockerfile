FROM oven/bun:1.3.14

RUN apt-get update \
  && apt-get install --yes --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupmod --non-unique --gid "$AGENT_GID" --new-name agent bun \
  && usermod --non-unique --uid "$AGENT_UID" --gid "$AGENT_GID" \
    --home /home/agent --move-home --login agent bun

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent/workspace

ENTRYPOINT ["sleep", "infinity"]
