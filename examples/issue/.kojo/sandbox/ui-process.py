#!/usr/bin/env python3
"""Keep one UI process group per sandbox, with a checked listener boundary."""
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

pid_file = Path('/tmp/kojo-ui.pid')
log_file = Path('/tmp/kojo-ui.log')


def listening(url):
    target = urllib.parse.urlparse(url)
    try:
        with socket.create_connection((target.hostname, target.port or 80), timeout=1):
            return True
    except OSError:
        return False


def stop(url):
    if pid_file.exists():
        pid = int(pid_file.read_text())
        for signum, delay in [(signal.SIGTERM, 3), (signal.SIGKILL, 1)]:
            try:
                os.killpg(pid, signum)
            except ProcessLookupError:
                break
            time.sleep(delay)
        pid_file.unlink(missing_ok=True)
    for _ in range(20):
        if not listening(url):
            return
        time.sleep(0.25)
    raise RuntimeError('The previous UI listener is still active. Stop this Run and inspect the sandbox.')


def start(command, url):
    if listening(url):
        raise RuntimeError('The UI port is already in use. Review will not use an existing server.')
    with log_file.open('wb') as output:
        process = subprocess.Popen(['sh', '-c', command], stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    pid_file.write_text(str(process.pid))
    try:
        for _ in range(120):
            if process.poll() is not None:
                raise RuntimeError('The UI command exited before review.\n' + log_file.read_text(errors='replace')[-16000:])
            try:
                with urllib.request.urlopen(url, timeout=1) as response:
                    if response.status == 200:
                        print(url)
                        return
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(1)
        raise RuntimeError('The UI did not become ready.\n' + log_file.read_text(errors='replace')[-16000:])
    except BaseException:
        stop(url)
        raise


if sys.argv[1] == 'start':
    start(sys.argv[2], sys.argv[3])
else:
    stop(sys.argv[2])
