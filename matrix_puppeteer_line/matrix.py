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
from mautrix.types import (Event, EventType, MessageEvent, StateEvent, EncryptedEvent,
                           ReceiptEvent, SingleReceiptEventContent, TextMessageEventContent,
                           EventID, RoomID, UserID)
from mautrix.errors import MatrixError

from . import portal as po, puppet as pu, user as u

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

    async def handle_puppet_invite(self, room_id: RoomID, puppet: 'pu.Puppet',
                                   invited_by: 'u.User', _: EventID) -> None:
        intent = puppet.intent
        self.log.debug(f"{invited_by.mxid} invited puppet for {puppet.mid} to {room_id}")
        if not await invited_by.is_logged_in():
            await intent.error_and_leave(room_id, text="Please log in before inviting "
                                                       "LINE puppets to private chats.")
            return

        portal = await po.Portal.get_by_mxid(room_id)
        if portal:
            if portal.is_direct:
                await intent.error_and_leave(room_id, text="You can not invite additional users "
                                                           "to private chats.")
            else:
                # TODO Send invite in LINE
                await intent.error_and_leave(room_id, text="Inviting additional users to an existing "
                                                           "group chat is not yet supported.")
            return

        await intent.join_room(room_id)
        try:
            members = await intent.get_room_members(room_id)
        except MatrixError:
            self.log.exception(f"Failed to get member list after joining {room_id}")
            await intent.leave_room(room_id)
            return
        if len(members) > 2:
            # TODO Add LINE group/room creating. Must also distinguish between the two!
            await intent.send_notice(room_id, "You can not invite LINE puppets to "
                                              "multi-user rooms.")
            await intent.leave_room(room_id)
            return

        portal = await po.Portal.get_by_chat_id(puppet.mid, create=True)
        if portal.mxid:
            try:
                await intent.invite_user(portal.mxid, invited_by.mxid, check_cache=False)
                await intent.send_notice(room_id,
                                         text=("You already have a private chat with me "
                                               f"in room {portal.mxid}"),
                                         html=("You already have a private chat with me: "
                                               f"<a href='https://matrix.to/#/{portal.mxid}'>"
                                               "Link to room"
                                               "</a>"))
                await intent.leave_room(room_id)
                return
            except MatrixError:
                pass

        portal.mxid = room_id
        e2be_ok = await portal.check_dm_encryption()
        # TODO Consider setting other power levels that get set on portal creation,
        #      but they're of little use when the inviting user has an equal PL...
        await portal.save()
        if e2be_ok is True:
            evt_type, content = await self.e2ee.encrypt(
                room_id, EventType.ROOM_MESSAGE,
                TextMessageEventContent(msgtype=MessageType.NOTICE,
                                        body="Portal to private chat created and end-to-bridge"
                                             " encryption enabled."))
            await intent.send_message_event(room_id, evt_type, content)
        else:
            message = "Portal to private chat created."
            if e2be_ok is False:
                message += "\n\nWarning: Failed to enable end-to-bridge encryption"
            await intent.send_notice(room_id, message)

        # TODO Put pause/resume in portal methods, with a lock or something
        # TODO Consider not backfilling on invite.
        #      To do so, must set the last-seen message ID appropriately
        await invited_by.client.pause()
        try:
            chat_info = await invited_by.client.get_chat(puppet.mid)
            await portal.update_matrix_room(invited_by, chat_info)
        finally:
            await invited_by.client.resume()

    async def handle_join(self, room_id: RoomID, user_id: UserID, _: EventID) -> None:
        user = await u.User.get_by_mxid(user_id)

        portal = await po.Portal.get_by_mxid(room_id)
        if not portal:
            return

        if not user.is_whitelisted:
            await portal.main_intent.kick_user(room_id, user.mxid,
                                               "You are not whitelisted on this LINE bridge.")
            return
        elif not await user.is_logged_in():
            await portal.main_intent.kick_user(room_id, user.mxid,
                                               "You are not logged in to this LINE bridge.")
            return

        self.log.debug(f"{user.mxid} joined {room_id}")

    async def handle_leave(self, room_id: RoomID, user_id: UserID, event_id: EventID) -> None:
        portal = await po.Portal.get_by_mxid(room_id)
        if not portal:
            return

        user = await u.User.get_by_mxid(user_id, create=False)
        if not user:
            return

        await portal.handle_matrix_leave(user)

    async def handle_reject(self, room_id: RoomID, user_id: UserID, reason: str, event_id: EventID) -> None:
        await self.handle_leave(room_id, user_id, event_id)

    async def handle_read_receipt(self, user: 'u.User', portal: 'po.Portal', event_id: EventID,
                                  data: SingleReceiptEventContent) -> None:
        # When reading a bridged message, view its chat in LINE, to make it send a read receipt.

        # TODO Use *null* mids for last messages in a chat!!
        # Only visit a LINE chat when its LAST bridge message has been read,
        # because LINE lacks per-message read receipts--it's all or nothing!
        # TODO Also view if message is non-last but for media, so it can be loaded.
        #if await DBMessage.is_last_by_mxid(event_id, portal.mxid):

        # Viewing a chat by updating it whole-hog, lest a ninja arrives
        if not user.is_syncing:
            await user.sync_portal(portal)
