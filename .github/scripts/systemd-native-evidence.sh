#!/usr/bin/env bash
set -euo pipefail

workspace=${1:?usage: systemd-native-evidence.sh WORKSPACE EVIDENCE_DIRECTORY}
evidence_directory=${2:?usage: systemd-native-evidence.sh WORKSPACE EVIDENCE_DIRECTORY}
evidence_user=kojo-native-evidence
fixture=packages/kojo/tests/support/daemon/systemdLogoutFixture.ts
unit=kojo-native-logout-evidence.service
key=/tmp/kojo-native-evidence-key
policy=/etc/polkit-1/rules.d/49-kojo-native-evidence.rules

if [[ $(id -u) -ne 0 ]]; then
  echo "This controller must run in a separate root control session." >&2
  exit 1
fi

cleanup() {
  loginctl disable-linger "$evidence_user" >/dev/null 2>&1 || true
  loginctl terminate-user "$evidence_user" >/dev/null 2>&1 || true
  userdel --remove "$evidence_user" >/dev/null 2>&1 || true
  rm -f "$key" "$key.pub" "$policy"
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
  "$remote_prefix && id && stat -c 'RuntimeDirectory=%n Owner=%u Mode=%a' '$runtime_directory' && test -S '$runtime_directory/bus' && /usr/bin/systemctl --user import-environment HOME XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME && /usr/bin/systemctl --user show-environment && loginctl show-user '$evidence_user' --property=Sessions,Linger,State" \
  >"$evidence_directory/pam-session.log"

ssh "${ssh_arguments[@]}" \
  "$remote_prefix && moon run kojo:test-host" \
  2>&1 | tee "$evidence_directory/host-tests.log"

grep -E "^ ↓ .*the native macOS Daemon lifecycle" "$evidence_directory/host-tests.log" >/dev/null
grep -E "^ ✓ .*the native systemd user Daemon lifecycle" "$evidence_directory/host-tests.log" >/dev/null
grep -E "Tests[[:space:]]+1 passed[[:space:]]+\|[[:space:]]+1 skipped \(2\)" \
  "$evidence_directory/host-tests.log" >/dev/null

ssh "${ssh_arguments[@]}" \
  "$remote_prefix && bun '$fixture' install" \
  >"$evidence_directory/no-linger-install.json"
no_linger_child=$(jq -er .childProcessId "$evidence_directory/no-linger-install.json")
[[ $(loginctl show-user "$evidence_user" --property=Linger --value) == no ]]

for _ in $(seq 1 90); do
  if ! systemctl is-active --quiet "user@$evidence_uid.service" && \
    [[ ! -e "$endpoint" ]] && ! kill -0 "$no_linger_child" 2>/dev/null; then
    no_linger_stopped=yes
    break
  fi
  sleep 1
done
[[ ${no_linger_stopped:-no} == yes ]]
{
  echo "Linger=no"
  echo "UserManager=stopped"
  echo "Endpoint=removed"
  echo "ChildProcessGroup=stopped"
} >"$evidence_directory/final-logout-without-linger.log"

ssh "${ssh_arguments[@]}" \
  "$remote_prefix && bun '$fixture' install >'$evidence_directory/linger-install.json' && bun packages/kojo/src/main.ts daemon keep-running-after-logout >'$evidence_directory/keep-running-after-logout.log' && bun '$fixture' inspect >'$evidence_directory/linger-inspect.json'"
linger_child=$(jq -er .childProcessId "$evidence_directory/linger-inspect.json")

grep -F "This changes linger for the complete OS user. All user services can then run after logout." \
  "$evidence_directory/keep-running-after-logout.log" >/dev/null
grep -F "Keep running after logout: enabled." \
  "$evidence_directory/keep-running-after-logout.log" >/dev/null
[[ $(loginctl show-user "$evidence_user" --property=Linger --value) == yes ]]

sleep 5
systemctl is-active --quiet "user@$evidence_uid.service"
[[ -z $(loginctl show-user "$evidence_user" --property=Sessions --value) ]]
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
} >"$evidence_directory/final-logout-with-linger.log"

ssh "${ssh_arguments[@]}" \
  "$remote_prefix && bun '$fixture' remove" \
  >"$evidence_directory/removal.json"
[[ $(loginctl show-user "$evidence_user" --property=Linger --value) == yes ]]
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
  echo "HostTests=1 passed, 1 skipped, 2 loaded"
  echo "NamedSkip=the native macOS Daemon lifecycle"
} >"$evidence_directory/host-facts.log"
