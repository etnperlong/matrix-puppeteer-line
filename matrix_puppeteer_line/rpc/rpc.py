# matrix-puppeteer-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
# Copyright (C) 2020-2021 Tulir Asokan, Andrew Ferrazzutti
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.
from typing import Dict, Any, Callable, Awaitable, List, Optional, Tuple
import logging
import asyncio
import json

from mautrix.types import UserID
from mautrix.util.logging import TraceLogger

from ..config import Config
from .types import RPCError

EventHandler = Callable[[Dict[str, Any]], Awaitable[None]]


class RPCClient:
    config: Config
    loop: asyncio.AbstractEventLoop
    log: TraceLogger = logging.getLogger("mau.rpc")

    user_id: UserID
    _reader: Optional[asyncio.StreamReader]
    _writer: Optional[asyncio.StreamWriter]
    _req_id: int
    _min_broadcast_id: int
    _response_waiters: Dict[int, asyncio.Future]
    _event_handlers: Dict[str, List[EventHandler]]

    def __init__(self, user_id: UserID) -> None:
        self.log = self.log.getChild(user_id)
        self.loop = asyncio.get_running_loop()
        self.user_id = user_id
        self._req_id = 0
        self._min_broadcast_id = 0
        self._event_handlers = {}
        self._response_waiters = {}
        self._writer = None
        self._reader = None
        self._command_queue = asyncio.Queue()

    async def connect(self) -> None:
        if self._writer is not None:
            return

        if self.config["puppeteer.connection.type"] == "unix":
            r, w = await asyncio.open_unix_connection(self.config["puppeteer.connection.path"])
        elif self.config["puppeteer.connection.type"] == "tcp":
            r, w = await asyncio.open_connection(self.config["puppeteer.connection.host"],
                                                 self.config["puppeteer.connection.port"])
        else:
            raise RuntimeError("invalid puppeteer connection type")
        self._reader = r
        self._writer = w
        self.loop.create_task(self._try_read_loop())
        self.loop.create_task(self._command_loop())
        await self.request("register", user_id=self.user_id)

    async def disconnect(self) -> None:
        self._writer.write_eof()
        await self._writer.drain()
        self._writer = None
        self._reader = None

    @property
    def _next_req_id(self) -> int:
        self._req_id += 1
        return self._req_id

    def add_event_handler(self, method: str, handler: EventHandler) -> None:
        self._event_handlers.setdefault(method, []).append(handler)

    def remove_event_handler(self, method: str, handler: EventHandler) -> None:
        self._event_handlers.setdefault(method, []).remove(handler)

    async def _run_event_handler(self, req_id: int, command: str, req: Dict[str, Any]) -> None:
        if req_id > self._min_broadcast_id:
            self.log.debug(f"Ignoring duplicate broadcast {req_id}")
            return
        self._min_broadcast_id = req_id
        try:
            handlers = self._event_handlers[command]
        except KeyError:
            self.log.warning("No handlers for %s", command)
        else:
            for handler in handlers:
                try:
                    await handler(req)
                except Exception:
                    self.log.exception("Exception in event handler")

    async def _handle_incoming_line(self, line: str) -> None:
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            self.log.debug(f"Got non-JSON data from server: {line}")
            return
        try:
            req_id = req.pop("id")
            command = req.pop("command")
            is_sequential = req.pop("is_sequential", False)
        except KeyError:
            self.log.debug(f"Got invalid request from server: {line}")
            return
        if req_id < 0:
            if not is_sequential:
                self.loop.create_task(self._run_event_handler(req_id, command, req))
            else:
                self._command_queue.put_nowait((req_id, command, req))
            return
        try:
            waiter = self._response_waiters[req_id]
        except KeyError:
            self.log.debug(f"Nobody waiting for response to {req_id}")
            return
        if command == "response":
            waiter.set_result(req.get("response"))
        elif command == "error":
            waiter.set_exception(RPCError(req.get("error", line)))
        else:
            self.log.warning(f"Unexpected response command to {req_id}: {command} {req}")

    async def _command_loop(self) -> None:
        while True:
            req_id, command, req = await self._command_queue.get()
            await self._run_event_handler(req_id, command, req)
            self._command_queue.task_done()

    async def _try_read_loop(self) -> None:
        try:
            await self._read_loop()
        except Exception:
            self.log.exception("Fatal error in read loop")

    async def _read_loop(self) -> None:
        while self._reader is not None and not self._reader.at_eof():
            line = b''
            while True:
                try:
                    line += await self._reader.readuntil()
                    break
                except asyncio.exceptions.LimitOverrunError as e:
                    self.log.warning(f"Buffer overrun: {e}")
                    line += await self._reader.read(self._reader._limit)
            if not line:
                continue
            try:
                line_str = line.decode("utf-8")
            except UnicodeDecodeError:
                self.log.exception("Got non-unicode request from server: %s", line)
                continue
            try:
                await self._handle_incoming_line(line_str)
            except Exception:
                self.log.exception("Failed to handle incoming request %s", line_str)
        self.log.debug("Reader disconnected")
        self._reader = None
        self._writer = None

    async def _raw_request(self, command: str, **data: Any) -> asyncio.Future:
        req_id = self._next_req_id
        future = self._response_waiters[req_id] = self.loop.create_future()
        req = {"id": req_id, "command": command, **data}
        self.log.trace("Request %d: %s %s", req_id, command, data)
        self._writer.write(json.dumps(req).encode("utf-8"))
        self._writer.write(b"\n")
        await self._writer.drain()
        return future

    async def request(self, command: str, **data: Any) -> Any:
        future = await self._raw_request(command, **data)
        return await future
