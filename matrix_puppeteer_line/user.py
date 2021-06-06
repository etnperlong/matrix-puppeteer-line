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
from typing import Dict, List, Optional, TYPE_CHECKING, cast
from collections import defaultdict
import asyncio

from mautrix.bridge import BaseUser
from mautrix.types import UserID, RoomID
from mautrix.appservice import AppService, IntentAPI
from mautrix.util.opt_prometheus import Gauge

from .db import User as DBUser, Portal as DBPortal, Message as DBMessage
from .config import Config
from .rpc import Client, Message, Receipt
from . import puppet as pu, portal as po

if TYPE_CHECKING:
    from .__main__ import MessagesBridge

METRIC_CONNECTED = Gauge("bridge_connected", "Users connected to LINE")


class User(DBUser, BaseUser):
    by_mxid: Dict[UserID, 'User'] = {}
    config: Config
    az: AppService
    loop: asyncio.AbstractEventLoop

    client: Optional[Client]
    intent: Optional[IntentAPI]
    is_real_user = True

    _notice_room_lock: asyncio.Lock
    _connection_check_task: Optional[asyncio.Task]

    def __init__(self, mxid: UserID, notice_room: Optional[RoomID] = None) -> None:
        super().__init__(mxid=mxid, notice_room=notice_room)
        self._notice_room_lock = asyncio.Lock()
        self.command_status = None
        self.is_whitelisted = self.is_admin = self.config["bridge.user"] == mxid
        self.log = self.log.getChild(self.mxid)
        self._metric_value = defaultdict(lambda: False)
        self._connection_check_task = None
        self.client = None
        self.intent = None

    @classmethod
    def init_cls(cls, bridge: 'MessagesBridge') -> None:
        cls.config = bridge.config
        cls.az = bridge.az
        cls.loop = bridge.loop
        Client.config = bridge.config

    async def send_bridge_notice(self, text) -> None:
        if self.notice_room:
            self.log.debug(f"Sending bridge notice: {text}")
            await self.az.intent.send_notice(self.notice_room, text)

    async def is_logged_in(self) -> bool:
        try:
            return self.client and (await self.client.start()).is_logged_in
        except Exception:
            return False

    async def try_connect(self) -> None:
        try:
            await self.connect()
        except Exception:
            self.log.exception("Error while connecting to puppeteer script")

    async def connect_double_puppet(self) -> None:
        self.log.debug("Trying to log in with shared secret")
        try:
            access_token = await pu.Puppet._login_with_shared_secret(self.mxid)
            if not access_token:
                self.log.warning("Failed to log in with shared secret")
                return
            self.log.debug("Logged in with shared secret")
            self.intent = self.az.intent.user(self.mxid, access_token)
        except Exception:
            self.log.exception("Error logging in with shared secret")

    async def connect(self) -> None:
        self.loop.create_task(self.connect_double_puppet())
        self.client = Client(self.mxid)
        self.log.debug("Starting client")
        await self.send_bridge_notice("Starting up...")
        state = await self.client.start()
        await self.client.on_message(self.handle_message)
        await self.client.on_receipt(self.handle_receipt)
        if state.is_connected:
            self._track_metric(METRIC_CONNECTED, True)
        if state.is_logged_in:
            await self.send_bridge_notice("Already logged in to LINE")
            self.loop.create_task(self._try_sync())
        else:
            await self.send_bridge_notice("Ready to log in to LINE")

    async def _try_sync(self) -> None:
        try:
            await self.sync()
        except Exception:
            self.log.exception("Exception while syncing")

    async def _check_connection_loop(self) -> None:
        while True:
            self._track_metric(METRIC_CONNECTED, await self.client.is_connected())
            await asyncio.sleep(5)

    async def sync(self) -> None:
        if self._connection_check_task:
            self._connection_check_task.cancel()
        self._connection_check_task = self.loop.create_task(self._check_connection_loop())
        await self.client.set_last_message_ids(await DBMessage.get_max_mids())
        self.log.info("Syncing chats")
        await self.send_notice("Synchronizing chats...")
        await self.client.pause()
        chats = await self.client.get_chats()
        limit = self.config["bridge.initial_conversation_sync"]
        for index, chat in enumerate(chats):
            portal = await po.Portal.get_by_chat_id(chat.id, create=True)
            if portal.mxid or index < limit:
                chat = await self.client.get_chat(chat.id)
                if portal.mxid:
                    await portal.update_matrix_room(self, chat)
                else:
                    await portal.create_matrix_room(self, chat)
        await self.client.resume()
        await self.send_notice("Synchronization complete")

    async def stop(self) -> None:
        # TODO Notices for shutdown messages
        if self._connection_check_task:
            self._connection_check_task.cancel()
            self._connection_check_task = None
        if self.client:
            await self.client.stop()

    async def get_direct_chats(self) -> Dict[UserID, List[RoomID]]:
        return {
            pu.Puppet.get_mxid_from_id(portal.other_user): [portal.mxid]
            for portal in await DBPortal.find_private_chats()
            if portal.mxid
        }

    async def handle_message(self, evt: Message) -> None:
        self.log.trace("Received message %s", evt)
        portal = await po.Portal.get_by_chat_id(evt.chat_id, create=True)
        puppet = await pu.Puppet.get_by_mid(evt.sender.id) if not portal.is_direct else None
        if not portal.mxid:
            await self.client.set_last_message_ids(await DBMessage.get_max_mids())
            chat_info = await self.client.get_chat(evt.chat_id)
            await portal.create_matrix_room(self, chat_info)
        await portal.handle_remote_message(self, puppet, evt)

    async def handle_receipt(self, receipt: Receipt) -> None:
        self.log.trace(f"Received receipt for chat {receipt.chat_id}")
        portal = await po.Portal.get_by_chat_id(receipt.chat_id, create=True)
        if not portal.mxid:
            chat_info = await self.client.get_chat(receipt.chat_id)
            await portal.create_matrix_room(self, chat_info)
        await portal.handle_remote_receipt(receipt)

    def _add_to_cache(self) -> None:
        self.by_mxid[self.mxid] = self

    @classmethod
    async def get_by_mxid(cls, mxid: UserID, create: bool = True) -> Optional['User']:
        try:
            return cls.by_mxid[mxid]
        except KeyError:
            pass

        user = cast(cls, await super().get_by_mxid(mxid))
        if user is not None:
            user._add_to_cache()
            return user

        if create:
            user = cls(mxid)
            await user.insert()
            user._add_to_cache()
            return user

        return None
