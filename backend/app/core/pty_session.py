"""Pure-asyncio PTY session. No threads, add_reader on the master fd."""
import asyncio
import fcntl
import os
import pty
import signal
import struct
import termios
from typing import Callable, Optional


class PtySession:
    def __init__(self, cmd: list[str], cwd: str, env: Optional[dict] = None,
                 cols: int = 80, rows: int = 24):
        self.cmd = cmd
        self.cwd = cwd
        self.env = env or os.environ.copy()
        self.cols = cols
        self.rows = rows
        self.master_fd: Optional[int] = None
        self.pid: Optional[int] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._on_output: Optional[Callable[[bytes], None]] = None
        self._reap_task: Optional[asyncio.Task] = None

    @staticmethod
    def _set_winsize(fd: int, cols: int, rows: int) -> None:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    async def start(self, on_output: Callable[[bytes], None], on_exit: Callable[[int], None]) -> None:
        self._loop = asyncio.get_running_loop()
        self._on_output = on_output

        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(self.cwd)
            except OSError:
                os.chdir("/")
            self.env["TERM"] = self.env.get("TERM", "xterm-256color")
            self.env["COLORTERM"] = "truecolor"
            os.execvpe(self.cmd[0], self.cmd, self.env)

        self.pid = pid
        self.master_fd = fd
        self._set_winsize(fd, self.cols, self.rows)
        os.set_blocking(fd, False)

        self._loop.add_reader(fd, self._on_readable)

        async def reap():
            try:
                await self._loop.run_in_executor(None, os.waitpid, pid, 0)
                on_exit(0)
            except ChildProcessError:
                on_exit(-1)

        self._reap_task = asyncio.create_task(reap())

    def _on_readable(self) -> None:
        if self.master_fd is None or self._on_output is None:
            return
        try:
            data = os.read(self.master_fd, 65536)
        except (OSError, BlockingIOError):
            return
        if not data:
            self.close()
            return
        self._on_output(data)

    def write(self, data: bytes) -> None:
        if self.master_fd is None:
            return
        try:
            os.write(self.master_fd, data)
        except (OSError, BlockingIOError):
            pass

    def resize(self, cols: int, rows: int) -> None:
        if self.master_fd is None:
            return
        self.cols, self.rows = cols, rows
        try:
            self._set_winsize(self.master_fd, cols, rows)
        except OSError:
            pass

    def close(self) -> None:
        if self.master_fd is not None and self._loop is not None:
            try:
                self._loop.remove_reader(self.master_fd)
            except (ValueError, KeyError):
                pass
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None
        if self.pid is not None:
            try:
                os.kill(self.pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
