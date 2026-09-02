#!/usr/bin/env bash
set -Eeuo pipefail

observations=${1:?usage: systemd-shipped-logout-readiness.sh OBSERVATIONS FINAL STDERR USER UID ENDPOINT BUS LIMIT INTERVAL}
final=${2:?usage: systemd-shipped-logout-readiness.sh OBSERVATIONS FINAL STDERR USER UID ENDPOINT BUS LIMIT INTERVAL}
stderr_log=${3:?usage: systemd-shipped-logout-readiness.sh OBSERVATIONS FINAL STDERR USER UID ENDPOINT BUS LIMIT INTERVAL}
evidence_user=${4:?usage: systemd-shipped-logout-readiness.sh OBSERVATIONS FINAL STDERR USER UID ENDPOINT BUS LIMIT INTERVAL}
evidence_uid=${5:?usage: systemd-shipped-logout-readiness.sh OBSERVATIONS FINAL STDERR USER UID ENDPOINT BUS LIMIT INTERVAL}
endpoint=${6:?usage: systemd-shipped-logout-readiness.sh OBSERVATIONS FINAL STDERR USER UID ENDPOINT BUS LIMIT INTERVAL}
bus=${7:?usage: systemd-shipped-logout-readiness.sh OBSERVATIONS FINAL STDERR USER UID ENDPOINT BUS LIMIT INTERVAL}
attempt_limit=${8:?usage: systemd-shipped-logout-readiness.sh OBSERVATIONS FINAL STDERR USER UID ENDPOINT BUS LIMIT INTERVAL}
interval=${9:?usage: systemd-shipped-logout-readiness.sh OBSERVATIONS FINAL STDERR USER UID ENDPOINT BUS LIMIT INTERVAL}
systemctl_command=${KOJO_EVIDENCE_SYSTEMCTL_COMMAND:-/usr/bin/systemctl}
loginctl_command=${KOJO_EVIDENCE_LOGINCTL_COMMAND:-/usr/bin/loginctl}
sleep_command=${KOJO_EVIDENCE_SLEEP_COMMAND:-sleep}
timeout_command=${KOJO_EVIDENCE_TIMEOUT_COMMAND:-timeout}
probe_timeout=${KOJO_EVIDENCE_PROBE_TIMEOUT:-1s}
cgroup_root=${KOJO_EVIDENCE_CGROUP_ROOT:-/sys/fs/cgroup}

if [[ ! $attempt_limit =~ ^[1-9][0-9]*$ ]]; then
  echo "The systemd final-logout readiness attempt limit is invalid." >&2
  exit 1
fi

: >"$observations"
: >"$stderr_log"
logout_complete=false
observation_count=0
manager_status=1
manager_classification=probe-not-run
manager_active_state=unknown
manager_sub_state=unknown
manager_job=unknown
manager_job_present=true
manager_control_group=
manager_cgroup_populated_json=null
manager_cgroup_state=unknown
login_status=1
login_classification=probe-not-run
login_user_present_json=null
login_sessions=unknown
login_linger=unknown
login_state=unknown
endpoint_present=true
bus_present=true
for ((observation = 1; observation <= attempt_limit; observation++)); do
  observation_count=$observation
  printf 'Observation=%s\n' "$observation" >>"$stderr_log"
  set +e
  manager_error_file=$stderr_log.manager-current
  login_error_file=$stderr_log.login-current
  : >"$manager_error_file"
  : >"$login_error_file"
  manager_properties=$(LC_ALL=C "$timeout_command" --signal=TERM --kill-after=1s "$probe_timeout" \
    "$systemctl_command" show "user@$evidence_uid.service" \
    --property=ActiveState,SubState,Job,ControlGroup 2>"$manager_error_file")
  manager_status=$?
  login_properties=$(LC_ALL=C "$timeout_command" --signal=TERM --kill-after=1s "$probe_timeout" \
    "$loginctl_command" show-user "$evidence_user" \
    --property=Sessions,Linger,State 2>"$login_error_file")
  login_status=$?
  set -e
  manager_error=$(<"$manager_error_file")
  login_error=$(<"$login_error_file")
  rm -f "$manager_error_file" "$login_error_file"
  if [[ -n $manager_error ]]; then printf 'ManagerProbeStderr=%s\n' "$manager_error" >>"$stderr_log"; fi
  if [[ -n $login_error ]]; then printf 'LoginProbeStderr=%s\n' "$login_error" >>"$stderr_log"; fi

  manager_classification=probe-failed
  if [[ $manager_status -eq 0 ]]; then manager_classification=properties-returned; fi
  if [[ $manager_status -eq 124 || $manager_status -eq 137 ]]; then
    manager_classification=probe-timed-out
  fi

  manager_active_state=unknown
  manager_sub_state=unknown
  manager_job=unknown
  manager_job_present=true
  manager_control_group=
  while IFS='=' read -r property value; do
    case "$property" in
      ActiveState) manager_active_state=$value ;;
      SubState) manager_sub_state=$value ;;
      Job) manager_job=$value ;;
      ControlGroup) manager_control_group=$value ;;
    esac
  done <<<"$manager_properties"
  if [[ -z $manager_job || $manager_job == 0 ]]; then manager_job_present=false; fi

  login_classification=probe-failed
  login_user_present_json=null
  login_sessions=
  login_linger=
  login_state=
  if [[ $login_status -eq 0 ]]; then
    login_classification=user-present
    login_user_present_json=true
    while IFS='=' read -r property value; do
      case "$property" in
        Sessions) login_sessions=$value ;;
        Linger) login_linger=$value ;;
        State) login_state=$value ;;
      esac
    done <<<"$login_properties"
  elif [[ $login_status -eq 1 && \
    $login_error == *"User ID $evidence_uid is not logged in or lingering"* ]]; then
    login_classification=user-absent
    login_user_present_json=false
  elif [[ $login_status -eq 124 || $login_status -eq 137 ]]; then
    login_classification=probe-timed-out
  fi

  manager_cgroup_populated_json=null
  manager_cgroup_state=unknown
  manager_cgroup_path=$cgroup_root$manager_control_group
  cgroup_events=$manager_cgroup_path/cgroup.events
  if [[ -z $manager_control_group || ! -e $manager_cgroup_path ]]; then
    manager_cgroup_populated_json=false
    manager_cgroup_state=absent
  elif [[ -r $cgroup_events ]]; then
    while read -r property value; do
      if [[ $property == populated && $value == 0 ]]; then
        manager_cgroup_populated_json=false
        manager_cgroup_state=empty
      fi
      if [[ $property == populated && $value == 1 ]]; then
        manager_cgroup_populated_json=true
        manager_cgroup_state=populated
      fi
    done <"$cgroup_events"
  else
    manager_cgroup_state=unreadable
  fi
  endpoint_present=false
  if [[ -e $endpoint ]]; then endpoint_present=true; fi
  bus_present=false
  if [[ -e $bus ]]; then bus_present=true; fi

  actual_classification=logout-incomplete
  if [[ $manager_status -eq 0 && $manager_active_state == inactive && \
    $manager_sub_state == dead && $manager_job_present == false && \
    $manager_cgroup_populated_json == false && $login_user_present_json == false && \
    $endpoint_present == false && $bus_present == false ]]; then
    logout_complete=true
    actual_classification=logout-complete
  fi

  jq -cn \
    --argjson observation "$observation" \
    --arg actualClassification "$actual_classification" \
    --argjson managerStatus "$manager_status" \
    --arg managerClassification "$manager_classification" \
    --arg managerActiveState "$manager_active_state" \
    --arg managerSubState "$manager_sub_state" \
    --arg managerJob "$manager_job" \
    --argjson managerJobPresent "$manager_job_present" \
    --arg managerControlGroup "$manager_control_group" \
    --argjson managerCgroupPopulated "$manager_cgroup_populated_json" \
    --arg managerCgroupState "$manager_cgroup_state" \
    --argjson loginStatus "$login_status" \
    --arg loginClassification "$login_classification" \
    --argjson loginUserPresent "$login_user_present_json" \
    --arg loginSessions "$login_sessions" \
    --arg loginLinger "$login_linger" \
    --arg loginState "$login_state" \
    --argjson endpointPresent "$endpoint_present" \
    --argjson busPresent "$bus_present" \
    '{
      observation: $observation,
      expected: {
        classification: "logout-complete",
        managerStatus: 0,
        managerClassification: "properties-returned",
        managerActiveState: "inactive",
        managerSubState: "dead",
        managerJobPresent: false,
        managerCgroupPopulated: false,
        loginClassification: "user-absent",
        loginUserPresent: false,
        endpointPresent: false,
        busPresent: false
      },
      actual: {
        classification: $actualClassification,
        managerStatus: $managerStatus,
        managerClassification: $managerClassification,
        managerActiveState: $managerActiveState,
        managerSubState: $managerSubState,
        managerJob: $managerJob,
        managerJobPresent: $managerJobPresent,
        managerControlGroup: $managerControlGroup,
        managerCgroupPopulated: $managerCgroupPopulated,
        managerCgroupState: $managerCgroupState,
        loginStatus: $loginStatus,
        loginClassification: $loginClassification,
        loginUserPresent: $loginUserPresent,
        loginSessions: $loginSessions,
        loginLinger: $loginLinger,
        loginState: $loginState,
        endpointPresent: $endpointPresent,
        busPresent: $busPresent
      }
    }' >>"$observations"
  if [[ $logout_complete == true ]]; then break; fi
  if [[ $observation -lt $attempt_limit ]]; then "$sleep_command" "$interval"; fi
done

final_actual_classification=logout-not-complete-within-bound
if [[ $logout_complete == true ]]; then final_actual_classification=logout-complete-within-bound; fi
jq -n \
  --argjson attemptLimit "$attempt_limit" \
  --arg interval "$interval" \
  --arg probeTimeout "$probe_timeout" \
  --argjson observationCount "$observation_count" \
  --arg actualClassification "$final_actual_classification" \
  --argjson managerStatus "$manager_status" \
  --arg managerClassification "$manager_classification" \
  --arg managerActiveState "$manager_active_state" \
  --arg managerSubState "$manager_sub_state" \
  --arg managerJob "$manager_job" \
  --argjson managerJobPresent "$manager_job_present" \
  --arg managerControlGroup "$manager_control_group" \
  --argjson managerCgroupPopulated "$manager_cgroup_populated_json" \
  --arg managerCgroupState "$manager_cgroup_state" \
  --argjson loginStatus "$login_status" \
  --arg loginClassification "$login_classification" \
  --argjson loginUserPresent "$login_user_present_json" \
  --arg loginSessions "$login_sessions" \
  --arg loginLinger "$login_linger" \
  --arg loginState "$login_state" \
  --argjson endpointPresent "$endpoint_present" \
  --argjson busPresent "$bus_present" \
  --argjson accepted "$logout_complete" \
  '{
    formatVersion: 1,
    kind: "bounded-systemd-final-logout-readiness",
    attemptLimit: $attemptLimit,
    interval: $interval,
    probeTimeout: $probeTimeout,
    observationCount: $observationCount,
    expected: {
      classification: "logout-complete-within-bound",
      managerActiveState: "inactive",
      managerSubState: "dead",
      managerJobPresent: false,
      managerCgroupPopulated: false,
      loginClassification: "user-absent",
      loginUserPresent: false,
      endpointPresent: false,
      busPresent: false
    },
    actual: {
      classification: $actualClassification,
      managerStatus: $managerStatus,
      managerClassification: $managerClassification,
      managerActiveState: $managerActiveState,
      managerSubState: $managerSubState,
      managerJob: $managerJob,
      managerJobPresent: $managerJobPresent,
      managerControlGroup: $managerControlGroup,
      managerCgroupPopulated: $managerCgroupPopulated,
      managerCgroupState: $managerCgroupState,
      loginStatus: $loginStatus,
      loginClassification: $loginClassification,
      loginUserPresent: $loginUserPresent,
      loginSessions: $loginSessions,
      loginLinger: $loginLinger,
      loginState: $loginState,
      endpointPresent: $endpointPresent,
      busPresent: $busPresent
    },
    noServiceStartRepairOrLingerChange: true,
    accepted: $accepted
  }' >"$final"

if [[ $logout_complete != true ]]; then exit 1; fi
