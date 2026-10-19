#!/usr/bin/env python3
"""PID 1 for the LNbits container.

The upstream image has no ENTRYPOINT. This wrapper starts that image's
command as a child and forwards SIGTERM and SIGINT to the child's process
group, so Docker stop and deploys still shut LNbits down.

LNBITS_RESTART_INTERVAL_HOURS (default 96, 0 disables) is how long to run
before a planned recycle. The wrapper then sends SIGTERM, waits
LNBITS_RESTART_STOP_TIMEOUT_SECONDS (default 30), sends SIGKILL if the
process group is still alive, and exits 1. The compose restart policy
starts a new container. The clock starts when this process starts, so a
deploy resets it.
"""

from __future__ import annotations

import math
import os
import signal
import subprocess
import sys
import time

# Restated as CMD in the Dockerfile. Upstream lnbits/lnbits:v1.5.6 ships
# this exact command and no ENTRYPOINT; setting an ENTRYPOINT clears it.
UPSTREAM_COMMAND = (
    "sh",
    "-c",
    "uv --offline run lnbits --port $LNBITS_PORT --host $LNBITS_HOST --forwarded-allow-ips='*'",
)

INTERVAL_ENV = "LNBITS_RESTART_INTERVAL_HOURS"
STOP_TIMEOUT_ENV = "LNBITS_RESTART_STOP_TIMEOUT_SECONDS"
DEFAULT_INTERVAL_HOURS = 96.0
DEFAULT_STOP_TIMEOUT_SECONDS = 30.0
PLANNED_RESTART_EXIT = 1


class ConfigError(Exception):
    pass


def log(message: str) -> None:
    print(f"lnbits-restart-entrypoint: {message}", file=sys.stderr, flush=True)


def parse_non_negative(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw.strip())
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from exc
    if not math.isfinite(value) or value < 0:
        raise ConfigError(f"{name} must be a finite number >= 0, got {raw!r}")
    return value


def signal_name(signum: int) -> str:
    try:
        return signal.Signals(signum).name
    except ValueError:
        return str(signum)


def reap() -> None:
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def signal_group(pgid: int, signum: int) -> None:
    try:
        os.killpg(pgid, signum)
    except ProcessLookupError:
        pass
    except PermissionError:
        pass


def status_code(code: int | None) -> int:
    if code is None:
        return 1
    if code < 0:
        return 128 - code
    return code


def wait_for_group(proc: subprocess.Popen[bytes], pgid: int, deadline: float) -> bool:
    """True when the direct child and its process group are gone."""
    while True:
        reap()
        if proc.poll() is not None and not group_alive(pgid):
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        slice_timeout = min(0.2, remaining)
        if proc.poll() is None:
            try:
                proc.wait(timeout=slice_timeout)
            except subprocess.TimeoutExpired:
                pass
        else:
            time.sleep(slice_timeout)


def stop_group(proc: subprocess.Popen[bytes], timeout: float) -> None:
    """SIGTERM the child group, then SIGKILL if it outlives timeout."""
    pgid = proc.pid
    signal_group(pgid, signal.SIGTERM)
    if wait_for_group(proc, pgid, time.monotonic() + timeout):
        reap()
        return
    log(f"still running after {timeout:g}s, sending SIGKILL")
    signal_group(pgid, signal.SIGKILL)
    wait_for_group(proc, pgid, time.monotonic() + 5)
    reap()


def main(argv: list[str]) -> int:
    try:
        interval_hours = parse_non_negative(INTERVAL_ENV, DEFAULT_INTERVAL_HOURS)
        stop_timeout = parse_non_negative(STOP_TIMEOUT_ENV, DEFAULT_STOP_TIMEOUT_SECONDS)
    except ConfigError as exc:
        log(str(exc))
        return 1

    interval_seconds = interval_hours * 3600.0
    if interval_seconds != 0 and not math.isfinite(interval_seconds):
        log(f"{INTERVAL_ENV} is too large")
        return 1

    command = list(argv) if argv else list(UPSTREAM_COMMAND)
    child: subprocess.Popen[bytes] | None = None
    external_signal: int | None = None

    def on_stop(signum: int, _frame: object) -> None:
        nonlocal external_signal
        external_signal = signum
        if child is not None:
            signal_group(child.pid, signum)

    signal.signal(signal.SIGTERM, on_stop)
    signal.signal(signal.SIGINT, on_stop)

    try:
        child = subprocess.Popen(command, start_new_session=True)
    except FileNotFoundError:
        log(f"command not found: {command[0]}")
        return 127
    except OSError as exc:
        log(f"failed to start LNbits: {exc}")
        return 1

    if external_signal is not None:
        signal_group(child.pid, external_signal)

    if interval_seconds == 0:
        log("planned restart disabled")
        deadline: float | None = None
    else:
        log(f"planned restart in {interval_hours:g}h")
        deadline = time.monotonic() + interval_seconds

    while True:
        # Checked before poll() so a signal that already reaped the child
        # is still reported and is not turned into a planned restart.
        if external_signal is not None:
            log(f"received {signal_name(external_signal)}, waiting for LNbits to exit")
            if child.poll() is None:
                child.wait()
            break
        if child.poll() is not None:
            break
        if deadline is not None and time.monotonic() >= deadline:
            log("interval elapsed, stopping LNbits")
            if external_signal is not None:
                log(f"received {signal_name(external_signal)}, waiting for LNbits to exit")
                if child.poll() is None:
                    child.wait()
                break
            stop_group(child, stop_timeout)
            log("exiting so the container restart policy can start LNbits again")
            return PLANNED_RESTART_EXIT
        slice_timeout = 0.5
        if deadline is not None:
            slice_timeout = min(slice_timeout, max(0.0, deadline - time.monotonic()))
        try:
            child.wait(timeout=slice_timeout)
        except subprocess.TimeoutExpired:
            pass

    # The main process is gone. Drop leftover grandchildren (uvicorn) so
    # they cannot keep the container running after PID 1's child has exited.
    if group_alive(child.pid):
        stop_group(child, stop_timeout)
    else:
        reap()
    return status_code(child.returncode)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
