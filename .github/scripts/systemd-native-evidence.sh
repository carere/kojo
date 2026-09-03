#!/usr/bin/env bash
set -euo pipefail

workspace=${1:?usage: systemd-native-evidence.sh WORKSPACE EVIDENCE_DIRECTORY REVISION}
evidence_directory=${2:?usage: systemd-native-evidence.sh WORKSPACE EVIDENCE_DIRECTORY REVISION}
revision=${3:?usage: systemd-native-evidence.sh WORKSPACE EVIDENCE_DIRECTORY REVISION}
workspace_owner=$(stat -c %u:%g "$workspace")
evidence_user=kojo-native-evidence
fixture=packages/kojo/tests/support/daemon/systemdLogoutFixture.ts
unit=kojo-native-logout-evidence.service
key=/tmp/kojo-native-evidence-key
policy=/etc/polkit-1/rules.d/49-kojo-native-evidence.rules
login_readiness_script=$workspace/.github/scripts/systemd-shipped-login-readiness.sh
login_state_evidence_script=$workspace/.github/scripts/systemd-shipped-login-state-evidence.sh
logout_readiness_script=$workspace/.github/scripts/systemd-shipped-logout-readiness.sh

assert_login_state_receipt() {
  local receipt=$1
  local expected_linger=$2
  local expected_sessions=$3
  jq -e \
    --arg linger "$expected_linger" \
    --arg sessions "$expected_sessions" \
    '.accepted == true and
      .expected.classification == "login-state-matched-within-bound" and
      .expected.statusCommandExit == 0 and
      .expected.linger == $linger and
      .expected.sessions == $sessions and
      .expected.state == "present" and
      .actual.classification == "login-state-matched-within-bound" and
      .actual.statusCommandExit == 0 and
      .actual.linger == $linger and
      (($sessions == "present" and (.actual.sessions | length) > 0) or
        ($sessions == "absent" and .actual.sessions == "")) and
      (.actual.state | length) > 0 and
      .readOnly == true' \
    "$receipt" >/dev/null
}

if [[ $(id -u) -ne 0 ]]; then
  echo "This controller must run in a separate root control session." >&2
  exit 1
fi

cleanup() {
  loginctl disable-linger "$evidence_user" >/dev/null 2>&1 || true
  loginctl terminate-user "$evidence_user" >/dev/null 2>&1 || true
  userdel --remove "$evidence_user" >/dev/null 2>&1 || true
  rm -f "$key" "$key.pub" "$policy"
  chown -R "$workspace_owner" "$workspace" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if id "$evidence_user" >/dev/null 2>&1; then
  echo "The isolated evidence user already exists." >&2
  exit 1
fi

mkdir -p "$evidence_directory"
chmod 0777 "$evidence_directory"
useradd --create-home --shell /bin/bash "$evidence_user"
evidence_uid=$(id -u "$evidence_user")
evidence_home=$(getent passwd "$evidence_user" | cut -d: -f6)
runtime_directory=/run/user/$evidence_uid
endpoint=$runtime_directory/kojo-native-logout-evidence/endpoint.json
bus=$runtime_directory/bus
chown -R "$evidence_user:$evidence_user" "$workspace"
chmod o+x /home/runner /home/runner/work "$(dirname "$workspace")"

install -d -m 0700 -o "$evidence_user" -g "$evidence_user" "$evidence_home/.ssh"
ssh-keygen -q -t ed25519 -N "" -f "$key"
install -m 0600 -o "$evidence_user" -g "$evidence_user" "$key.pub" \
  "$evidence_home/.ssh/authorized_keys"

install -d -m 0755 /etc/polkit-1/rules.d
cat >"$policy" <<EOF
polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.login1.set-user-linger" &&
      subject.user == "$evidence_user") {
    return polkit.Result.YES;
  }
});
EOF

systemctl start ssh
/usr/sbin/sshd -T | grep -Fx "usepam yes" >/dev/null
loginctl disable-linger "$evidence_user"

ssh_arguments=(
  -i "$key"
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  "$evidence_user@127.0.0.1"
)
remote_prefix="cd '$workspace' && export PATH=/usr/local/bin:/usr/bin:/bin CI=1 NO_COLOR=1 HOME='$evidence_home' XDG_RUNTIME_DIR='$runtime_directory' XDG_CONFIG_HOME='$evidence_home/.config' XDG_DATA_HOME='$evidence_home/.local/share' XDG_STATE_HOME='$evidence_home/.local/state' XDG_CACHE_HOME='$evidence_home/.cache' DBUS_SESSION_BUS_ADDRESS='unix:path=$runtime_directory/bus'"

ssh "${ssh_arguments[@]}" \
  "$remote_prefix && id && stat -c 'RuntimeDirectory=%n Owner=%u Mode=%a' '$runtime_directory' && test -S '$bus' && /usr/bin/systemctl --user import-environment HOME XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME && /usr/bin/systemctl --user show-environment" \
  >"$evidence_directory/pam-session.log"

ssh "${ssh_arguments[@]}" \
  "$remote_prefix && moon run kojo:test-host" \
  2>&1 | tee "$evidence_directory/host-tests.log"

grep -E "^ ↓ .*the native macOS Daemon lifecycle" "$evidence_directory/host-tests.log" >/dev/null
grep -E "^ ✓ .*the native systemd user Daemon lifecycle" "$evidence_directory/host-tests.log" >/dev/null
grep -E "Tests[[:space:]]+1 passed[[:space:]]+\|[[:space:]]+1 skipped \(2\)" \
  "$evidence_directory/host-tests.log" >/dev/null

ssh "${ssh_arguments[@]}" \
  "$remote_prefix && bun '$fixture' install >'$evidence_directory/no-linger-install.json' && bash '$login_state_evidence_script' '$evidence_directory/no-linger-live-login-state.json' '$evidence_directory/no-linger-live-login-state.stderr.log' '$evidence_user' '$evidence_uid' no present 1 0s"
no_linger_child=$(jq -er .childProcessId "$evidence_directory/no-linger-install.json")
assert_login_state_receipt "$evidence_directory/no-linger-live-login-state.json" no present
bash "$logout_readiness_script" \
  "$evidence_directory/no-linger-logout-readiness-observations.jsonl" \
  "$evidence_directory/no-linger-logout-readiness-final.json" \
  "$evidence_directory/no-linger-logout-readiness.stderr.log" \
  "$evidence_user" \
  "$evidence_uid" \
  "$endpoint" \
  "$bus" \
  90 \
  1s \
  terminal-stopped
jq -e '
  .accepted == true and
  .expected.classification == "terminal-stopped-within-bound" and
  .expected.managerTerminalClassification == "terminal-stopped" and
  ((.actual.managerTerminalClassification == "terminal-stopped-clean" and
    .actual.classification == "logout-complete-within-bound" and
    .actual.managerActiveState == "inactive" and
    .actual.managerSubState == "dead" and
    .actual.managerResultClassification == "not-required") or
   (.actual.managerTerminalClassification == "terminal-stopped-with-failure" and
    .actual.classification == "logout-complete-with-manager-failure-within-bound" and
    .actual.managerActiveState == "failed" and
    .actual.managerSubState == "failed" and
    .actual.managerResultClassification == "unsuccessful-manager-exit-recorded" and
    .actual.managerResult != "success")) and
  (.actual.managerResult | length) > 0 and
  (.actual.managerExecMainCode | length) > 0 and
  (.actual.managerExecMainStatus | length) > 0 and
  .actual.managerJobPresent == false and
  .actual.managerCgroupPopulated == false and
  .actual.loginUserPresent == false and
  .actual.endpointPresent == false and
  .actual.busPresent == false and
  .noServiceStartRepairOrLingerChange == true
' "$evidence_directory/no-linger-logout-readiness-final.json" >/dev/null
! kill -0 "$no_linger_child" 2>/dev/null
{
  echo "Linger=no"
  echo "Daemon=stopped"
  echo "Endpoint=removed"
  echo "ChildProcessGroup=stopped"
  echo "LiveLoginStateEvidence=no-linger-live-login-state.json"
  echo "FinalLogoutEvidence=no-linger-logout-readiness-final.json"
  jq -r '
    "UserManager=\(.actual.managerTerminalClassification)",
    "UserManagerState=\(.actual.managerActiveState)/\(.actual.managerSubState)",
    "UserManagerResult=\(.actual.managerResult)",
    "UserManagerExecMain=\(.actual.managerExecMainCode)/\(.actual.managerExecMainStatus)",
    "UserManagerJob=\(.actual.managerJob)",
    "UserManagerControlGroup=\(.actual.managerControlGroup)"
  ' "$evidence_directory/no-linger-logout-readiness-final.json"
} >"$evidence_directory/final-logout-without-linger.log"

ssh "${ssh_arguments[@]}" \
  "$remote_prefix && bash '$login_readiness_script' '$evidence_directory/post-terminal-manager-login-readiness-observations.jsonl' '$evidence_directory/post-terminal-manager-login-readiness-final.json' '$evidence_directory/post-terminal-manager-login-readiness.stderr.log' 20 0.25s && bun '$fixture' install >'$evidence_directory/linger-install.json' && bun packages/kojo/src/main.ts daemon keep-running-after-logout >'$evidence_directory/keep-running-after-logout.log' && bash '$login_state_evidence_script' '$evidence_directory/linger-live-login-state.json' '$evidence_directory/linger-live-login-state.stderr.log' '$evidence_user' '$evidence_uid' yes present 1 0s && bun '$fixture' inspect >'$evidence_directory/linger-inspect.json'"
linger_child=$(jq -er .childProcessId "$evidence_directory/linger-inspect.json")
jq -e '
  .accepted == true and
  .actual.classification == "manager-ready-within-bound" and
  .actual.managerReady == true and
  .noServiceStartRepairOrLingerChange == true
' "$evidence_directory/post-terminal-manager-login-readiness-final.json" >/dev/null
assert_login_state_receipt "$evidence_directory/linger-live-login-state.json" yes present

grep -F "This changes linger for the complete OS user. All user services can then run after logout." \
  "$evidence_directory/keep-running-after-logout.log" >/dev/null
grep -F "Keep running after logout: enabled." \
  "$evidence_directory/keep-running-after-logout.log" >/dev/null
bash "$login_state_evidence_script" \
  "$evidence_directory/linger-final-login-state.json" \
  "$evidence_directory/linger-final-login-state.stderr.log" \
  "$evidence_user" \
  "$evidence_uid" \
  yes \
  absent \
  30 \
  1s
assert_login_state_receipt "$evidence_directory/linger-final-login-state.json" yes absent
systemctl is-active --quiet "user@$evidence_uid.service"
[[ -e "$endpoint" ]]
kill -0 "$linger_child"
runuser -u "$evidence_user" -- env \
  XDG_RUNTIME_DIR="$runtime_directory" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_directory/bus" \
  /usr/bin/systemctl --user is-active --quiet "$unit"
{
  echo "Linger=yes"
  echo "UserManager=running"
  echo "Daemon=running"
  echo "Endpoint=present"
  echo "ChildProcessGroup=running"
  echo "ManagerRecoveryEvidence=post-terminal-manager-login-readiness-final.json"
  echo "LiveLoginStateEvidence=linger-live-login-state.json"
  echo "FinalLoginStateEvidence=linger-final-login-state.json"
} >"$evidence_directory/final-logout-with-linger.log"

ssh "${ssh_arguments[@]}" \
  "$remote_prefix && bun '$fixture' remove" \
  >"$evidence_directory/removal.json"
bash "$login_state_evidence_script" \
  "$evidence_directory/removal-login-state.json" \
  "$evidence_directory/removal-login-state.stderr.log" \
  "$evidence_user" \
  "$evidence_uid" \
  yes \
  absent \
  30 \
  1s
assert_login_state_receipt "$evidence_directory/removal-login-state.json" yes absent
if runuser -u "$evidence_user" -- env \
  XDG_RUNTIME_DIR="$runtime_directory" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_directory/bus" \
  /usr/bin/systemctl --user is-active --quiet "$unit"; then
  echo "The removed fixture service is still active." >&2
  exit 1
fi
removed_load_state=$(runuser -u "$evidence_user" -- env \
  XDG_RUNTIME_DIR="$runtime_directory" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_directory/bus" \
  /usr/bin/systemctl --user show "$unit" --property=LoadState --value)
[[ $removed_load_state == not-found ]]
[[ ! -e "$endpoint" ]]
! kill -0 "$linger_child" 2>/dev/null
{
  echo "LingerAfterRemoval=yes"
  echo "LoginStateEvidence=removal-login-state.json"
} >"$evidence_directory/removal-preserves-linger.log"

{
  . /etc/os-release
  echo "OS=$PRETTY_NAME"
  echo "Architecture=$(uname -m)"
  echo "Kernel=$(uname -r)"
  systemd --version | head -1
  echo "Bun=$(bun --version)"
  echo "Moon=$(moon --version)"
  echo "EvidenceUser=$evidence_user"
  echo "EvidenceUid=$evidence_uid"
  echo "SessionTransport=OpenSSH with PAM"
  echo "TestedRevision=$revision"
  echo "HostTests=1 passed, 1 skipped, 2 loaded"
  echo "NamedSkip=the native macOS Daemon lifecycle"
} >"$evidence_directory/host-facts.log"
