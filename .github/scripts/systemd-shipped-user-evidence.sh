#!/usr/bin/env bash
set -euo pipefail

workspace=${1:?usage: systemd-shipped-user-evidence.sh WORKSPACE EVIDENCE_DIRECTORY PACKAGE_DIRECTORY}
evidence_directory=${2:?usage: systemd-shipped-user-evidence.sh WORKSPACE EVIDENCE_DIRECTORY PACKAGE_DIRECTORY}
package_directory=${3:?usage: systemd-shipped-user-evidence.sh WORKSPACE EVIDENCE_DIRECTORY PACKAGE_DIRECTORY}
helper=$workspace/packages/kojo/tests/release/support/shippedFactory.ts
registry_helper=$workspace/packages/kojo/tests/release/support/shippedPackageRegistry.ts
workflow_observation_helper=$workspace/packages/kojo/tests/support/release/ShippedWorkflowObservation.ts
run_evidence_helper=$workspace/packages/kojo/tests/support/release/ShippedRunEvidence.ts
candidate_tools=$HOME/.kojo-evidence-global-tools
project=$HOME/kojo-shipped-project
candidate_bun=$candidate_tools/bin/bun
candidate_kojo=$candidate_tools/bin/kojo
managed_kojo=$XDG_DATA_HOME/kojo/bin/kojo
managed_launcher=$XDG_DATA_HOME/kojo/bin/kojo-launcher
singleton_evidence_script=$workspace/.github/scripts/systemd-shipped-singleton-evidence.sh
login_state_evidence_script=$workspace/.github/scripts/systemd-shipped-login-state-evidence.sh
endpoint=$XDG_RUNTIME_DIR/kojo/endpoint.json
socket=$XDG_RUNTIME_DIR/kojo/daemon.sock

if [[ $(id -u) -eq 0 ]]; then
  echo "The shipped user check must run as the isolated non-root evidence user." >&2
  exit 1
fi
for path in "$candidate_tools" "$project" "$XDG_DATA_HOME/kojo" "$XDG_STATE_HOME/kojo" "$XDG_CONFIG_HOME/kojo"; do
  if [[ -e $path ]]; then
    echo "The isolated evidence path already exists: $path" >&2
    exit 1
  fi
done

moon run kojo:test-host >"$evidence_directory/native-host-tests.log" 2>&1
grep -E "^ ✓ .*the native systemd user Daemon lifecycle" \
  "$evidence_directory/native-host-tests.log" >/dev/null
grep -E "^ ↓ .*the native macOS Daemon lifecycle" \
  "$evidence_directory/native-host-tests.log" >/dev/null
grep -E "Tests[[:space:]]+1 passed[[:space:]]+\|[[:space:]]+1 skipped \(2\)" \
  "$evidence_directory/native-host-tests.log" >/dev/null

mkdir -p "$candidate_tools/bin" "$evidence_directory"
install -m 0700 /usr/local/bin/bun "$candidate_bun"
registry_address=$evidence_directory/package-registry-address
registry_pid=
cleanup_registry() {
  if [[ -n $registry_pid ]]; then
    kill "$registry_pid" 2>/dev/null || true
  fi
}
trap cleanup_registry EXIT
"$candidate_bun" "$registry_helper" "$package_directory" "$registry_address" \
  >"$evidence_directory/package-registry.log" 2>&1 &
registry_pid=$!
for _ in $(seq 1 120); do
  [[ -s $registry_address ]] && break
  kill -0 "$registry_pid"
  sleep 1
done
registry=$(cat "$registry_address")
BUN_INSTALL="$candidate_tools" BUN_CONFIG_REGISTRY="$registry" \
  "$candidate_bun" add -g @carere/kojo \
  >"$evidence_directory/candidate-install.log" 2>&1
kill "$registry_pid"
wait "$registry_pid" 2>/dev/null || true
registry_pid=
export PATH="$candidate_tools/bin:$PATH"
"$candidate_kojo" --version >"$evidence_directory/candidate-version.log"

"$candidate_bun" "$helper" prepare "$project" "$package_directory" \
  >"$evidence_directory/factory-prepare.log"
(cd "$project" && \
  "$candidate_kojo" init \
    --agent pi \
    --model controlled-no-provider \
    --sandbox none \
    --template review \
    --package-manager bun) \
  >"$evidence_directory/fresh-init.log"
"$candidate_bun" "$helper" author "$project" "$package_directory" \
  >"$evidence_directory/factory-authoring.log" 2>&1
(cd "$project" && "$candidate_bun" install) \
  >"$evidence_directory/factory-install.log" 2>&1
(cd "$project" && "$candidate_kojo" doctor) >"$evidence_directory/fresh-doctor.log"
grep -F "factory" "$evidence_directory/fresh-doctor.log" >/dev/null

"$candidate_kojo" daemon install >"$evidence_directory/daemon-install.log"
test -x "$managed_kojo"
test -x "$managed_launcher"
test -f "$XDG_DATA_HOME/kojo/active-release"
release_id=$(cat "$XDG_DATA_HOME/kojo/active-release")
managed_bun=$XDG_DATA_HOME/kojo/releases/$release_id/runtime/bun
managed_console=$XDG_DATA_HOME/kojo/releases/$release_id/console/index.html
test -x "$managed_bun"
test -f "$managed_console"
[[ $("$managed_bun" --version) == "$("$candidate_bun" --version)" ]]
sha256sum "$candidate_bun" "$managed_bun" >"$evidence_directory/managed-bun-sha256.log"
[[ $(awk 'NR == 1 { print $1 }' "$evidence_directory/managed-bun-sha256.log") == \
  "$(awk 'NR == 2 { print $1 }' "$evidence_directory/managed-bun-sha256.log")" ]]
test -f "$XDG_CONFIG_HOME/systemd/user/kojo.service"

# Install promises to enable and start the service. It reports the status observed at that instant;
# readiness is a later Daemon fact. Observe that fact without a repair, restart, or second Start.
readiness_observations=$evidence_directory/managed-readiness-observations.jsonl
readiness_current=$evidence_directory/managed-readiness-current.json
readiness_final=$evidence_directory/managed-readiness-final.json
readiness_stderr=$evidence_directory/managed-readiness-status.stderr.log
: >"$readiness_observations"
: >"$readiness_current"
: >"$readiness_stderr"
daemon_ready=no
for observation in $(seq 1 120); do
  printf 'Observation=%s\n' "$observation" >>"$readiness_stderr"
  if PATH=/usr/bin:/bin "$managed_kojo" daemon status --json \
    >"$readiness_current" 2>>"$readiness_stderr"; then
    jq -c --argjson observation "$observation" \
      '{ observation: $observation, status: . }' "$readiness_current" \
      >>"$readiness_observations"
    if jq -e '
      .formatVersion == 1 and
      .daemon.installed == true and
      .daemon.manager == "loaded" and
      .daemon.process == "running" and
      .daemon.responsiveness == "responsive" and
      .daemon.ready == true
    ' "$readiness_current" >/dev/null; then
      cp "$readiness_current" "$readiness_final"
      daemon_ready=yes
      break
    fi
  else
    status_exit=$?
    jq -cn --argjson observation "$observation" --argjson statusCommandExit "$status_exit" \
      '{ observation: $observation, statusCommandExit: $statusCommandExit }' \
      >>"$readiness_observations"
  fi
  sleep 1
done
if [[ $daemon_ready != yes ]]; then
  # These reads are failure-safe and occur while the isolated user manager, launcher, release, and
  # journal still exist. Cleanup must not erase the only explanation for a failed managed child.
  set +e
  cp "$XDG_CONFIG_HOME/systemd/user/kojo.service" \
    "$evidence_directory/systemd-unit-document.service"
  systemctl --user cat kojo.service --no-pager \
    >"$evidence_directory/systemd-unit-cat.log" 2>&1
  systemctl --user status kojo.service --full --no-pager \
    >"$evidence_directory/systemd-unit-status.log" 2>&1
  systemctl --user show kojo.service --no-pager \
    >"$evidence_directory/systemd-unit-show.log" 2>&1
  journalctl --user-unit kojo.service --no-pager --lines=500 --output=short-precise \
    >"$evidence_directory/systemd-unit-journal.log" 2>&1
  cp "$XDG_DATA_HOME/kojo/active-release" "$evidence_directory/active-release"
  cp "$XDG_DATA_HOME/kojo/releases/$release_id/release.json" \
    "$evidence_directory/managed-release-manifest.json"
  cp "$XDG_DATA_HOME/kojo/releases/$release_id/managed-release.json" \
    "$evidence_directory/managed-release-declaration.json"
  cp "$XDG_STATE_HOME/kojo/launcher-supervision/state.json" \
    "$evidence_directory/managed-supervision-state.json"
  find "$XDG_STATE_HOME/kojo/launcher-supervision" -maxdepth 2 \
    -printf '%m %u:%g %y %p\n' >"$evidence_directory/managed-supervision-paths.log" 2>&1
  stat -c 'Mode=%a Owner=%U:%G Type=%F Path=%n' \
    "$XDG_DATA_HOME/kojo" \
    "$XDG_DATA_HOME/kojo/bin/kojo-launcher" \
    "$XDG_DATA_HOME/kojo/active-release" \
    "$XDG_DATA_HOME/kojo/releases/$release_id" \
    "$XDG_DATA_HOME/kojo/releases/$release_id/release.json" \
    "$XDG_DATA_HOME/kojo/releases/$release_id/launcher.js" \
    "$XDG_DATA_HOME/kojo/releases/$release_id/runtime/bun" \
    "$XDG_STATE_HOME/kojo" \
    "$XDG_STATE_HOME/kojo/launcher-supervision" \
    "$XDG_RUNTIME_DIR/kojo" \
    "$XDG_CONFIG_HOME/kojo" \
    >"$evidence_directory/managed-path-modes.log" 2>&1
  find "$XDG_DATA_HOME/kojo/releases/$release_id" -maxdepth 3 \
    -printf '%m %u:%g %y %s %p\n' >"$evidence_directory/managed-release-paths.log" 2>&1
  set -e
  {
    echo "ManagedReadyObservation=timed-out"
    echo "ObservationLimit=120"
    echo "NoRepairOrRestart=yes"
    echo "LastManagedStatus:"
    cat "$readiness_current"
    echo "NativeServiceStatus:"
    systemctl --user show kojo.service \
      --property=Type,KillMode,ControlGroup,MainPID,ActiveState,SubState || true
  } >"$evidence_directory/managed-readiness-failure.log"
  exit 1
fi
jq -e '
  .daemon.installed == true and
  .daemon.manager == "loaded" and
  .daemon.process == "running" and
  .daemon.responsiveness == "responsive" and
  .daemon.ready == true
' "$readiness_final" >/dev/null
test -S "$socket"
test -f "$endpoint"

(cd "$project" && "$candidate_kojo" project register .) \
  >"$evidence_directory/project-register.log"
project_id=$(awk '/registered Project / { print $3 }' "$evidence_directory/project-register.log")
if [[ -z $project_id ]]; then
  echo "Project registration did not print one Project identity." >&2
  exit 1
fi
printf '%s\n' "$project_id" >"$evidence_directory/project-id"

# Project registration starts a Factory Refresh. The helper observes one exact Project and Workflow
# row until Project, Factory, Factory Refresh, and Workflow availability are all current. It writes
# each raw and decoded attempt. Its internal deadline leaves time for final evidence. One shared
# bounds record reserves 115 seconds for observer TERM-to-KILL and 5 seconds for failure
# classification. Both sequential stages therefore fit the strict 120-second total bound.
factory_refresh_observations=$evidence_directory/bounded-factory-refresh-observations
factory_refresh_final=$evidence_directory/bounded-factory-refresh-observation-final.json
factory_refresh_summary=$evidence_directory/bounded-factory-refresh-observation.log
factory_refresh_bounds=$evidence_directory/bounded-factory-refresh-bounds.json
mkdir -p "$factory_refresh_observations"
"$candidate_bun" "$workflow_observation_helper" bounds >"$factory_refresh_bounds"
jq -e '
  .internalTimeoutMillis < (.observerTerminateAfterSeconds * 1000) and
  (((.observerTerminateAfterSeconds + .observerKillAfterSeconds +
     .classifierTerminateAfterSeconds + .classifierKillAfterSeconds) * 1000) ==
   .totalBoundMillis) and
  .totalBoundMillis <= 120000
' "$factory_refresh_bounds" >/dev/null
factory_refresh_internal_millis=$(jq -er '.internalTimeoutMillis' "$factory_refresh_bounds")
factory_refresh_observer_seconds=$(jq -er '.observerTerminateAfterSeconds' "$factory_refresh_bounds")
factory_refresh_observer_kill_seconds=$(jq -er '.observerKillAfterSeconds' "$factory_refresh_bounds")
factory_refresh_classifier_seconds=$(jq -er '.classifierTerminateAfterSeconds' "$factory_refresh_bounds")
factory_refresh_classifier_kill_seconds=$(jq -er '.classifierKillAfterSeconds' "$factory_refresh_bounds")
jq -n \
  --arg bun "$candidate_bun" \
  --arg helper "$workflow_observation_helper" \
  --arg kojo "$candidate_kojo" \
  --arg evidenceDirectory "$evidence_directory" \
  --arg projectId "$project_id" \
  --arg observerSeconds "${factory_refresh_observer_seconds}s" \
  --arg observerKillSeconds "${factory_refresh_observer_kill_seconds}s" \
  --slurpfile bounds "$factory_refresh_bounds" \
  '{
    kind: "bounded-read-only-factory-refresh",
    command: ["timeout", "--signal=TERM", "--kill-after=" + $observerKillSeconds, $observerSeconds, $bun, $helper, "observe", $kojo, $evidenceDirectory, $projectId, "review", ($bounds[0].internalTimeoutMillis | tostring)],
    bounds: $bounds[0],
    noRepairReregisterRestartOrStart: true
  }' >"$evidence_directory/bounded-factory-refresh-observer-command.json"
set +e
timeout --signal=TERM --kill-after="${factory_refresh_observer_kill_seconds}s" \
  "${factory_refresh_observer_seconds}s" \
  "$candidate_bun" "$workflow_observation_helper" observe \
  "$candidate_kojo" "$evidence_directory" "$project_id" review \
  "$factory_refresh_internal_millis" \
  >"$evidence_directory/bounded-factory-refresh-observer.stdout.log" \
  2>"$evidence_directory/bounded-factory-refresh-observer.stderr.log"
factory_refresh_status=$?
set -e
factory_refresh_failure=observer-failed
if [[ $factory_refresh_status -eq 124 || $factory_refresh_status -eq 137 ]]; then
  factory_refresh_failure=observer-hard-timeout
fi
if [[ $factory_refresh_status -ne 0 ]]; then
  timeout --signal=TERM --kill-after="${factory_refresh_classifier_kill_seconds}s" \
    "${factory_refresh_classifier_seconds}s" \
    "$candidate_bun" "$workflow_observation_helper" classify-failure \
    "$evidence_directory" "$factory_refresh_failure" "$factory_refresh_status"
  echo "The controlled Workflow did not become available after a current Factory Refresh." >&2
  exit 1
fi
factory_refresh_validation=0
if [[ ! -f $factory_refresh_final || ! -f $factory_refresh_summary ]]; then
  factory_refresh_failure=observer-incomplete-evidence
  factory_refresh_validation=1
elif ! jq -e '
  .kind == "bounded-read-only-factory-refresh" and
  .readiness == "current" and
  .noRepairReregisterRestartOrStart == true and
  .finalAttempt.readiness.ready == true
' "$factory_refresh_final" >/dev/null; then
  factory_refresh_failure=observer-invalid-success
  factory_refresh_validation=1
fi
if [[ $factory_refresh_validation -ne 0 ]]; then
  timeout --signal=TERM --kill-after="${factory_refresh_classifier_kill_seconds}s" \
    "${factory_refresh_classifier_seconds}s" \
    "$candidate_bun" "$workflow_observation_helper" classify-failure \
    "$evidence_directory" "$factory_refresh_failure" "$factory_refresh_validation"
  echo "The Factory Refresh observer did not write valid complete success evidence." >&2
  exit 1
fi

"$candidate_kojo" workflow start "$project_id" review \
  --payload '{"request":"native-release-evidence"}' --json \
  >"$evidence_directory/workflow-start.json"
run_id=$(jq -er '.runId' "$evidence_directory/workflow-start.json")
printf '%s\n' "$run_id" >"$evidence_directory/run-id"

for _ in $(seq 1 120); do
  "$candidate_kojo" gate list --project "$project_id" --json \
    >"$evidence_directory/gate-unanswered.json"
  if jq -e --arg run "$run_id" \
    '.askings[] | select(.identity.runId == $run and .state == "unanswered")' \
    "$evidence_directory/gate-unanswered.json" >/dev/null; then
    break
  fi
  sleep 1
done
token=$(jq -er --arg run "$run_id" \
  '.askings[] | select(.identity.runId == $run and .state == "unanswered") | .token' \
  "$evidence_directory/gate-unanswered.json")
"$candidate_kojo" run status "$run_id" --details --json \
  >"$evidence_directory/run-waiting.json"
"$candidate_kojo" gate answer "$token" --choice approve --as shipped-linux-evidence \
  --wait --timeout 120s --json >"$evidence_directory/gate-applied.json"
"$candidate_kojo" run status "$run_id" --details --json \
  >"$evidence_directory/run-succeeded.json"
jq -e '.run.state == "succeeded"' "$evidence_directory/run-succeeded.json" >/dev/null
"$candidate_bun" "$run_evidence_helper" "$evidence_directory/run-succeeded.json" \
  >"$evidence_directory/run-succeeded-validation.json"
jq -e '.valid == true' "$evidence_directory/run-succeeded-validation.json" >/dev/null
jq -e '.asking.state == "applied"' "$evidence_directory/gate-applied.json" >/dev/null

gate_name=$(jq -er '.run.gates[0].gate' "$evidence_directory/run-succeeded.json")
gate_asking=$(jq -er '.run.gates[0].asking' "$evidence_directory/run-succeeded.json")
sandbox_id=$(jq -er '.run.sandboxes | map(select(.outcome == "released")) | last | .sandboxId' \
  "$evidence_directory/run-succeeded.json")
sandbox_name=$(cut -d/ -f2 <<<"$sandbox_id")
sandbox_acquisition=${sandbox_id##*/}

launch_url=$("$managed_kojo" ui --no-open)
printf '%s\n' "Authenticated launch grant issued; the secret was not retained." \
  >"$evidence_directory/console-launch.log"
(cd "$workspace/apps/console" && \
  KOJO_SHIPPED_LAUNCH_URL="$launch_url" \
  KOJO_SHIPPED_PROJECT_ID="$project_id" \
  KOJO_SHIPPED_RUN_ID="$run_id" \
  KOJO_SHIPPED_GATE_NAME="$gate_name" \
  KOJO_SHIPPED_GATE_ASKING="$gate_asking" \
  KOJO_SHIPPED_SANDBOX_NAME="$sandbox_name" \
  KOJO_SHIPPED_SANDBOX_ACQUISITION="$sandbox_acquisition" \
  PLAYWRIGHT_BROWSERS_PATH=/opt/kojo-playwright \
  "$candidate_bun" ./node_modules/@playwright/test/cli.js test \
    --config playwright.release.config.ts) \
  >"$evidence_directory/browser-tests.log" 2>&1
grep -E "1 passed" "$evidence_directory/browser-tests.log" >/dev/null

replacement_url=$("$managed_kojo" ui --no-open)
old_origin=${replacement_url%%/daemon*}
grant=${replacement_url##*#grant=}
session_json=$(curl --fail --silent --show-error \
  -X POST \
  -H 'content-type: application/json' \
  -H "origin: $old_origin" \
  --data "{\"grant\":\"$grant\"}" \
  "$old_origin/_kojo/session")
old_credential=$(jq -er '.credential' <<<"$session_json")
old_instance=$(jq -er '.instanceId' "$endpoint")
old_pid=$(systemctl --user show kojo.service --property=MainPID --value)
systemctl --user show kojo.service --property=Type,KillMode,ControlGroup,MainPID,ActiveState,SubState \
  >"$evidence_directory/systemd-before-replacement.log"
[[ $(systemctl --user show kojo.service --property=Type --value) == exec ]]
[[ $(systemctl --user show kojo.service --property=KillMode --value) == control-group ]]
[[ $(systemctl --user show kojo.service --property=ActiveState --value) == active ]]
[[ $(systemctl --user show kojo.service --property=SubState --value) == running ]]
control_group=$(systemctl --user show kojo.service --property=ControlGroup --value)
[[ $control_group == /user.slice/*/kojo.service ]]
grep -Fx "$old_pid" "/sys/fs/cgroup$control_group/cgroup.procs" >/dev/null
{
  echo "Type=exec"
  echo "KillMode=control-group"
  echo "ControlGroup=$control_group"
  echo "MainPidInCgroup=yes"
} >"$evidence_directory/cgroup-before-replacement.log"

find "$candidate_tools" -maxdepth 3 -mindepth 0 -print \
  >"$evidence_directory/global-removal-plan.log"
rm -rf "$candidate_tools"
test ! -e "$candidate_tools"
PATH=/usr/bin:/bin command -v kojo >/dev/null 2>&1 && {
  echo "A global Kojo command remained on the isolated user's reduced PATH." >&2
  exit 1
}
{
  echo "GlobalKojo=removed"
  echo "GlobalBun=removed"
  echo "ManagedKojo=$managed_kojo"
} >"$evidence_directory/global-removal.log"

PATH=/usr/bin:/bin "$managed_kojo" daemon status --details \
  >"$evidence_directory/managed-status-after-global-removal.log"
PATH=/usr/bin:/bin "$managed_kojo" project repair "$project_id" \
  >"$evidence_directory/managed-repair-after-global-removal.log"
grep -F "needs no recovery" "$evidence_directory/managed-repair-after-global-removal.log" >/dev/null

stat -c '%n Owner=%u Mode=%a Type=%F' \
  "$XDG_RUNTIME_DIR/kojo" "$XDG_STATE_HOME/kojo" "$XDG_DATA_HOME/kojo" \
  "$XDG_CONFIG_HOME/kojo" "$endpoint" "$socket" \
  >"$evidence_directory/private-paths.log"
[[ $(stat -c %a "$XDG_RUNTIME_DIR/kojo") == 700 ]]
[[ $(stat -c %a "$XDG_STATE_HOME/kojo") == 700 ]]
[[ $(stat -c %a "$XDG_DATA_HOME/kojo") == 700 ]]
[[ $(stat -c %a "$XDG_CONFIG_HOME/kojo") == 700 ]]
[[ $(stat -c %a "$endpoint") == 600 ]]
[[ $(stat -c %a "$socket") == 600 ]]

if ! bash "$singleton_evidence_script" \
  "$managed_launcher" \
  "$endpoint" \
  "$evidence_directory/singleton-refusal.log" \
  "$evidence_directory/singleton-duplicate.json" \
  5s; then
  echo "A duplicate shipped Daemon did not prove singleton refusal." >&2
  exit 1
fi
jq -e '.accepted == true and .activeInstanceUnchanged == true' \
  "$evidence_directory/singleton-duplicate.json" >/dev/null

PATH=/usr/bin:/bin "$managed_kojo" daemon restart --timeout 60s \
  >"$evidence_directory/managed-replacement.log"
for _ in $(seq 1 120); do
  new_pid=$(systemctl --user show kojo.service --property=MainPID --value)
  new_instance=$(jq -er '.instanceId' "$endpoint" 2>/dev/null || true)
  if [[ $new_pid =~ ^[1-9][0-9]*$ && $new_pid != "$old_pid" && -n $new_instance && $new_instance != "$old_instance" ]]; then
    break
  fi
  sleep 1
done
[[ $new_pid != "$old_pid" ]]
[[ $new_instance != "$old_instance" ]]
if kill -0 "$old_pid" 2>/dev/null; then
  echo "The replaced shipped Daemon process is still present." >&2
  exit 1
fi
new_origin=$(jq -er '.consoleOrigin' "$endpoint")
old_session_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  -H "authorization: Bearer $old_credential" "$new_origin/api/v1/daemon")
[[ $old_session_status == 401 ]]
systemctl --user show kojo.service --property=Type,KillMode,ControlGroup,MainPID,ActiveState,SubState \
  >"$evidence_directory/systemd-after-replacement.log"
[[ $(systemctl --user show kojo.service --property=Type --value) == exec ]]
[[ $(systemctl --user show kojo.service --property=KillMode --value) == control-group ]]
new_control_group=$(systemctl --user show kojo.service --property=ControlGroup --value)
[[ $new_control_group == "$control_group" ]]
grep -Fx "$new_pid" "/sys/fs/cgroup$new_control_group/cgroup.procs" >/dev/null
{
  echo "OldInstanceReplaced=yes"
  echo "OldProcessStopped=yes"
  echo "OldBrowserSessionAtReplacement=401"
  echo "ReplacementMainPidInCgroup=yes"
} >"$evidence_directory/replacement-access.log"

PATH=/usr/bin:/bin "$managed_kojo" run status "$run_id" --details --json \
  >"$evidence_directory/run-after-replacement.json"
jq -e '.run.state == "succeeded" and (.run.artifacts | length >= 1)' \
  "$evidence_directory/run-after-replacement.json" >/dev/null

bash "$login_state_evidence_script" \
  "$evidence_directory/pre-logout-login-state.json" \
  "$evidence_directory/pre-logout-login-state.stderr.log" \
  "$(id -un)" \
  "$(id -u)" \
  no \
  present \
  1 \
  0s
