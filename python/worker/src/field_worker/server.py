"""Daemon-lite lifecycle, translated from field-audiod and now shared.

Spawned by the CLI with its cwd at the project root; binds a root-relative
socket (sun_path is 104 bytes), owns it via a lifetime flock, serves
NDJSON, and idle-exits — but never mid-generation. One generation at a
time: the model is the resource, and "busy" is an honest answer.

This was `field_aced.main` until voice-generation.md §1.4 wanted a second
worker. Copying it would have duplicated the flock ownership, the
single-flight gate, the idle-exit rule and the SIGTERM unlink — including
the stale-socket bug the comments below record finding live — into two
files that must then be fixed twice. ace-generation.md §3 said the
protocol was built so ACE would be "the first client, not a special
case"; this is that claim being cashed rather than restated.

A worker supplies a `Backend`: how to parse its job, and how to run it.
Everything else here is the same for both, which is the point.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import signal
import socket
import sys
import threading
import time
from types import FrameType
from typing import IO, Callable, Generic, Protocol, TypeVar, cast

from .protocol import (
    PROTOCOL_VERSION,
    GenerationOutput,
    JsonObject,
    error_response,
    ok_response,
)

ProgressCallback = Callable[[float, str], None]
"""(fraction 0..1, human-readable stage) — forwarded to socket clients."""

JobT = TypeVar("JobT")


class Backend(Protocol[JobT]):
    """The whole of a worker's own surface.

    `loaded` answers `hello` without touching the model, which is what
    lets a bare interpreter serve the protocol: both workers import their
    model package lazily, so spawn, handshake, request validation and
    quit all work with no model environment at all.
    """

    @property
    def loaded(self) -> bool: ...

    def parse_job(self, request: JsonObject) -> JobT: ...

    def generate(self, job: JobT, progress: ProgressCallback) -> GenerationOutput: ...


# A function boundary rather than inline partitioning: the declared return
# type severs the buffer→partition→buffer cycle pyright's narrowing
# otherwise collapses to Unknown.
def _split_lines(data: bytes) -> tuple[list[bytes], bytes]:
    lines = data.split(b"\n")
    return lines[:-1], lines[-1]


class Server(Generic[JobT]):
    def __init__(
        self,
        socket_path: str,
        idle_seconds: int,
        name: str,
        version: str,
        backend: Backend[JobT],
    ) -> None:
        self._socket_path = socket_path
        self._idle_seconds = idle_seconds
        self._name = name
        self._version = version
        self._backend = backend
        self._lock_file: IO[bytes] | None = None
        self._listener: socket.socket | None = None
        self._connections: list[socket.socket] = []
        self._connections_lock = threading.Lock()
        self._last_activity = time.monotonic()
        # Single-flight gate: acquire(blocking=False) is the atomic
        # check-and-set an Event's is_set()/set() pair is not — two reader
        # threads must never both pass (the model is the resource).
        self._generation_gate = threading.Lock()
        self._quit = threading.Event()

    def start(self) -> str | None:
        """Bind and serve; returns an error string instead of raising."""
        lock_path = self._socket_path + ".lock"
        lock_file = open(lock_path, "ab")  # noqa: SIM115 — held for daemon lifetime
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            lock_file.close()
            return f"another {self._name} already owns {self._socket_path}"
        self._lock_file = lock_file  # the flock dies with the process; never unlink the file

        try:
            os.unlink(self._socket_path)
        except FileNotFoundError:
            pass
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(self._socket_path)
        listener.listen(8)
        self._listener = listener
        threading.Thread(target=self._accept_loop, daemon=True).start()
        return None

    def request_quit(self) -> None:
        self._quit.set()

    def run_until_idle(self) -> None:
        while not self._quit.is_set():
            time.sleep(0.5)
            if self._generation_gate.locked():
                self._last_activity = time.monotonic()
                continue
            with self._connections_lock:
                connected = len(self._connections) > 0
            if not connected and time.monotonic() - self._last_activity > self._idle_seconds:
                return

    def _accept_loop(self) -> None:
        assert self._listener is not None
        while True:
            try:
                connection, _ = self._listener.accept()
            except OSError:
                return
            with self._connections_lock:
                self._connections.append(connection)
            self._last_activity = time.monotonic()
            threading.Thread(target=self._read_loop, args=(connection,), daemon=True).start()

    def _read_loop(self, connection: socket.socket) -> None:
        buffer: bytes = b""
        try:
            while True:
                chunk: bytes = connection.recv(4096)
                if not chunk:
                    break
                lines, buffer = _split_lines(buffer + chunk)
                for line in lines:
                    if line.strip():
                        self._handle_line(connection, line)
        finally:
            with self._connections_lock:
                if connection in self._connections:
                    self._connections.remove(connection)
            connection.close()
            self._last_activity = time.monotonic()

    def _handle_line(self, connection: socket.socket, line: bytes) -> None:
        self._last_activity = time.monotonic()
        request_id: object = None
        try:
            parsed: object = json.loads(line)
            if not isinstance(parsed, dict):
                raise ValueError("request must be a JSON object")
            request = cast(JsonObject, parsed)
            request_id = request.get("id")
            self._dispatch(connection, request, request_id)
        except Exception as err:  # noqa: BLE001 — every failure becomes a protocol error
            self._send(connection, error_response(request_id, str(err)))

    def _dispatch(self, connection: socket.socket, request: JsonObject, request_id: object) -> None:
        op = request.get("op")
        if op == "hello":
            self._send(
                connection,
                ok_response(
                    request_id,
                    {
                        "protocol": PROTOCOL_VERSION,
                        "daemon": self._name,
                        "version": self._version,
                        "model_loaded": self._backend.loaded,
                    },
                ),
            )
        elif op == "generate":
            job = self._backend.parse_job(request)
            if not self._generation_gate.acquire(blocking=False):
                self._send(connection, error_response(request_id, "a generation is already running"))
                return
            threading.Thread(
                target=self._run_generation, args=(connection, job, request_id), daemon=True
            ).start()
        elif op == "quit":
            self._send(connection, ok_response(request_id))
            self._quit.set()
        else:
            self._send(connection, error_response(request_id, f"unknown op: {op!r}"))

    def _run_generation(self, connection: socket.socket, job: JobT, request_id: object) -> None:
        try:

            def progress(fraction: float, stage: str) -> None:
                self._broadcast({"event": "progress", "fraction": fraction, "stage": stage})

            result = self._backend.generate(job, progress)
            self._send(
                connection,
                ok_response(
                    request_id,
                    {
                        "paths": [str(p) for p in result.paths],
                        "seeds": result.seeds,
                        "model": result.model,
                    },
                ),
            )
        except Exception as err:  # noqa: BLE001
            self._send(connection, error_response(request_id, str(err)))
        finally:
            self._generation_gate.release()
            self._last_activity = time.monotonic()

    def _send(self, connection: socket.socket, message: JsonObject) -> None:
        try:
            connection.sendall((json.dumps(message) + "\n").encode())
        except OSError:
            pass  # a vanished client is the read loop's cleanup to handle

    def _broadcast(self, message: JsonObject) -> None:
        with self._connections_lock:
            connections = list(self._connections)
        for connection in connections:
            self._send(connection, message)


def serve(
    name: str,
    version: str,
    backend: Backend[JobT],
    default_socket: str,
    default_idle: int = 600,
) -> int:
    """The `main()` both workers are: parse args, bind, serve, unlink."""
    parser = argparse.ArgumentParser(prog=name)
    parser.add_argument("--socket", default=default_socket)
    parser.add_argument("--idle", type=int, default=default_idle)
    args = parser.parse_args()
    socket_path: str = args.socket
    idle_seconds: int = args.idle

    server = Server(socket_path, idle_seconds, name, version, backend)
    error = server.start()
    if error is not None:
        print(f"{name}: {error}", file=sys.stderr)
        return 1

    # A SIGTERM'd daemon must still unlink its socket — a pkill during
    # development left a stale socket a client then raced (found live).
    def on_terminate(_signum: int, _frame: FrameType | None) -> None:
        server.request_quit()

    signal.signal(signal.SIGTERM, on_terminate)
    server.run_until_idle()
    try:
        os.unlink(socket_path)
    except FileNotFoundError:
        pass
    return 0
