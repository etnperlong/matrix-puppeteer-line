# mautrix-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
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
from typing import Dict, Optional, List, Set, Any, AsyncGenerator, NamedTuple, TYPE_CHECKING, cast
import mimetypes
import asyncio

import magic

from mautrix.appservice import AppService, IntentAPI
from mautrix.bridge import BasePortal, NotificationDisabler
from mautrix.types import (EventID, MessageEventContent, RoomID, EventType, MessageType,
                           TextMessageEventContent, MediaMessageEventContent,
                           ContentURI, EncryptedFile)
from mautrix.errors import MatrixError
from mautrix.util.simple_lock import SimpleLock
from mautrix.util.network_retry import call_with_net_retry

from .db import Portal as DBPortal, Message as DBMessage
from .config import Config
from .rpc import ChatInfo, Participant, Message
from . import user as u, puppet as p, matrix as m

if TYPE_CHECKING:
    from .__main__ import MessagesBridge

try:
    from mautrix.crypto.attachments import encrypt_attachment, decrypt_attachment
except ImportError:
    encrypt_attachment = decrypt_attachment = None

StateBridge = EventType.find("m.bridge", EventType.Class.STATE)
StateHalfShotBridge = EventType.find("uk.half-shot.bridge", EventType.Class.STATE)
ReuploadedMediaInfo = NamedTuple('ReuploadedMediaInfo', mxc=Optional[ContentURI],
                                 decryption_info=Optional[EncryptedFile],
                                 mime_type=str, file_name=str, size=int)


class Portal(DBPortal, BasePortal):
    by_mxid: Dict[RoomID, 'Portal'] = {}
    by_chat_id: Dict[int, 'Portal'] = {}
    config: Config
    matrix: 'm.MatrixHandler'
    az: AppService

    _main_intent: Optional[IntentAPI]
    _create_room_lock: asyncio.Lock
    backfill_lock: SimpleLock
    _last_participant_update: Set[str]

    _main_intent: IntentAPI

    def __init__(self, chat_id: int, other_user: Optional[str] = None,
                 mxid: Optional[RoomID] = None, name: Optional[str] = None, encrypted: bool = False
                 ) -> None:
        super().__init__(chat_id, other_user, mxid, name, encrypted)
        self._create_room_lock = asyncio.Lock()
        self.log = self.log.getChild(str(chat_id))

        self.backfill_lock = SimpleLock("Waiting for backfilling to finish before handling %s",
                                        log=self.log)
        self._main_intent = None
        self._reaction_lock = asyncio.Lock()
        self._last_participant_update = set()

    @property
    def is_direct(self) -> bool:
        return self.other_user is not None

    @property
    def main_intent(self) -> IntentAPI:
        if not self._main_intent:
            raise ValueError("Portal must be postinit()ed before main_intent can be used")
        return self._main_intent

    @classmethod
    def init_cls(cls, bridge: 'MessagesBridge') -> None:
        cls.config = bridge.config
        cls.matrix = bridge.matrix
        cls.az = bridge.az
        cls.loop = bridge.loop
        cls.bridge = bridge
        NotificationDisabler.puppet_cls = p.Puppet
        NotificationDisabler.config_enabled = cls.config["bridge.backfill.disable_notifications"]

    async def _send_delivery_receipt(self, event_id: EventID) -> None:
        if event_id and self.config["bridge.delivery_receipts"]:
            try:
                await self.az.intent.mark_read(self.mxid, event_id)
            except Exception:
                self.log.exception("Failed to send delivery receipt for %s", event_id)

    async def handle_matrix_message(self, sender: 'u.User', message: MessageEventContent,
                                    event_id: EventID) -> None:
        if not sender.client:
            self.log.debug(f"Ignoring message {event_id} as user is not connected")
            return
        elif ((message.get(self.bridge.real_user_content_key,
                           False) and await p.Puppet.get_by_custom_mxid(sender.mxid))):
            self.log.debug(f"Ignoring puppet-sent message by confirmed puppet user {sender.mxid}")
            return
        # TODO deduplication of outgoing messages
        text = message.body
        media_id = None
        if message.msgtype == MessageType.EMOTE:
            text = f"/me {text}"
        elif message.msgtype.is_media:
            # if message.file and decrypt_attachment:
            #     data = await self.main_intent.download_media(message.file.url)
            #     data = decrypt_attachment(data, message.file.key.key,
            #                               message.file.hashes.get("sha256"), message.file.iv)
            # else:
            #     data = await self.main_intent.download_media(message.url)
            # mime_type = message.info.mimetype or magic.from_buffer(data, mime=True)
            # TODO media
            return
        message_id = await sender.client.send(self.chat_id, text)
        msg = DBMessage(mxid=event_id, mx_room=self.mxid, mid=message_id, chat_id=self.chat_id)
        await msg.insert()
        await self._send_delivery_receipt(event_id)
        self.log.debug(f"Handled Matrix message {event_id} -> {message_id}")

    async def handle_matrix_leave(self, user: 'u.User') -> None:
        if self.is_direct:
            self.log.info(f"{user.mxid} left private chat portal with {self.other_user}, "
                          f"cleaning up and deleting...")
            await self.cleanup_and_delete()
        else:
            self.log.debug(f"{user.mxid} left portal to {self.chat_id}")
            # TODO cleanup if empty

    async def handle_remote_message(self, source: 'u.User', evt: Message) -> None:
        if evt.is_outgoing:
            if not source.intent:
                self.log.warning(f"Ignoring message {evt.id}: double puppeting isn't enabled")
                return
            intent = source.intent
        elif self.other_user:
            intent = (await p.Puppet.get_by_mid(self.other_user)).intent
        else:
            # TODO group chats
            self.log.warning(f"Ignoring message {evt.id}: group chats aren't supported yet")
            return

        if await DBMessage.get_by_mid(evt.id):
            self.log.debug(f"Ignoring duplicate message {evt.id}")
            return

        event_id = None
        if evt.image:
            content = await self._handle_remote_photo(source, intent, evt)
            if content:
                event_id = await self._send_message(intent, content, timestamp=evt.timestamp)
        if evt.text and not evt.text.isspace():
            content = TextMessageEventContent(msgtype=MessageType.TEXT, body=evt.text)
            event_id = await self._send_message(intent, content, timestamp=evt.timestamp)
        if event_id:
            msg = DBMessage(mxid=event_id, mx_room=self.mxid, mid=evt.id, chat_id=self.chat_id)
            await msg.insert()
            await self._send_delivery_receipt(event_id)
            self.log.debug(f"Handled remote message {evt.id} -> {event_id}")

    async def _handle_remote_photo(self, source: 'u.User', intent: IntentAPI, message: Message
                                   ) -> Optional[MediaMessageEventContent]:
        # TODO
        pass

    async def _reupload_remote_media(self, data: bytes, intent: IntentAPI) -> ReuploadedMediaInfo:
        upload_mime_type = mime_type = magic.from_buffer(data, mime=True)
        upload_file_name = file_name = f"image{mimetypes.guess_extension(mime_type)}"
        decryption_info = None
        if self.encrypted and encrypt_attachment:
            data, decryption_info = encrypt_attachment(data)
            upload_mime_type = "application/octet-stream"
            upload_file_name = None

        mxc = await call_with_net_retry(intent.upload_media, data, mime_type=upload_mime_type,
                                        filename=upload_file_name, _action="upload media")

        if decryption_info:
            decryption_info.url = mxc
            mxc = None

        return ReuploadedMediaInfo(mxc, decryption_info, mime_type, file_name, len(data))

    async def update_info(self, conv: ChatInfo) -> None:
        if len(conv.participants) == 1:
            self.other_user = conv.participants[0].id
            if self._main_intent is self.az.intent:
                self._main_intent = (await p.Puppet.get_by_mid(self.other_user)).intent
        for participant in conv.participants:
            puppet = await p.Puppet.get_by_mid(participant.id)
            await puppet.update_info(participant)
        changed = await self._update_name(conv.name)
        if changed:
            await self.update_bridge_info()
            await self.update()
        await self._update_participants(conv.participants)

    async def _update_name(self, name: str) -> bool:
        if self.name != name:
            self.name = name
            if self.mxid:
                await self.main_intent.set_room_name(self.mxid, name)
            return True
        return False

    async def _update_participants(self, participants: List[Participant]) -> None:
        if not self.mxid:
            return

        # Store the current member list to prevent unnecessary updates
        current_members = {participant.id for participant in participants}
        if current_members == self._last_participant_update:
            self.log.trace("Not updating participants: list matches cached list")
            return
        self._last_participant_update = current_members

        # Make sure puppets who should be here are here
        for participant in participants:
            puppet = await p.Puppet.get_by_mid(participant.id)
            await puppet.intent.ensure_joined(self.mxid)

        print(current_members)

        # Kick puppets who shouldn't be here
        for user_id in await self.main_intent.get_room_members(self.mxid):
            if user_id == self.az.bot_mxid:
                continue
            mid = p.Puppet.get_id_from_mxid(user_id)
            if mid and mid not in current_members:
                print(mid)
                await self.main_intent.kick_user(self.mxid, user_id,
                                                 reason="User had left this chat")

    async def backfill(self, source: 'u.User') -> None:
        with self.backfill_lock:
            self.log.debug("Backfill: TODO!")
            #await self._backfill(source)

    async def _backfill(self, source: 'u.User') -> None:
        self.log.debug("Backfilling history through %s", source.mxid)

        max_mid = await DBMessage.get_max_mid(self.mxid) or 0
        messages = [msg for msg in await source.client.get_messages(self.chat_id)
                    if msg.id > max_mid]

        if not messages:
            self.log.debug("Didn't get any entries from server")
            return

        self.log.debug("Got %d messages from server", len(messages))
        async with NotificationDisabler(self.mxid, source):
            for evt in messages:
                await self.handle_remote_message(source, evt)
        self.log.info("Backfilled %d messages through %s", len(messages), source.mxid)

    @property
    def bridge_info_state_key(self) -> str:
        return f"net.maunium.line://line/{self.chat_id}"

    @property
    def bridge_info(self) -> Dict[str, Any]:
        return {
            "bridgebot": self.az.bot_mxid,
            "creator": self.main_intent.mxid,
            "protocol": {
                "id": "line",
                "displayname": "LINE",
                "avatar_url": self.config["appservice.bot_avatar"],
            },
            "channel": {
                "id": self.chat_id,
                "displayname": self.name,
            }
        }

    async def update_bridge_info(self) -> None:
        if not self.mxid:
            self.log.debug("Not updating bridge info: no Matrix room created")
            return
        try:
            self.log.debug("Updating bridge info...")
            await self.main_intent.send_state_event(self.mxid, StateBridge,
                                                    self.bridge_info, self.bridge_info_state_key)
            # TODO remove this once https://github.com/matrix-org/matrix-doc/pull/2346 is in spec
            await self.main_intent.send_state_event(self.mxid, StateHalfShotBridge,
                                                    self.bridge_info, self.bridge_info_state_key)
        except Exception:
            self.log.warning("Failed to update bridge info", exc_info=True)

    async def update_matrix_room(self, source: 'u.User', info: ChatInfo) -> Optional[RoomID]:
        try:
            await self._update_matrix_room(source, info)
        except Exception:
            self.log.exception("Failed to update portal")

    async def create_matrix_room(self, source: 'u.User', info: ChatInfo) -> Optional[RoomID]:
        if self.mxid:
            await self.update_matrix_room(source, info)
            return self.mxid
        async with self._create_room_lock:
            return await self._create_matrix_room(source, info)

    async def _update_matrix_room(self, source: 'u.User', info: ChatInfo) -> None:
        await self.main_intent.invite_user(self.mxid, source.mxid, check_cache=True)
        puppet = await p.Puppet.get_by_custom_mxid(source.mxid)
        if puppet:
            await puppet.az.intent.ensure_joined(self.mxid)

        await self.update_info(info)

    async def _create_matrix_room(self, source: 'u.User', info: ChatInfo) -> Optional[RoomID]:
        if self.mxid:
            await self._update_matrix_room(source, info)
            return self.mxid
        await self.update_info(info)
        self.log.debug("Creating Matrix room")
        name: Optional[str] = None
        initial_state = [{
            "type": str(StateBridge),
            "state_key": self.bridge_info_state_key,
            "content": self.bridge_info,
        }, {
            # TODO remove this once https://github.com/matrix-org/matrix-doc/pull/2346 is in spec
            "type": str(StateHalfShotBridge),
            "state_key": self.bridge_info_state_key,
            "content": self.bridge_info,
        }]
        invites = [source.mxid]
        if self.config["bridge.encryption.default"] and self.matrix.e2ee:
            self.encrypted = True
            initial_state.append({
                "type": str(EventType.ROOM_ENCRYPTION),
                "content": {"algorithm": "m.megolm.v1.aes-sha2"},
            })
            if self.is_direct:
                invites.append(self.az.bot_mxid)
        if self.encrypted or not self.is_direct:
            name = self.name
        if self.config["appservice.community_id"]:
            initial_state.append({
                "type": "m.room.related_groups",
                "content": {"groups": [self.config["appservice.community_id"]]},
            })
        initial_state.append({
            "type": str(EventType.ROOM_POWER_LEVELS),
            "content": {
                "users": {
                    self.az.bot_mxid: 100,
                    self.main_intent.mxid: 9001,
                },
                "events": {},
                "events_default": 100,
                "state_default": 50,
                "invite": 50,
                "redact": 0
            }
        })

        # We lock backfill lock here so any messages that come between the room being created
        # and the initial backfill finishing wouldn't be bridged before the backfill messages.
        with self.backfill_lock:
            self.mxid = await self.main_intent.create_room(name=name, is_direct=self.is_direct,
                                                           initial_state=initial_state,
                                                           invitees=invites)
            if not self.mxid:
                raise Exception("Failed to create room: no mxid returned")

            if self.encrypted and self.matrix.e2ee and self.is_direct:
                try:
                    await self.az.intent.ensure_joined(self.mxid)
                except Exception:
                    self.log.warning("Failed to add bridge bot "
                                     f"to new private chat {self.mxid}")

            await self.update()
            self.log.debug(f"Matrix room created: {self.mxid}")
            self.by_mxid[self.mxid] = self
            if not self.is_direct:
                await self._update_participants(info.participants)
            else:
                puppet = await p.Puppet.get_by_custom_mxid(source.mxid)
                if puppet:
                    try:
                        await puppet.az.intent.join_room_by_id(self.mxid)
                    except MatrixError:
                        self.log.debug("Failed to join custom puppet into newly created portal",
                                       exc_info=True)

            try:
                await self.backfill(source)
            except Exception:
                self.log.exception("Failed to backfill new portal")

        return self.mxid

    async def postinit(self) -> None:
        self.by_chat_id[self.chat_id] = self
        if self.mxid:
            self.by_mxid[self.mxid] = self
        if self.other_user:
            self._main_intent = (await p.Puppet.get_by_mid(self.other_user)).intent
        else:
            self._main_intent = self.az.intent

    async def delete(self) -> None:
        await DBMessage.delete_all(self.mxid)
        self.by_mxid.pop(self.mxid, None)
        self.mxid = None
        self.encrypted = False
        await self.update()

    async def save(self) -> None:
        await self.update()

    @classmethod
    async def all_with_room(cls) -> AsyncGenerator['Portal', None]:
        portals = await super().all_with_room()
        portal: cls
        for index, portal in enumerate(portals):
            try:
                yield cls.by_chat_id[portal.chat_id]
            except KeyError:
                await portal.postinit()
                yield portal

    @classmethod
    async def get_by_mxid(cls, mxid: RoomID) -> Optional['Portal']:
        try:
            return cls.by_mxid[mxid]
        except KeyError:
            pass

        portal = cast(cls, await super().get_by_mxid(mxid))
        if portal is not None:
            await portal.postinit()
            return portal

        return None

    @classmethod
    async def get_by_chat_id(cls, chat_id: int, create: bool = False) -> Optional['Portal']:
        try:
            return cls.by_chat_id[chat_id]
        except KeyError:
            pass

        portal = cast(cls, await super().get_by_chat_id(chat_id))
        if portal is not None:
            await portal.postinit()
            return portal

        if create:
            portal = cls(chat_id)
            await portal.insert()
            await portal.postinit()
            return portal

        return None
