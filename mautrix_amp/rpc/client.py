# mautrix-amp - A very hacky Matrix-SMS bridge based on using Android Messages for Web in Puppeteer
# Copyright (C) 2020 Tulir Asokan
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
from typing import AsyncGenerator, TypedDict, List, Dict, Callable, Awaitable, Any
from collections import deque
import asyncio

from .rpc import RPCClient
from .types import ChatListInfo, ChatInfo, Message, StartStatus


class QRCommand(TypedDict):
    url: str


class LoginComplete(Exception):
    pass


class Client(RPCClient):
    async def start(self) -> StartStatus:
        await self.connect()
        return StartStatus.deserialize(await self.request("start"))

    async def stop(self) -> None:
        await self.request("stop")
        await self.disconnect()

    async def get_chats(self) -> List[ChatListInfo]:
        resp = await self.request("get_chats")
        return [ChatListInfo.deserialize(data) for data in resp]

    async def get_chat(self, chat_id: int) -> ChatInfo:
        return ChatInfo.deserialize(await self.request("get_chat", chat_id=chat_id))

    async def get_messages(self, chat_id: int) -> List[Message]:
        resp = await self.request("get_messages", chat_id=chat_id)
        return [Message.deserialize(data) for data in resp]

    async def send(self, chat_id: int, text: str) -> int:
        resp = await self.request("send", chat_id=chat_id, text=text)
        return resp["id"]

    async def set_last_message_ids(self, msg_ids: Dict[int, int]) -> None:
        await self.request("set_last_message_ids", msg_ids=msg_ids)

    async def on_message(self, func: Callable[[Message], Awaitable[None]]) -> None:
        async def wrapper(data: Dict[str, Any]) -> None:
            await func(Message.deserialize(data["message"]))

        self.add_event_handler("message", wrapper)

    async def login(self) -> AsyncGenerator[str, None]:
        data = deque()
        event = asyncio.Event()

        async def qr_handler(req: QRCommand) -> None:
            data.append(req["url"])
            event.set()

        def login_handler(_fut: asyncio.Future) -> None:
            data.append(None)
            event.set()

        login_future = await self._raw_request("login")
        login_future.add_done_callback(login_handler)

        self.add_event_handler("qr", qr_handler)
        try:
            while True:
                await event.wait()
                while item := data.popleft():
                    if item is None:
                        return
                    yield item
                event.clear()
        finally:
            self.remove_event_handler("qr", qr_handler)
