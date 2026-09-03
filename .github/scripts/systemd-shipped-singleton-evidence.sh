#!/usr/bin/env bash
set -Eeuo pipefail

managed_launcher=${1:?usage: systemd-shipped-singleton-evidence.sh MANAGED_LAUNCHER ENDPOINT LOG RECEIPT TIMEOUT}
endpoint=${2:?usage: systemd-shipped-singleton-evidence.sh MANAGED_LAUNCHER ENDPOINT LOG RECEIPT TIMEOUT}
log=${3:?usage: systemd-shipped-singleton-evidence.sh MANAGED_LAUNCHER ENDPOINT LOG RECEIPT TIMEOUT}
receipt=${4:?usage: systemd-shipped-singleton-evidence.sh MANAGED_LAUNCHER ENDPOINT LOG RECEIPT TIMEOUT}
timeout_duration=${5:?usage: systemd-shipped-singleton-evidence.sh MANAGED_LAUNCHER ENDPOINT LOG RECEIPT TIMEOUT}
timeout_command=${KOJO_EVIDENCE_TIMEOUT_COMMAND:-timeout}
expected_message="another Daemon start or purge transition owns the stable lifecycle gate"
expected_code=PURGE_GATE_HELD

active_instance_before=$(jq -er '.instanceId' "$endpoint")
set +e
PATH=/usr/bin:/bin KOJO_DAEMON_CHILD=1 \
  "$timeout_command" --signal=TERM --kill-after=1s "$timeout_duration" \
  "$managed_launcher" >"$log" 2>&1
exit_code=$?
set -e
active_instance_after=$(jq -er '.instanceId' "$endpoint" 2>/dev/null || true)

message_present=false
code_present=false
active_instance_unchanged=false
if grep -F "$expected_message" "$log" >/dev/null; then message_present=true; fi
if grep -F "$expected_code" "$log" >/dev/null; then code_present=true; fi
if [[ -n $active_instance_after && $active_instance_after == "$active_instance_before" ]]; then
  active_instance_unchanged=true
fi
accepted=false
if [[ $exit_code -eq 1 && $message_present == true && $code_present == true && $active_instance_unchanged == true ]]; then
  accepted=true
fi

jq -n \
  --arg executable "$managed_launcher" \
  --arg mode "KOJO_DAEMON_CHILD=1" \
  --arg expectedRefusal "$expected_code" \
  --arg expectedMessage "$expected_message" \
  --argjson exitCode "$exit_code" \
  --arg activeInstanceBefore "$active_instance_before" \
  --arg activeInstanceAfter "$active_instance_after" \
  --arg timeout "$timeout_duration" \
  --argjson messagePresent "$message_present" \
  --argjson codePresent "$code_present" \
  --argjson activeInstanceUnchanged "$active_instance_unchanged" \
  --argjson accepted "$accepted" \
  '{
    formatVersion: 1,
    executable: $executable,
    mode: $mode,
    bounded: true,
    timeout: $timeout,
    expectedRefusal: $expectedRefusal,
    expectedMessage: $expectedMessage,
    exitCode: $exitCode,
    refusalMessagePresent: $messagePresent,
    refusalCodePresent: $codePresent,
    activeInstanceId: $activeInstanceBefore,
    observedInstanceId: $activeInstanceAfter,
    activeInstanceBefore: $activeInstanceBefore,
    activeInstanceAfter: $activeInstanceAfter,
    activeInstanceUnchanged: $activeInstanceUnchanged,
    accepted: $accepted
  }' >"$receipt"

if [[ $accepted != true ]]; then
  echo "The duplicate shipped Daemon did not preserve the active Daemon owner." >&2
  exit 1
fi
