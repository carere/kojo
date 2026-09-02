#!/usr/bin/env bash
set -Eeuo pipefail

observations=${1:?usage: systemd-shipped-login-readiness.sh OBSERVATIONS FINAL STDERR LIMIT INTERVAL}
final=${2:?usage: systemd-shipped-login-readiness.sh OBSERVATIONS FINAL STDERR LIMIT INTERVAL}
stderr_log=${3:?usage: systemd-shipped-login-readiness.sh OBSERVATIONS FINAL STDERR LIMIT INTERVAL}
attempt_limit=${4:?usage: systemd-shipped-login-readiness.sh OBSERVATIONS FINAL STDERR LIMIT INTERVAL}
interval=${5:?usage: systemd-shipped-login-readiness.sh OBSERVATIONS FINAL STDERR LIMIT INTERVAL}
systemctl_command=${KOJO_EVIDENCE_SYSTEMCTL_COMMAND:-/usr/bin/systemctl}
sleep_command=${KOJO_EVIDENCE_SLEEP_COMMAND:-sleep}
timeout_command=${KOJO_EVIDENCE_TIMEOUT_COMMAND:-timeout}
probe_timeout=${KOJO_EVIDENCE_PROBE_TIMEOUT:-1s}

if [[ ! $attempt_limit =~ ^[1-9][0-9]*$ ]]; then
  echo "The systemd login readiness attempt limit is invalid." >&2
  exit 1
fi

: >"$observations"
: >"$stderr_log"
manager_ready=false
observation_count=0
last_status=1
for ((observation = 1; observation <= attempt_limit; observation++)); do
  observation_count=$observation
  printf 'Observation=%s\n' "$observation" >>"$stderr_log"
  set +e
  "$timeout_command" --signal=TERM --kill-after=1s "$probe_timeout" \
    "$systemctl_command" --user show-environment >/dev/null 2>>"$stderr_log"
  last_status=$?
  set -e
  if [[ $last_status -eq 0 ]]; then manager_ready=true; fi
  jq -cn \
    --argjson observation "$observation" \
    --argjson statusCommandExit "$last_status" \
    --argjson managerReady "$manager_ready" \
    '{
      observation: $observation,
      statusCommandExit: $statusCommandExit,
      managerReady: $managerReady
    }' >>"$observations"
  if [[ $manager_ready == true ]]; then break; fi
  if [[ $observation -lt $attempt_limit ]]; then "$sleep_command" "$interval"; fi
done

jq -n \
  --argjson attemptLimit "$attempt_limit" \
  --arg interval "$interval" \
  --arg probeTimeout "$probe_timeout" \
  --argjson observationCount "$observation_count" \
  --argjson lastStatusCommandExit "$last_status" \
  --argjson managerReady "$manager_ready" \
  '{
    formatVersion: 1,
    kind: "bounded-systemd-login-readiness",
    attemptLimit: $attemptLimit,
    interval: $interval,
    probeTimeout: $probeTimeout,
    observationCount: $observationCount,
    lastStatusCommandExit: $lastStatusCommandExit,
    managerReady: $managerReady,
    noServiceStartRepairOrLingerChange: true,
    accepted: $managerReady
  }' >"$final"

if [[ $manager_ready != true ]]; then exit 1; fi
