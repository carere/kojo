# Per-user Daemon lifecycle mechanisms

This research supports the Kojo lifecycle manager.

## Required properties

- Exactly one managed Daemon for each OS user.
- Start on login or on explicit install.
- A stable per-user data root and local API endpoint.
- Status, logs, stop, and uninstall operations.
- No Project repository owns the process or production store.
- A manually started second Daemon must fail its ownership check.

## macOS

Use a user LaunchAgent. Install the document under the user launch domain and use `launchctl` for
bootstrap, bootout, kickstart, and print. The document runs `kojo daemon serve --managed` with the
resolved executable and per-user paths.

## Linux

Use a systemd user unit. Install it under the user configuration directory and use
`systemctl --user` for enable, start, stop, status, and journal access. The unit runs
`kojo daemon serve --managed`.

## Kojo rule

The service manager provides lifecycle integration. Kojo still enforces its own Daemon ownership
record because an unmanaged process can bypass the manager. The ownership record belongs in the
per-user data root, not in a Project.

The lifecycle environment contains only Daemon configuration. Agent execution policy belongs to
the registered Project and its captured Workflow Revision.
