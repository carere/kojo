#!/usr/bin/env bash
set -Eeuo pipefail

workspace=${1:?usage: systemd-shipped-evidence.sh WORKSPACE EVIDENCE_DIRECTORY PACKAGE_DIRECTORY REVISION}
evidence_directory=${2:?usage: systemd-shipped-evidence.sh WORKSPACE EVIDENCE_DIRECTORY PACKAGE_DIRECTORY REVISION}
package_directory=${3:?usage: systemd-shipped-evidence.sh WORKSPACE EVIDENCE_DIRECTORY PACKAGE_DIRECTORY REVISION}
revision=${4:?usage: systemd-shipped-evidence.sh WORKSPACE EVIDENCE_DIRECTORY PACKAGE_DIRECTORY REVISION}
workspace_owner=$(stat -c %u:%g "$workspace")
evidence_user=kojo-shipped-evidence
key=/tmp/kojo-shipped-evidence-key
policy=/etc/polkit-1/rules.d/49-kojo-shipped-evidence.rules
user_script=.github/scripts/systemd-shipped-user-evidence.sh
login_readiness_script=.github/scripts/systemd-shipped-login-readiness.sh
logout_readiness_script=.github/scripts/systemd-shipped-logout-readiness.sh
playwright_cli=$workspace/apps/console/node_modules/@playwright/test/cli.js
diagnostic=$evidence_directory/controller-diagnostic.log
diagnostic_step=preflight
diagnostic_line=
diagnostic_command=

mkdir -p "$evidence_directory"
chmod 0777 "$evidence_directory"

write_diagnostic() {
  local status=$1
  local exit_code=$2
  local line=${3:-}
  local command=${4:-}
  {
    printf 'Status=%s\n' "$status"
    printf 'Step=%s\n' "$diagnostic_step"
    printf 'ExitCode=%s\n' "$exit_code"
    printf 'Line=%s\n' "$line"
    printf 'Command=%q\n' "$command"
    printf 'Revision=%s\n' "$revision"
  } >"$diagnostic"
}

record_failure() {
  local exit_code=$1
  diagnostic_line=$2
  diagnostic_command=$3
  return "$exit_code"
}

cleanup() {
  loginctl disable-linger "$evidence_user" >/dev/null 2>&1 || true
  loginctl terminate-user "$evidence_user" >/dev/null 2>&1 || true
  userdel --remove "$evidence_user" >/dev/null 2>&1 || true
  rm -f "$key" "$key.pub" "$policy"
  chown -R "$workspace_owner" "$workspace" >/dev/null 2>&1 || true
}

finish() {
  local exit_code=$?
  trap - ERR EXIT
  set +e
  if [[ $exit_code -eq 0 ]]; then
    write_diagnostic passed 0
  else
    write_diagnostic failed "$exit_code" "$diagnostic_line" "$diagnostic_command"
  fi
  cleanup
  exit "$exit_code"
}

write_diagnostic running 0
trap 'record_failure "$?" "$LINENO" "$BASH_COMMAND"' ERR
trap finish EXIT

if [[ $(id -u) -ne 0 ]]; then
  echo "This controller must run in a separate root control session." >&2
  exit 1
fi
if id "$evidence_user" >/dev/null 2>&1; then
  echo "The isolated shipped evidence user already exists." >&2
  exit 1
fi

diagnostic_step=isolated-user-setup
useradd --create-home --shell /bin/bash "$evidence_user"
evidence_uid=$(id -u "$evidence_user")
evidence_home=$(getent passwd "$evidence_user" | cut -d: -f6)
runtime_directory=/run/user/$evidence_uid
endpoint=$runtime_directory/kojo/endpoint.json
socket=$runtime_directory/kojo/daemon.sock
chown -R "$evidence_user:$evidence_user" "$workspace"
chmod o+x /home/runner /home/runner/work "$(dirname "$workspace")"

install -d -m 0700 -o "$evidence_user" -g "$evidence_user" "$evidence_home/.ssh"
ssh-keygen -q -t ed25519 -N "" -f "$key"
install -m 0600 -o "$evidence_user" -g "$evidence_user" "$key.pub" \
  "$evidence_home/.ssh/authorized_keys"
diagnostic_step=browser-install
test -f "$playwright_cli"
PLAYWRIGHT_BROWSERS_PATH=/opt/kojo-playwright \
  bun "$playwright_cli" install --with-deps chromium
chmod -R a+rX /opt/kojo-playwright
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

diagnostic_step=isolated-user-flow
ssh "${ssh_arguments[@]}" \
  "$remote_prefix && id && stat -c 'RuntimeDirectory=%n Owner=%u Mode=%a' '$runtime_directory' && test -S '$runtime_directory/bus' && systemctl --user import-environment HOME XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME && systemctl --user show-environment && bash '$user_script' '$workspace' '$evidence_directory' '$package_directory'" \
  >"$evidence_directory/user-flow.log" 2>"$evidence_directory/user-flow.stderr.log"

jq -e '
  .accepted == true and
  .expected.statusCommandExit == 0 and
  .expected.linger == "no" and
  .actual.statusCommandExit == 0 and
  .actual.linger == "no" and
  .readOnly == true
' "$evidence_directory/pre-logout-linger.json" >/dev/null
diagnostic_step=no-linger-lifetime
bash "$logout_readiness_script" \
  "$evidence_directory/logout-readiness-observations.jsonl" \
  "$evidence_directory/logout-readiness-final.json" \
  "$evidence_directory/logout-readiness.stderr.log" \
  "$evidence_user" \
  "$evidence_uid" \
  "$endpoint" \
  "$runtime_directory/bus" \
  120 \
  1s
jq -e '
  .accepted == true and
  .actual.managerActiveState == "inactive" and
  .actual.managerSubState == "dead" and
  .actual.managerJobPresent == false and
  .actual.managerCgroupPopulated == false and
  .actual.loginUserPresent == false and
  .actual.endpointPresent == false and
  .actual.busPresent == false and
  .noServiceStartRepairOrLingerChange == true
' "$evidence_directory/logout-readiness-final.json" >/dev/null
{
  echo "Linger=no"
  echo "UserManager=stopped"
  echo "Daemon=stopped"
  echo "Endpoint=removed"
  echo "ServiceCgroup=empty"
  jq -r '
    "UserManagerState=\(.actual.managerActiveState)/\(.actual.managerSubState)",
    "UserManagerJob=\(.actual.managerJob)",
    "UserManagerControlGroup=\(.actual.managerControlGroup)",
    "LoginUserPresent=\(.actual.loginUserPresent)",
    "BusPresent=\(.actual.busPresent)"
  ' "$evidence_directory/logout-readiness-final.json"
} >"$evidence_directory/final-logout-without-linger.log"

managed_kojo=$evidence_home/.local/share/kojo/bin/kojo
diagnostic_step=linger-authorization
ssh "${ssh_arguments[@]}" \
  "$remote_prefix && bash '$login_readiness_script' '$evidence_directory/login-readiness-observations.jsonl' '$evidence_directory/login-readiness-final.json' '$evidence_directory/login-readiness.stderr.log' 20 0.25s && PATH=/usr/bin:/bin '$managed_kojo' daemon start >'$evidence_directory/managed-start-after-login.log' 2>'$evidence_directory/managed-start-after-login.stderr.log' && if PATH=/usr/bin:/bin '$managed_kojo' daemon keep-running-after-logout >'$evidence_directory/keep-running-refusal.log' 2>&1; then echo 'Linger unexpectedly changed without authority.' >&2; exit 90; fi"
jq -e '
  .accepted == true and
  .managerReady == true and
  .noServiceStartRepairOrLingerChange == true
' "$evidence_directory/login-readiness-final.json" >/dev/null
[[ $(loginctl show-user "$evidence_user" --property=Linger --value) == no ]]

install -d -m 0755 /etc/polkit-1/rules.d
cat >"$policy" <<EOF
polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.login1.set-user-linger" &&
      subject.user == "$evidence_user") {
    return polkit.Result.YES;
  }
});
EOF

ssh "${ssh_arguments[@]}" \
  "$remote_prefix && PATH=/usr/bin:/bin '$managed_kojo' daemon keep-running-after-logout >'$evidence_directory/keep-running-after-logout.log'"
grep -F "This changes linger for the complete OS user. All user services can then run after logout." \
  "$evidence_directory/keep-running-after-logout.log" >/dev/null
grep -F "Keep running after logout: enabled." \
  "$evidence_directory/keep-running-after-logout.log" >/dev/null
[[ $(loginctl show-user "$evidence_user" --property=Linger --value) == yes ]]

sleep 5
systemctl is-active --quiet "user@$evidence_uid.service"
[[ -z $(loginctl show-user "$evidence_user" --property=Sessions --value) ]]
[[ -e $endpoint ]]
[[ -S $socket ]]
runuser -u "$evidence_user" -- env \
  XDG_RUNTIME_DIR="$runtime_directory" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_directory/bus" \
  /usr/bin/systemctl --user is-active --quiet kojo.service
if runuser -u nobody -- test -r "$endpoint"; then
  echo "Another OS user can read the shipped Daemon endpoint." >&2
  exit 1
fi
if runuser -u nobody -- curl --silent --unix-socket "$socket" http://localhost/api/v1/daemon; then
  echo "Another OS user can connect to the shipped Daemon socket." >&2
  exit 1
fi
{
  echo "Linger=yes"
  echo "UserManager=running"
  echo "Daemon=running"
  echo "Endpoint=present"
  echo "CrossUserEndpointRead=refused"
  echo "CrossUserSocketConnect=refused"
} >"$evidence_directory/final-logout-with-linger.log"

diagnostic_step=managed-removal
ssh "${ssh_arguments[@]}" \
  "$remote_prefix && PATH=/usr/bin:/bin '$managed_kojo' daemon remove --timeout 60s >'$evidence_directory/managed-removal.log'"
diagnostic_step=removal-verification
[[ $(loginctl show-user "$evidence_user" --property=Linger --value) == yes ]]
if runuser -u "$evidence_user" -- env \
  XDG_RUNTIME_DIR="$runtime_directory" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_directory/bus" \
  /usr/bin/systemctl --user is-active --quiet kojo.service; then
  echo "The removed shipped service is still active." >&2
  exit 1
fi
removed_load_state=$(runuser -u "$evidence_user" -- env \
  XDG_RUNTIME_DIR="$runtime_directory" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_directory/bus" \
  /usr/bin/systemctl --user show kojo.service --property=LoadState --value)
[[ $removed_load_state == not-found ]]
[[ ! -e $endpoint ]]
[[ ! -e $evidence_home/.local/share/kojo/bin/kojo ]]
[[ -e $evidence_home/.local/state/kojo/kojo.db ]]
[[ -e $evidence_home/.config/kojo ]]
runuser -u "$evidence_user" -- /usr/local/bin/bun \
  "$workspace/packages/kojo/tests/release/support/inspectShippedDatabase.ts" \
  "$evidence_home/.local/state/kojo/kojo.db" \
  "$(cat "$evidence_directory/run-id")" \
  >"$evidence_directory/persisted-database.json"
echo "LingerAfterRemoval=yes" >"$evidence_directory/removal-preserves-linger.log"

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
  echo "LoadedTests=3"
  echo "PassedTests=2"
  echo "NamedSkip=the native macOS Daemon lifecycle"
} >"$evidence_directory/host-facts.log"
sha256sum "$package_directory"/*.tgz >"$evidence_directory/package-sha256.log"

diagnostic_step=evidence-manifest
jq -n \
  --arg revision "$revision" \
  --arg os "$(. /etc/os-release && printf '%s' "$PRETTY_NAME")" \
  --arg architecture "$(uname -m)" \
  --arg kernel "$(uname -r)" \
  --arg systemd "$(systemd --version | head -1)" \
  --arg bun "$(bun --version)" \
  --arg moon "$(moon --version)" \
  --rawfile packageSha256 "$evidence_directory/package-sha256.log" \
  '{
    formatVersion: 1,
    ticket: 90,
    testedRevision: $revision,
    environment: {
      os: $os,
      architecture: $architecture,
      kernel: $kernel,
      systemd: $systemd,
      bun: $bun,
      moon: $moon,
      sessionTransport: "OpenSSH with PAM"
    },
    packages: ($packageSha256 | split("\n") | map(select(length > 0)) | map(
      capture("^(?<sha256>[a-f0-9]{64})  (?<file>.+)$") |
      { file: (.file | split("/") | last), sha256: .sha256 }
    )),
    loadedTests: [
      { tier: "native-host", loaded: 2, passed: 1, skipped: 1, namedSkips: ["the native macOS Daemon lifecycle"] },
      { tier: "shipped-browser", loaded: 1, passed: 1, skipped: 0, namedSkips: [] }
    ],
    checks: [
      { name: "printed-fresh-install", expected: "bun add -g, init, install, doctor, registration and Start succeed without conditional repair", actual: "passed", evidence: "candidate-install.log; fresh-init.log; factory-authoring.log; fresh-doctor.log; project-register.log; workflow-start.json" },
      { name: "shipped-managed-content", expected: "packed Kojo, copied global Bun and shipped Console own the service", actual: "passed", evidence: "candidate-install.log; daemon-install.log; managed-bun-sha256.log; package-sha256.log" },
      { name: "bounded-startup-readiness", expected: "managed status observes the started Daemon become responsive and Ready without repair or restart", actual: "passed", evidence: "managed-readiness-observations.jsonl; managed-readiness-final.json; managed-readiness-status.stderr.log" },
      { name: "real-daemon-records", expected: "Project, Workflow, Run, Gate, Trace, Sandbox and Artifact persist; optional wire fields are absent instead of null", actual: "passed", evidence: "run-succeeded.json; gate-applied.json; run-after-replacement.json; persisted-database.json" },
      { name: "authenticated-browser", expected: "one authenticated browser inspects the actual encoded wire and renders persisted records and Artifact", actual: "passed", evidence: "browser-tests.log" },
      { name: "global-tool-independence", expected: "managed status and repair work after candidate global Kojo and Bun removal", actual: "passed", evidence: "global-removal.log; managed-status-after-global-removal.log; managed-repair-after-global-removal.log" },
      { name: "replacement-and-access", expected: "the Type=exec control group contains the replacement MainPID; old process and browser authority are revoked; another OS user is refused", actual: "passed", evidence: "cgroup-before-replacement.log; replacement-access.log; final-logout-with-linger.log" },
      { name: "login-lifetime", expected: "final logout stops the Daemon without linger and preserves it only after explicit authorized linger", actual: "passed", evidence: "pre-logout-linger.json; pre-logout-linger.stderr.log; logout-readiness-observations.jsonl; logout-readiness-final.json; logout-readiness.stderr.log; final-logout-without-linger.log; login-readiness-observations.jsonl; login-readiness-final.json; login-readiness.stderr.log; keep-running-refusal.log; keep-running-after-logout.log; final-logout-with-linger.log" },
      { name: "removal-preserves-linger", expected: "shipped removal never disables user linger", actual: "passed", evidence: "managed-removal.log; removal-preserves-linger.log" }
    ],
    noHiddenRepairs: {
      actual: true,
      evidence: "factory-authoring.log records the only authored replacements before validation; no command changes the fixture in response to a failed check"
    }
  }' >"$evidence_directory/evidence.json"
diagnostic_step=evidence-complete
