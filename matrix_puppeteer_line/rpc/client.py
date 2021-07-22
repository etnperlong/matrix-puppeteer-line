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
from typing import AsyncGenerator, List, Tuple, Dict, Callable, Awaitable, Any
from collections import deque
from base64 import b64decode
import asyncio

from .rpc import RPCClient
from .types import ChatEvents, ChatListInfo, ChatInfo, ImageData, Message, Participant, Receipt, StartStatus


class Client(RPCClient):
    async def start(self) -> StartStatus:
        await self.connect()
        return StartStatus.deserialize(await self.request("start"))

    async def stop(self) -> None:
        await self.request("stop")
        await self.disconnect()

    async def pause(self) -> None:
        await self.request("pause")

    async def resume(self) -> None:
        await self.request("resume")

    async def get_own_profile(self) -> Participant:
        return Participant.deserialize(await self.request("get_own_profile"))

    async def get_contacts(self) -> List[Participant]:
        resp = await self.request("get_contacts")
        return [Participant.deserialize(data) for data in resp]

    async def get_chats(self) -> List[ChatListInfo]:
        resp = await self.request("get_chats")
        return [ChatListInfo.deserialize(data) for data in resp]

    async def get_chat(self, chat_id: str, force_view: bool = False) -> ChatInfo:
        return ChatInfo.deserialize(await self.request("get_chat", chat_id=chat_id, force_view=force_view))

    async def get_messages(self, chat_id: str) -> ChatEvents:
        return ChatEvents.deserialize(await self.request("get_messages", chat_id=chat_id))

    async def read_image(self, image_url: str) -> ImageData:
        resp = await self.request("read_image", image_url=image_url)
        if not resp.startswith("data:"):
            raise TypeError("Image data is not in the form of a Data URL")

        typestart = 5
        typeend = resp.find(",", typestart)
        data = bytes(resp[typeend+1:], "utf-8")

        paramstart = resp.rfind(";", typestart, typeend)
        if paramstart == -1:
            mime = resp[typestart:typeend]
        else:
            mime = resp[typestart:paramstart]
            if resp[paramstart+1:typeend] == "base64":
                data = b64decode(data)

        return ImageData(mime=mime, data=data)

    async def is_connected(self) -> bool:
        resp = await self.request("is_connected")
        return resp["is_connected"]

    async def send(self, chat_id: str, text: str) -> int:
        resp = await self.request("send", chat_id=chat_id, text=text)
        return resp["id"]

    async def send_file(self, chat_id: str, file_path: str) -> int:
        resp = await self.request("send_file", chat_id=chat_id, file_path=file_path)
        return resp["id"]

    async def set_last_message_ids(self, msg_ids: Dict[str, int], own_msg_ids: Dict[str, int], rct_ids: Dict[str, Dict[int, int]]) -> None:
        await self.request("set_last_message_ids", msg_ids=msg_ids, own_msg_ids=own_msg_ids, rct_ids=rct_ids)

    async def forget_chat(self, chat_id: str) -> None:
        await self.request("forget_chat", chat_id=chat_id)

    async def on_message(self, func: Callable[[Message], Awaitable[None]]) -> None:
        async def wrapper(data: Dict[str, Any]) -> None:
            await func(Message.deserialize(data["message"]))

        self.add_event_handler("message", wrapper)

    async def on_receipt(self, func: Callable[[Receipt], Awaitable[None]]) -> None:
        async def wrapper(data: Dict[str, Any]) -> None:
            await func(Receipt.deserialize(data["receipt"]))

        self.add_event_handler("receipt", wrapper)

    async def on_logged_out(self, func: Callable[[], Awaitable[None]]) -> None:
        async def wrapper(data: Dict[str, Any]) -> None:
            await func()

        self.add_event_handler("logged_out", wrapper)

    # TODO Type hint for sender
    async def login(self, sender, **login_data) -> AsyncGenerator[Tuple[str, str], None]:
        login_data["login_type"] = sender.command_status["login_type"]

        data = deque()
        event = asyncio.Event()

        async def qr_handler(req: Dict[str, str]) -> None:
            data.append(("qr", req["url"]))
            event.set()

        async def pin_handler(req: Dict[str, str]) -> None:
            data.append(("pin", req["pin"]))
            event.set()

        async def success_handler(req: Dict[str, str]) -> None:
            data.append(("login_success", None))
            event.set()

        async def failure_handler(req: Dict[str, str]) -> None:
            data.append(("login_failure", req.get("reason")))
            event.set()

        async def cancel_watcher() -> None:
            try:
                while sender.command_status is not None:
                    await asyncio.sleep(1)
                await self._raw_request("cancel_login")
            except asyncio.CancelledError:
                pass
        cancel_watcher_task = asyncio.create_task(cancel_watcher())

        def login_handler(_fut: asyncio.Future) -> None:
            cancel_watcher_task.cancel()
            e = _fut.exception()
            if e is not None:
                data.append(("error", str(e)))
            data.append(None)
            event.set()

        login_future = await self._raw_request("login", **login_data)
        login_future.add_done_callback(login_handler)

        self.add_event_handler("qr", qr_handler)
        self.add_event_handler("pin", pin_handler)
        self.add_event_handler("login_success", success_handler)
        self.add_event_handler("login_failure", failure_handler)
        try:
            while True:
                await event.wait()
                while len(data) > 0:
                    item = data.popleft()
                    if item is None:
                        return
                    yield item
                event.clear()
        finally:
            self.remove_event_handler("qr", qr_handler)
            self.remove_event_handler("pin", pin_handler)
            self.remove_event_handler("login_success", success_handler)
            self.remove_event_handler("login_failure", failure_handler)
