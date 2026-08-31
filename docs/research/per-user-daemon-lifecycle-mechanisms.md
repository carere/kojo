# Per-user daemon lifecycle mechanisms

## Question

How can Kojo install and manage one daemon for one user on macOS and Linux? The daemon must start
at login, remain a singleton, recover from failure, stop cleanly, support upgrade and removal, and
use the correct user paths and permissions. What changes when the user logs out?

This note covers a macOS LaunchAgent and a Linux systemd user service. It uses Apple and systemd
documentation and source as evidence. The current Apple manuals were checked on macOS 26.6.2,
build 25G83. It does not select the final Kojo CLI grammar.

## Result

Kojo needs two lifecycle adapters. The common contract can contain `install`, `start`, `status`,
`stop`, `restart`, `upgrade`, and `remove`. The adapters cannot have one common logout policy.

| Property | macOS LaunchAgent | Linux systemd user service |
| --- | --- | --- |
| Natural scope | One GUI login session | One user manager for one UID |
| Start automatically | At GUI login | When the user manager starts, usually at a PAM login |
| Continue after final logout | No supported LaunchAgent mode | Yes, only with user lingering |
| Start before login | Not as a per-user LaunchAgent | Yes, with user lingering |
| Supervisor rule | `KeepAlive` in a plist | `Restart` in a service unit |
| Clean stop | `SIGTERM`, then `SIGKILL` after `ExitTimeOut` | `SIGTERM`, then `SIGKILL` after `TimeoutStopSec` |
| Definition location | `~/Library/LaunchAgents/<label>.plist` | `~/.config/systemd/user/<name>.service` by default |
| Elevated permission | Not for a user-owned LaunchAgent | Not for a user unit; linger policy is a separate operation |

The important product decision is the logout requirement. If the Kojo daemon only runs while the
user has a GUI login session, a LaunchAgent and a non-lingering systemd user service have similar
lives. If the daemon must watch factories when no user is logged in, systemd user lingering can do
that. A macOS LaunchAgent cannot. That macOS requirement would need a privileged system
LaunchDaemon or a different product shape.

## macOS: LaunchAgent

### Installation and start at login

Apple loads third-party per-user agents from `~/Library/LaunchAgents`. It loads agents from that
directory when the user logs in. Apple describes a user agent as a process for one logged-in user
that runs only while that user is logged in. A plist in `/Library/LaunchAgents` applies to all users,
but its installation is a machine-wide operation. Kojo can avoid root access when it installs its
plist in the current user's directory. See [Apple's launchd directory table](https://support.apple.com/guide/terminal/script-management-with-launchd-apdc6c1077b-5d5d-4d35-9c19-60f2397b2369/mac)
and [Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

The plist needs one stable, reverse-DNS `Label`. The label uniquely identifies the job in its
launchd domain. `KeepAlive=true` asks launchd to keep the daemon running and also implies
`RunAtLoad`. A job that exits too often is throttled. The daemon must stay in the foreground. It
must not fork and let its parent exit. See Apple's [launchd plist reference](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5).

Installation and activation are separate actions:

1. Write and validate the plist in `~/Library/LaunchAgents`.
2. Use `launchctl bootstrap gui/$UID <plist>` to load it in the current GUI domain.
3. Use `launchctl enable gui/$UID/<label>` only when Kojo must clear a persistent disabled state.

`bootstrap` loads a definition. `enable` and `disable` control a separate state that persists across
boots. `kickstart` starts an already loaded service now. Apple marks the old `load`, `unload`,
`start`, and `stop` verbs as legacy. See Apple's current [`launchctl(1)` manual](x-man-page://1/launchctl),
which is also available on macOS with `man launchctl`. Apple's open-source repository contains an older
[launchctl manual](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchctl.1),
which does not contain the current domain verbs.

### Behavior after logout

At final GUI logout, launchd sends `SIGTERM` to the user agents that it started. A LaunchAgent does
not supply a supported linger mode. Apple explicitly says that user agents execute only while the
user is logged in. See [the per-user launch sequence](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
and [Apple's background-process comparison](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/DesigningDaemons.html).

The current `launchctl` model also has a `user/<uid>` domain that can exist without a logged-in user.
That fact does not change the documented lifetime of an automatically loaded user LaunchAgent.
Kojo must not use the existence of that domain as a promise that its agent continues after logout.

A system LaunchDaemon continues when no user is logged in. It can use `UserName` to run its process
as a selected user, but its definition is in `/Library/LaunchDaemons`, must be owned by root, and
needs a privileged installation. It also changes the model from “the current user installs their
daemon” to “an administrator installs a machine service for a selected account.” This is a separate
architecture, not a LaunchAgent option. See [Apple's system and user context description](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/DesigningDaemons.html)
and the [launchd plist `UserName` rule](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5).

### Singleton and supervision

The label makes one virtual service in one launchd domain. `KeepAlive=true` causes launchd to
replace the process after it exits. Launchd throttles repeated short lives. This gives one
supervised process when all starts go through launchd.

This is not a complete Kojo singleton rule. A user can still run `kojo watch factory` directly and
create a second process outside launchd. The daemon must also own one exclusive runtime endpoint or
lock. The second process must fail with a clear “daemon already runs” result. The lock must contain
no trusted PID-only check because PIDs can be reused.

When the main job dies, launchd also kills remaining children that have the same process-group ID.
`AbandonProcessGroup=true` disables this behavior and Kojo must not set it. This cleanup is narrower
than a Linux cgroup. A child that creates another process group, a container runtime, or a remote
sandbox can remain. Kojo must close those resources through its own scopes. This rule is in the
current Apple [`launchd.plist(5)` manual](x-man-page://5/launchd.plist), also available on macOS
with `man launchd.plist`. Apple's older
open-source [launchd plist reference](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5)
is the primary source for the other plist rules in this section.

### Clean stop, forced stop, and restart

The daemon must handle `SIGTERM`, stop accepting new work, interrupt active Effect scopes, close
sandboxes and child processes, flush the trace, remove its runtime endpoint, and exit. Apple tells
launchd jobs to handle `SIGTERM` and unwind outstanding work quickly. See the
[launchd job expectations](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5).

`ExitTimeOut` controls the interval between `SIGTERM` and `SIGKILL` when launchd stops the job. A
zero value means no limit and can block shutdown. Kojo must set a finite value that is long enough
for trace and sandbox cleanup. See Apple's current
[`launchd.plist(5)` manual](x-man-page://5/launchd.plist).

For a manager-directed stop, use `launchctl bootout gui/$UID/<label>`. This removes the loaded
definition, so `KeepAlive` does not immediately start the process again. The plist stays on disk,
so a later GUI login can load it again. A direct `launchctl kill SIGTERM` or `SIGKILL` only signals
the running process. `KeepAlive` can then replace it. Thus, a raw signal is not the implementation
of `kojo daemon stop`.

`launchctl kickstart -k gui/$UID/<label>` kills a running instance and starts it again. This is a
fast forced restart. For a clean restart, and for any plist change, use `bootout`, wait for the stop,
then `bootstrap` the plist again. See Apple's current [`launchctl(1)` manual](x-man-page://1/launchctl).

### Upgrade and removal

Launchd does not reload a changed plist in place. An upgrade must use this sequence:

1. Stop and remove the loaded definition with `bootout`.
2. Replace the executable and plist without changing the stable label.
3. Load the new definition with `bootstrap`.
4. Check the Kojo control endpoint, not only the process ID.

If only the executable changes at one stable path, a restart is technically enough. The full
sequence is safer because it also applies definition changes and preserves a clean-stop interval.

Removal must first use `bootout` and then delete the plist. Kojo must decide what to do with the
separate persistent disabled state and the durable factory data. Service removal and data removal
must be different user choices.

On macOS 13 and later, an app can register bundled LaunchAgents with `SMAppService`. This route
keeps the plist and helper in a signed app bundle, reports authorization state, and lets users see
the providing app in System Settings. Registration immediately bootstraps an approved LaunchAgent
and registers it for later logins. A user can also disable the background item in System Settings,
so registration is not proof that the service is authorized now. See [`SMAppService`](https://developer.apple.com/documentation/servicemanagement/smappservice?language=objc),
[`register()`](https://developer.apple.com/documentation/servicemanagement/smappservice/register%28%29),
[`status`](https://developer.apple.com/documentation/servicemanagement/smappservice/3945414-status),
[Apple's background-item guide](https://support.apple.com/en-ca/guide/deployment/depdca572563/web),
and [Apple's package sample](https://developer.apple.com/documentation/ServiceManagement/updating-your-app-package-installer-to-use-the-new-service-management-api).

Kojo is now a Bun-installed CLI, not a signed macOS app bundle. `SMAppService` therefore needs a new
macOS package shape. It is not a drop-in replacement for a user-owned plist. It can become useful if
Kojo later ships a macOS app.

## Linux: systemd user manager

### Installation and start at login

The normal private unit location is `$XDG_CONFIG_HOME/systemd/user`, or
`~/.config/systemd/user` when `XDG_CONFIG_HOME` is not set. Systemd also searches package and
administrator locations, but a per-user Kojo install does not need them. See the
[systemd user-unit search path](https://github.com/systemd/systemd/blob/main/man/systemd.unit.xml).

A user-owned install can use this sequence:

1. Write `kojo.service` in the private user-unit directory.
2. Run `systemctl --user daemon-reload`.
3. Run `systemctl --user enable --now kojo.service`.

`enable` creates links from the unit's `[Install]` section. It does not start the service unless
`--now` is present. Starting and enabling are orthogonal operations. See the
[systemctl enable contract](https://github.com/systemd/systemd/blob/main/man/systemctl.xml).

The unit should use `Type=exec`. Kojo stays in the foreground, so it does not need `Type=forking`
or a PID file. `Type=exec` reports an error when systemd cannot execute the selected program.
Systemd recommends it for long-running services. See the [systemd service types](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml).

The user manager normally starts for the first login session that uses `pam_systemd`. A GUI, TTY,
or SSH login can create that session when the host has the applicable PAM integration. This is
different from the macOS LaunchAgent, which is tied to a GUI login. Systemd creates one user
manager for the UID, so concurrent sessions share the same `kojo.service`. See
[`pam_systemd`](https://www.freedesktop.org/software/systemd/man/251/pam_systemd.html).

This mechanism requires systemd, systemd-logind, and the user-manager integration. “Linux” alone is
not enough. Kojo must detect this support and report an unsupported host instead of assuming that
all Linux distributions have `systemctl --user`.

### Behavior after logout and lingering

Without lingering, logind stops the user manager after the final session ends. A small
`UserStopDelaySec` can delay that stop. The current upstream default is 10 seconds. The user's
runtime directory is then removed. See the [upstream logind defaults](https://github.com/systemd/systemd/blob/main/src/login/logind.conf.in)
and [`pam_systemd` logout behavior](https://www.freedesktop.org/software/systemd/man/251/pam_systemd.html).

`loginctl enable-linger` changes that life. Logind starts the user manager at boot and keeps it
after logout. It also keeps the user's runtime directory. The setting is persistent. See the
[login1 `SetUserLinger` contract](https://github.com/systemd/systemd/blob/main/man/org.freedesktop.login1.xml).

Upstream polkit policy lets a user change lingering for themselves. Changing it for another user
requires administrator authentication. A distribution can change this policy. See the
[upstream linger policy](https://github.com/systemd/systemd/blob/main/src/login/org.freedesktop.login1.policy).
Kojo must treat a denied linger request as an actionable host-policy result.

Linger is a property of the complete user manager, not of only Kojo. Removal must not run
`loginctl disable-linger` unless Kojo can prove that it enabled linger and that the user accepted
the effect on their other services. Even with that record, a confirmation is safer because other
user services can start to depend on linger after Kojo enables it.

### Singleton and supervision

The unit name identifies one service object in one user manager. Repeated `start` requests do not
create a second active unit. With `Type=exec`, the `ExecStart` process is the main process.

`Restart=on-failure` replaces the daemon after an abnormal exit, signal, timeout, or watchdog
failure. It does not replace the daemon after a manager-directed stop. `Restart=always` also
restarts clean exits. `RestartSec` sets the delay. Systemd also applies a start-rate limit. See the
[systemd restart rules](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml) and
[upstream rate-limit defaults](https://github.com/systemd/systemd/blob/main/man/systemd-system.conf.xml).

`Restart=on-failure` is the better default for Kojo. A deliberate clean exit should stay stopped so
the daemon can report an unrecoverable configuration state without a hot loop. The unit should set
an explicit `RestartSec` and start limit so behavior does not depend on distribution defaults.

As on macOS, the manager singleton does not stop a manually started `kojo watch factory`. Kojo
needs the same exclusive runtime endpoint or lock on both platforms.

### Clean stop, forced stop, and restart

`systemctl --user stop kojo.service` creates a manager stop job. By default, systemd sends
`SIGTERM` to the service control group. After `TimeoutStopSec`, it sends `SIGKILL` to remaining
processes. `KillMode=control-group` is the default and prevents child processes from escaping the
service life. See the [systemd kill procedure](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml).

This manager stop does not activate `Restart=on-failure`. A direct
`systemctl --user kill --signal=SIGKILL kojo.service` can look like an abnormal process death and
can cause a restart. Thus, Kojo must use a stop job for normal and timed forced stop. The configured
timeout already supplies the forced-stop stage.

`systemctl --user restart kojo.service` is a stop followed by a start. It runs the normal clean-stop
path. See the [systemctl restart contract](https://github.com/systemd/systemd/blob/main/man/systemctl.xml).

Kojo must still clean up sandbox processes explicitly. `KillMode=control-group` catches processes
that stay in the daemon's cgroup. It does not prove that a container runtime, remote sandbox, or
other process outside that cgroup is clean.

### Upgrade and removal

For a unit or executable update, use this sequence:

1. Stop the service.
2. Replace the executable and unit file.
3. Run `systemctl --user daemon-reload`.
4. Start the service and check the Kojo control endpoint.

For removal, use `systemctl --user disable --now kojo.service`, delete the unit file, then run
`systemctl --user daemon-reload`. `disable` removes enablement links but does not stop a unit unless
`--now` is present. See [systemctl unit-file operations](https://github.com/systemd/systemd/blob/main/man/systemctl.xml).

Service removal must not remove the factory registry, trace, or other durable Kojo data unless the
user asks for data removal.

## Paths, environment, and permissions

### Kojo paths on macOS

Apple assigns application-managed data and configuration to a product-specific directory under
`~/Library/Application Support`. It assigns re-creatable data to `~/Library/Caches`. It recommends
the user-specific temporary directory for temporary files and local IPC. See [Apple's file-system
directory rules](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html)
and [safe temporary-directory guidance](https://developer.apple.com/library/archive/documentation/Security/Conceptual/SecureCodingGuide/Articles/RaceConditions.html).

A consistent Kojo layout is:

| Purpose | macOS path |
| --- | --- |
| LaunchAgent definition | `~/Library/LaunchAgents/dev.kojo.daemon.plist` |
| Durable registry, trace, and host state | `~/Library/Application Support/Kojo/` |
| Kojo configuration that is not a user preference | `~/Library/Application Support/Kojo/config/` |
| Re-creatable cache | `~/Library/Caches/Kojo/` |
| Control socket and singleton lock | a `Kojo/` directory under the Darwin user temporary directory |

Kojo must obtain the temporary path from the platform, such as `_CS_DARWIN_USER_TEMP_DIR` or the
runtime's safe temporary-directory API. It must not hard-code `/tmp`. The runtime directory and its
contents are disposable. Durable run state and trace data must not be there.

The user's plist must be owned by that user and must not be group- or world-writable. A plist in
`/Library/LaunchAgents` must be owned by root. These checks prevent another user from changing the
program that launchd starts. See Apple's current [`launchctl(1)` manual](x-man-page://1/launchctl).

### Kojo paths on Linux

The XDG Base Directory specification gives separate homes for configuration, data, state, cache,
executables, and runtime files. It requires `XDG_RUNTIME_DIR` to be user-owned with mode `0700` and
ties its normal life to the login life. See the [XDG Base Directory specification](https://specifications.freedesktop.org/basedir/0.8/).

A consistent Kojo layout is:

| Purpose | Linux path |
| --- | --- |
| systemd user definition | `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/kojo.service` |
| Kojo configuration | `${XDG_CONFIG_HOME:-$HOME/.config}/kojo/` |
| Installed product data | `${XDG_DATA_HOME:-$HOME/.local/share}/kojo/` |
| Durable registry, trace, and host state | `${XDG_STATE_HOME:-$HOME/.local/state}/kojo/` |
| Re-creatable cache | `${XDG_CACHE_HOME:-$HOME/.cache}/kojo/` |
| Control socket and singleton lock | `$XDG_RUNTIME_DIR/kojo/` |

With lingering, logind keeps `XDG_RUNTIME_DIR` while the user is logged out. Without lingering, the
directory disappears after final logout. Kojo must recreate its runtime subdirectory and endpoint
on each daemon start. It must never place durable trace data there.

A non-root systemd user service runs as the same user as the user manager. It cannot switch to a
different user. It has the user's normal file permissions. See the [systemd user identity rules](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).

Systemd can create these paths for a user unit with `RuntimeDirectory=`, `StateDirectory=`,
`CacheDirectory=`, and `ConfigurationDirectory=`. Their modes default to `0755`. That default is
not private. If Kojo uses the managed-directory settings, the unit must set the related
`*DirectoryMode=0700` values for private runtime, state, and configuration. See the
[systemd managed-directory rules](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).

Both platforms therefore give the host daemon broad access to the user's repositories and
credentials. The daemon is trusted host code. An agent sandbox does not reduce the host daemon's
permissions.

### Environment and the Bun runtime

Neither service manager starts an interactive login shell for Kojo. Shell startup files are not a
portable source of `PATH`, tool paths, or configuration.

The macOS plist can set explicit `EnvironmentVariables`, `WorkingDirectory`, and an absolute
program. The Linux unit can set `Environment`, `EnvironmentFile`, `WorkingDirectory`, and an
absolute `ExecStart`. Systemd also has a user-manager environment, but it is separate from many
interactive shell environments. See the [launchd plist environment keys](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5),
the [systemd execution environment](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml),
and [`environment.d`](https://github.com/systemd/systemd/blob/main/man/environment.d.xml).

Kojo's installed command uses `#!/usr/bin/env bun`. This is unsafe as a daemon start contract when
the manager's `PATH` does not contain Bun. Installation must resolve a stable Bun executable and a
stable Kojo entry point, or install a stable launcher. The service definition must use absolute
paths and an explicit, limited `PATH` for child tools. Apple also recommends explicit program paths
to prevent `PATH` substitution. See [Apple's shell environment guidance](https://developer.apple.com/library/archive/documentation/OpenSource/Conceptual/ShellScripting/ShellScriptSecurity/ShellScriptSecurity.html).

At the time of this research, Kojo's invoker refused agent calls without a terminal unless
`KOJO_AGENT_SPEND=allow` was present. The resulting recommendation to request spend permission during
installation is superseded by [Define agent-spend authorization under the
Daemon](https://github.com/carere/kojo/issues/57). That decision requires removal of the spend guard;
it is not a service-manager constraint. This research note does not change the current runtime.

Tokens and other secrets must not be copied into the plist or unit. Environment values pass to
child processes and can leak. Store secrets in a user-only file or platform credential store, and
let Kojo load only what a specific adapter needs. Apple warns that environment values can be read
or inherited by other processes. See [Apple's secure data guidance](https://developer.apple.com/library/archive/documentation/Security/Conceptual/SecureCodingGuide/SecurityDevelopmentChecklists/SecurityDevelopmentChecklists.html).

## Material Kojo CLI differences

The platform adapter can hide commands, but it must not hide different guarantees.

1. **Logout mode is a Linux-only choice.** A Linux install can offer a `linger` choice. A macOS
   LaunchAgent install cannot. If the product requires post-logout operation on macOS, installation
   must stop and explain that a privileged LaunchDaemon design is required.
2. **Login means different events.** A macOS LaunchAgent starts at GUI login. A systemd user unit
   can start for GUI, TTY, or SSH login through PAM. With linger, it starts at boot before login.
3. **Enable and start are not the same.** Systemd makes this explicit. On macOS, the loaded domain,
   the on-disk plist, and the persistent disabled state are also separate. `status` must report at
   least installed, enabled, loaded, running, and responsive as distinct facts.
4. **Machine-readable status differs.** Systemd has stable commands such as `is-enabled`,
   `is-active`, and `show`. Apple's `launchctl print` manual says its printed structure is not an
   API. On macOS, Kojo can use the command exit result for loaded/not-loaded and use its own control
   endpoint for health. It must not parse the human `print` tree as a stable schema. An app-bundled
   `SMAppService` can report authorization state, but a raw Bun CLI plist cannot use that status API
   without changing the package shape.
5. **Stop must go through the manager.** A direct signal can activate `KeepAlive` or `Restart`.
   The user-facing stop operation must request a manager stop and let the configured timeout do the
   forced stage.
6. **Upgrade reload differs.** Systemd has `daemon-reload`. Launchd needs `bootout` and `bootstrap`
   to apply a changed plist.
7. **Linger ownership matters.** Systemd linger affects all services for that user. Kojo removal
   must not disable it as if it belonged only to Kojo.
8. **The executable path is a product contract.** Both definitions need a stable, absolute Bun and
   Kojo path. A version-manager path can change after an upgrade. Installation must detect and
   repair stale paths.
9. **The daemon needs its own singleton endpoint.** Native service identity prevents duplicate
   manager starts. It does not prevent a manual `kojo watch factory` process.
10. **Service removal and data removal are different.** Uninstall the supervisor definition without
    deleting the factory registry or trace. A separate explicit purge can remove durable data.

## Constraints for the later decision

1. Decide whether “unattended” means “while the user is logged in” or “when no user is logged in.”
2. If post-logout work is required, select Linux linger explicitly and define a separate macOS
   architecture. Do not claim LaunchAgent parity.
3. Define a platform-neutral daemon lifecycle state model before defining the CLI text.
4. Keep the service label and unit name stable across upgrades.
5. Use manager-directed stop with a finite cleanup timeout.
6. Add a Kojo-owned control endpoint or lock for singleton enforcement and health checks.
7. Use absolute executable paths. Do not depend on a shell profile or the interactive `PATH`.
8. Apply [Define agent-spend authorization under the Daemon](https://github.com/carere/kojo/issues/57)
   in place of the original recommendation to configure `KOJO_AGENT_SPEND` during installation.
9. Detect unsupported Linux hosts and denied linger policy with actionable errors.
10. Never undo systemd linger automatically unless Kojo can prove ownership and the user confirms
    the effect on other services.
11. Keep runtime endpoints disposable and durable factory state in a persistent user data or state
    directory.
12. Keep lifecycle removal and durable-data removal as separate operations.
