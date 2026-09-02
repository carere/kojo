#!/usr/bin/env bash
set -Eeuo pipefail

receipt=${1:?usage: systemd-shipped-linger-authorization.sh RECEIPT COMMAND_LOG LOGIN_STATE_RECEIPT LOGIN_STATE_STDERR MANAGED_KOJO LOGIN_STATE_HELPER USER UID EXPECTATION}
command_log=${2:?usage: systemd-shipped-linger-authorization.sh RECEIPT COMMAND_LOG LOGIN_STATE_RECEIPT LOGIN_STATE_STDERR MANAGED_KOJO LOGIN_STATE_HELPER USER UID EXPECTATION}
login_state_receipt=${3:?usage: systemd-shipped-linger-authorization.sh RECEIPT COMMAND_LOG LOGIN_STATE_RECEIPT LOGIN_STATE_STDERR MANAGED_KOJO LOGIN_STATE_HELPER USER UID EXPECTATION}
login_state_stderr=${4:?usage: systemd-shipped-linger-authorization.sh RECEIPT COMMAND_LOG LOGIN_STATE_RECEIPT LOGIN_STATE_STDERR MANAGED_KOJO LOGIN_STATE_HELPER USER UID EXPECTATION}
managed_kojo=${5:?usage: systemd-shipped-linger-authorization.sh RECEIPT COMMAND_LOG LOGIN_STATE_RECEIPT LOGIN_STATE_STDERR MANAGED_KOJO LOGIN_STATE_HELPER USER UID EXPECTATION}
login_state_helper=${6:?usage: systemd-shipped-linger-authorization.sh RECEIPT COMMAND_LOG LOGIN_STATE_RECEIPT LOGIN_STATE_STDERR MANAGED_KOJO LOGIN_STATE_HELPER USER UID EXPECTATION}
evidence_user=${7:?usage: systemd-shipped-linger-authorization.sh RECEIPT COMMAND_LOG LOGIN_STATE_RECEIPT LOGIN_STATE_STDERR MANAGED_KOJO LOGIN_STATE_HELPER USER UID EXPECTATION}
evidence_uid=${8:?usage: systemd-shipped-linger-authorization.sh RECEIPT COMMAND_LOG LOGIN_STATE_RECEIPT LOGIN_STATE_STDERR MANAGED_KOJO LOGIN_STATE_HELPER USER UID EXPECTATION}
expectation=${9:?usage: systemd-shipped-linger-authorization.sh RECEIPT COMMAND_LOG LOGIN_STATE_RECEIPT LOGIN_STATE_STDERR MANAGED_KOJO LOGIN_STATE_HELPER USER UID EXPECTATION}
timeout_command=${KOJO_EVIDENCE_TIMEOUT_COMMAND:-timeout}
command_timeout=${KOJO_EVIDENCE_LINGER_COMMAND_TIMEOUT:-60s}

if [[ $expectation != success-or-refusal && $expectation != success-required ]]; then
  echo "The linger authorization expectation is invalid." >&2
  exit 1
fi

expected_classification=explicit-linger-success
if [[ $expectation == success-or-refusal ]]; then
  expected_classification=explicit-linger-success-or-policy-refusal
fi

: >"$command_log"
set +e
LC_ALL=C "$timeout_command" --signal=TERM --kill-after=1s "$command_timeout" \
  "$managed_kojo" daemon keep-running-after-logout >"$command_log" 2>&1
command_status=$?
set -e

classification=unexpected-command-failure
expected_linger=
retry_required=false
retry_candidate=false
accepted=false
if [[ $command_status -eq 0 ]]; then
  if grep -Fqx \
    "This changes linger for the complete OS user. All user services can then run after logout." \
    "$command_log" && grep -Fqx "Keep running after logout: enabled." "$command_log"; then
    classification=host-authorized-success
    expected_linger=yes
  else
    classification=invalid-success-output
  fi
elif [[ $command_status -eq 124 || $command_status -eq 137 ]]; then
  classification=command-timed-out
elif [[ $command_status -eq 1 && $expectation == success-or-refusal ]] &&
  grep -Eq '^kojo: LINGER_PERMISSION_DENIED: .+' "$command_log"; then
  classification=host-policy-refusal
  expected_linger=no
  retry_candidate=true
fi

login_state_accepted=false
observed_linger=
if [[ -n $expected_linger ]]; then
  set +e
  bash "$login_state_helper" \
    "$login_state_receipt" \
    "$login_state_stderr" \
    "$evidence_user" \
    "$evidence_uid" \
    "$expected_linger" \
    present \
    1 \
    0s
  login_state_status=$?
  set -e
  if [[ -f $login_state_receipt ]]; then
    observed_linger=$(jq -r '.actual.linger // ""' "$login_state_receipt" 2>/dev/null || true)
  fi
  if [[ $login_state_status -eq 0 ]] && jq -e \
    --arg linger "$expected_linger" \
    '.accepted == true and
      .expected.classification == "login-state-matched-within-bound" and
      .expected.statusCommandExit == 0 and
      .expected.linger == $linger and
      .expected.sessions == "present" and
      .expected.state == "present" and
      .actual.classification == "login-state-matched-within-bound" and
      .actual.statusCommandExit == 0 and
      .actual.linger == $linger and
      (.actual.sessions | length) > 0 and
      (.actual.state | length) > 0 and
      .readOnly == true' \
    "$login_state_receipt" >/dev/null; then
    login_state_accepted=true
    accepted=true
    retry_required=$retry_candidate
  else
    classification=linger-state-not-confirmed
  fi
fi

jq -n \
  --arg expectation "$expectation" \
  --arg expectedClassification "$expected_classification" \
  --arg classification "$classification" \
  --argjson commandExit "$command_status" \
  --arg linger "$observed_linger" \
  --argjson loginStateAccepted "$login_state_accepted" \
  --argjson retryRequired "$retry_required" \
  --argjson accepted "$accepted" \
  '{
    formatVersion: 1,
    kind: "shipped-systemd-linger-authorization-attempt",
    expectation: $expectation,
    expected: {
      classification: $expectedClassification,
      command: "daemon keep-running-after-logout",
      commandExit: (if $expectation == "success-required" then 0 else "zero-or-linger-permission-denied" end),
      liveLoginState: "matched"
    },
    actual: {
      classification: $classification,
      commandExit: $commandExit,
      linger: $linger,
      loginStateAccepted: $loginStateAccepted
    },
    retryRequired: $retryRequired,
    accepted: $accepted
  }' >"$receipt"

if [[ $accepted != true ]]; then exit 1; fi
