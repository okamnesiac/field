"""bloom-aced: daemon-lite lifecycle, translated from bloom-audiod.

Spawned by the CLI with its cwd at the project root; binds a root-relative
socket (sun_path is 104 bytes), owns it via a lifetime flock, serves
NDJSON, and idle-exits — but never mid-generation. One generation at a
time: the model is the resource, and "busy" is an honest answer.
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
from typing import IO, cast

from .adapter import Pipeline
from .protocol import (
    DAEMON_NAME,
    DAEMON_VERSION,
    PROTOCOL_VERSION,
    GenerateJob,
    JsonObject,
    error_response,
    ok_response,
)


# A function boundary rather than inline partitioning: the declared return
# type severs the buffer→partition→buffer cycle pyright's narrowing
# otherwise collapses to Unknown.
def _split_lines(data: bytes) -> tuple[list[bytes], bytes]:
    lines = data.split(b"\n")
    return lines[:-1], lines[-1]


class Server:
    def __init__(self, socket_path: str, idle_seconds: int) -> None:
        self._socket_path = socket_path
        self._idle_seconds = idle_seconds
        self._pipeline = Pipeline()
        self._lock_file: IO[bytes] | None = None
        self._listener: socket.socket | None = None
        self._connections: list[socket.socket] = []
        self._connections_lock = threading.Lock()
        self._last_activity = time.monotonic()
        self._generating = threading.Event()
        self._quit = threading.Event()

    def start(self) -> str | None:
        """Bind and serve; returns an error string instead of raising."""
        lock_path = self._socket_path + ".lock"
        lock_file = open(lock_path, "ab")  # noqa: SIM115 — held for daemon lifetime
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            lock_file.close()
            return f"another {DAEMON_NAME} already owns {self._socket_path}"
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
            if self._generating.is_set():
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
                        "daemon": DAEMON_NAME,
                        "version": DAEMON_VERSION,
                        "model_loaded": self._pipeline.loaded,
                    },
                ),
            )
        elif op == "generate":
            if self._generating.is_set():
                self._send(connection, error_response(request_id, "a generation is already running"))
                return
            job = GenerateJob.from_request(request)
            self._generating.set()
            threading.Thread(
                target=self._run_generation, args=(connection, job, request_id), daemon=True
            ).start()
        elif op == "quit":
            self._send(connection, ok_response(request_id))
            self._quit.set()
        else:
            self._send(connection, error_response(request_id, f"unknown op: {op!r}"))

    def _run_generation(self, connection: socket.socket, job: GenerateJob, request_id: object) -> None:
        try:
            def progress(fraction: float, stage: str) -> None:
                self._broadcast({"event": "progress", "fraction": fraction, "stage": stage})

            result = self._pipeline.generate(job, progress)
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
            self._generating.clear()
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


def main() -> int:
    parser = argparse.ArgumentParser(prog=DAEMON_NAME)
    parser.add_argument("--socket", default=".bloom/aced.sock")
    parser.add_argument("--idle", type=int, default=600)
    args = parser.parse_args()
    socket_path: str = args.socket
    idle_seconds: int = args.idle

    server = Server(socket_path, idle_seconds)
    error = server.start()
    if error is not None:
        print(f"{DAEMON_NAME}: {error}", file=sys.stderr)
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


if __name__ == "__main__":
    sys.exit(main())
