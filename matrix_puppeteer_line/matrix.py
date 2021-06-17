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
from typing import TYPE_CHECKING

from mautrix.bridge import BaseMatrixHandler
from mautrix.types import (Event, ReactionEvent, MessageEvent, StateEvent, EncryptedEvent, RedactionEvent,
                           ReceiptEvent, SingleReceiptEventContent,
                           EventID, RoomID, UserID)

from . import portal as po, puppet as pu, user as u
from .db import Message as DBMessage

if TYPE_CHECKING:
    from .__main__ import MessagesBridge


class MatrixHandler(BaseMatrixHandler):
    def __init__(self, bridge: 'MessagesBridge') -> None:
        prefix, suffix = bridge.config["bridge.username_template"].format(userid=":").split(":")
        homeserver = bridge.config["homeserver.domain"]
        self.user_id_prefix = f"@{prefix}"
        self.user_id_suffix = f"{suffix}:{homeserver}"

        super().__init__(bridge=bridge)

    def filter_matrix_event(self, evt: Event) -> bool:
        if isinstance(evt, ReceiptEvent):
            return False
        if not isinstance(evt, (MessageEvent, StateEvent, EncryptedEvent)):
            return True
        return (evt.sender == self.az.bot_mxid
                or pu.Puppet.get_id_from_mxid(evt.sender) is not None)

    async def send_welcome_message(self, room_id: RoomID, inviter: 'u.User') -> None:
        await super().send_welcome_message(room_id, inviter)
        if not inviter.notice_room:
            inviter.notice_room = room_id
            await inviter.update()
            await self.az.intent.send_notice(room_id, "This room has been marked as your "
                                                      "LINE bridge notice room.")

    async def handle_leave(self, room_id: RoomID, user_id: UserID, event_id: EventID) -> None:
        portal = await po.Portal.get_by_mxid(room_id)
        if not portal:
            return

        user = await u.User.get_by_mxid(user_id, create=False)
        if not user:
            return

        await portal.handle_matrix_leave(user)

    async def handle_read_receipt(self, user: 'u.User', portal: 'po.Portal', event_id: EventID,
                                  data: SingleReceiptEventContent) -> None:
        # When reading a bridged message, view its chat in LINE, to make it send a read receipt.

        # TODO Use *null* mids for last messages in a chat!!
        # Only visit a LINE chat when its LAST bridge message has been read,
        # because LINE lacks per-message read receipts--it's all or nothing!
        # TODO Also view if message is non-last but for media, so it can be loaded.
        #if await DBMessage.is_last_by_mxid(event_id, portal.mxid):

        # Viewing a chat by updating it whole-hog, lest a ninja arrives
        await user.sync_portal(portal)
