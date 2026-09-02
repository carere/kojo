#!/usr/bin/env bash
set -Eeuo pipefail

receipt=${1:?usage: systemd-shipped-login-state-evidence.sh RECEIPT STDERR USER UID LINGER SESSIONS LIMIT INTERVAL}
stderr_log=${2:?usage: systemd-shipped-login-state-evidence.sh RECEIPT STDERR USER UID LINGER SESSIONS LIMIT INTERVAL}
evidence_user=${3:?usage: systemd-shipped-login-state-evidence.sh RECEIPT STDERR USER UID LINGER SESSIONS LIMIT INTERVAL}
evidence_uid=${4:?usage: systemd-shipped-login-state-evidence.sh RECEIPT STDERR USER UID LINGER SESSIONS LIMIT INTERVAL}
expected_linger=${5:?usage: systemd-shipped-login-state-evidence.sh RECEIPT STDERR USER UID LINGER SESSIONS LIMIT INTERVAL}
expected_sessions=${6:?usage: systemd-shipped-login-state-evidence.sh RECEIPT STDERR USER UID LINGER SESSIONS LIMIT INTERVAL}
attempt_limit=${7:?usage: systemd-shipped-login-state-evidence.sh RECEIPT STDERR USER UID LINGER SESSIONS LIMIT INTERVAL}
interval=${8:?usage: systemd-shipped-login-state-evidence.sh RECEIPT STDERR USER UID LINGER SESSIONS LIMIT INTERVAL}
loginctl_command=${KOJO_EVIDENCE_LOGINCTL_COMMAND:-/usr/bin/loginctl}
sleep_command=${KOJO_EVIDENCE_SLEEP_COMMAND:-sleep}
timeout_command=${KOJO_EVIDENCE_TIMEOUT_COMMAND:-timeout}
probe_timeout=${KOJO_EVIDENCE_PROBE_TIMEOUT:-1s}

if [[ $expected_linger != no && $expected_linger != yes ]]; then
  echo "The expected systemd linger value is invalid." >&2
  exit 1
fi
if [[ $expected_sessions != present && $expected_sessions != absent ]]; then
  echo "The expected systemd session state is invalid." >&2
  exit 1
fi
if [[ ! $attempt_limit =~ ^[1-9][0-9]*$ ]]; then
  echo "The systemd login-state attempt limit is invalid." >&2
  exit 1
fi

observations_file=$receipt.observations-current
probe_error_file=$stderr_log.probe-current
: >"$observations_file"
: >"$stderr_log"
accepted=false
observation_count=0
status=1
linger=
sessions=
state=
classification=probe-not-run
for ((observation = 1; observation <= attempt_limit; observation++)); do
  observation_count=$observation
  : >"$probe_error_file"
  set +e
  properties=$(LC_ALL=C "$timeout_command" --signal=TERM --kill-after=1s "$probe_timeout" \
    "$loginctl_command" show-user "$evidence_uid" \
    --property=Sessions,Linger,State 2>"$probe_error_file")
  status=$?
  set -e
  probe_error=$(<"$probe_error_file")
  if [[ -n $probe_error ]]; then
    printf 'Observation=%s LoginProbeStderr=%s\n' "$observation" "$probe_error" >>"$stderr_log"
  fi

  linger=
  sessions=
  state=
  if [[ $status -eq 0 ]]; then
    while IFS='=' read -r property value; do
      case "$property" in
        Linger) linger=$value ;;
        Sessions) sessions=$value ;;
        State) state=$value ;;
      esac
    done <<<"$properties"
  fi
  sessions_present=false
  if [[ -n $sessions ]]; then sessions_present=true; fi
  sessions_match=false
  if [[ $expected_sessions == present && $sessions_present == true ]]; then sessions_match=true; fi
  if [[ $expected_sessions == absent && $sessions_present == false ]]; then sessions_match=true; fi

  classification=login-state-mismatch
  if [[ $status -eq 124 || $status -eq 137 ]]; then
    classification=probe-timed-out
  elif [[ $status -ne 0 ]]; then
    classification=probe-failed
  elif [[ $linger == "$expected_linger" && $sessions_match == true ]]; then
    classification=login-state-matched
    accepted=true
  fi
  jq -cn \
    --argjson observation "$observation" \
    --arg expectedLinger "$expected_linger" \
    --arg expectedSessions "$expected_sessions" \
    --argjson statusCommandExit "$status" \
    --arg linger "$linger" \
    --arg sessions "$sessions" \
    --arg state "$state" \
    --arg classification "$classification" \
    '{
      observation: $observation,
      expected: {
        classification: "login-state-matched",
        statusCommandExit: 0,
        linger: $expectedLinger,
        sessions: $expectedSessions
      },
      actual: {
        classification: $classification,
        statusCommandExit: $statusCommandExit,
        linger: $linger,
        sessions: $sessions,
        state: $state
      }
    }' >>"$observations_file"
  if [[ $accepted == true ]]; then break; fi
  if [[ $observation -lt $attempt_limit ]]; then "$sleep_command" "$interval"; fi
done

final_classification=login-state-not-matched-within-bound
if [[ $accepted == true ]]; then final_classification=login-state-matched-within-bound; fi
jq -s \
  --arg user "$evidence_user" \
  --argjson uid "$evidence_uid" \
  --arg expectedLinger "$expected_linger" \
  --arg expectedSessions "$expected_sessions" \
  --argjson attemptLimit "$attempt_limit" \
  --arg interval "$interval" \
  --arg probeTimeout "$probe_timeout" \
  --argjson observationCount "$observation_count" \
  --arg classification "$final_classification" \
  --argjson statusCommandExit "$status" \
  --arg linger "$linger" \
  --arg sessions "$sessions" \
  --arg state "$state" \
  --argjson accepted "$accepted" \
  '{
    formatVersion: 1,
    kind: "bounded-systemd-login-state",
    user: $user,
    uid: $uid,
    attemptLimit: $attemptLimit,
    interval: $interval,
    probeTimeout: $probeTimeout,
    observationCount: $observationCount,
    expected: {
      classification: "login-state-matched-within-bound",
      statusCommandExit: 0,
      linger: $expectedLinger,
      sessions: $expectedSessions
    },
    actual: {
      classification: $classification,
      statusCommandExit: $statusCommandExit,
      linger: $linger,
      sessions: $sessions,
      state: $state
    },
    observations: .,
    readOnly: true,
    accepted: $accepted
  }' "$observations_file" >"$receipt"
rm -f "$observations_file" "$probe_error_file"

if [[ $accepted != true ]]; then exit 1; fi
