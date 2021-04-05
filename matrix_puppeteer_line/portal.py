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
from typing import Dict, Optional, List, Set, Any, AsyncGenerator, NamedTuple, TYPE_CHECKING, cast
from asyncpg.exceptions import UniqueViolationError
from html.parser import HTMLParser
import mimetypes
import asyncio

import magic
from random import randint
from os import remove

from mautrix.appservice import AppService, IntentAPI
from mautrix.bridge import BasePortal, NotificationDisabler
from mautrix.types import (EventID, MessageEventContent, RoomID, EventType, MessageType,
                           TextMessageEventContent, MediaMessageEventContent, Membership, Format,
                           ContentURI, EncryptedFile, ImageInfo,
                           RelatesTo, RelationType)
from mautrix.errors import MatrixError
from mautrix.util.simple_lock import SimpleLock
from mautrix.util.network_retry import call_with_net_retry

from .db import Portal as DBPortal, Message as DBMessage
from .config import Config
from .rpc import ChatInfo, Participant, Message, Client, PathImage
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
    invite_own_puppet_to_pm: bool = False
    by_mxid: Dict[RoomID, 'Portal'] = {}
    by_chat_id: Dict[int, 'Portal'] = {}
    config: Config
    matrix: 'm.MatrixHandler'
    az: AppService

    _main_intent: Optional[IntentAPI]
    _create_room_lock: asyncio.Lock
    backfill_lock: SimpleLock
    _last_participant_update: Set[str]

    def __init__(self, chat_id: int, other_user: Optional[str] = None,
                 mxid: Optional[RoomID] = None, name: Optional[str] = None,
                 icon_path: Optional[str] = None, icon_mxc: Optional[ContentURI] = None,
                 encrypted: bool = False) -> None:
        super().__init__(chat_id, other_user, mxid, name, icon_path, icon_mxc, encrypted)
        self._create_room_lock = asyncio.Lock()
        self.log = self.log.getChild(str(chat_id))

        self.backfill_lock = SimpleLock("Waiting for backfilling to finish before handling %s",
                                        log=self.log)
        self._main_intent = None
        self._reaction_lock = asyncio.Lock()
        self._last_participant_update = set()

    @property
    def is_direct(self) -> bool:
        return self.chat_id[0] == "u"

    @property
    def is_group(self) -> bool:
        return self.chat_id[0] == "c"

    @property
    def is_room(self) -> bool:
        return self.chat_id[0] == "r"

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
        cls.invite_own_puppet_to_pm = cls.config["bridge.invite_own_puppet_to_pm"]
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
        if message.msgtype.is_text:
            if message.msgtype == MessageType.EMOTE:
                text = f"/me {text}"
            message_id = await sender.client.send(self.chat_id, text)
        elif message.msgtype.is_media:
            if message.file and decrypt_attachment:
                data = await self.main_intent.download_media(message.file.url)
                data = decrypt_attachment(data, message.file.key.key,
                                          message.file.hashes.get("sha256"), message.file.iv)
            else:
                data = await self.main_intent.download_media(message.url)
            mime_type = message.info.mimetype or magic.from_buffer(data, mime=True)

            # TODO Set path from config
            file_path = f"/dev/shm/file_{randint(0,1000)}{mimetypes.guess_extension(mime_type)}"
            temp_file = open(file_path, 'wb')
            temp_file.write(data)
            message_id = await sender.client.send_file(self.chat_id, file_path)
            remove(file_path)
        msg = None
        if message_id != -1:
            try:
                msg = DBMessage(mxid=event_id, mx_room=self.mxid, mid=message_id, chat_id=self.chat_id)
                await msg.insert()
                await self._send_delivery_receipt(event_id)
                self.log.debug(f"Handled Matrix message {event_id} -> {message_id}")
            except UniqueViolationError as e:
                self.log.warning(f"Failed to handle Matrix message {event_id} -> {message_id}: {e}")
        if not msg:
            await self.main_intent.send_notice(
                self.mxid,
               "Posting this message to LINE may have failed.",
               relates_to=RelatesTo(rel_type=RelationType.REPLY, event_id=event_id))
            self.log.warning(f"Handled Matrix message {event_id} -> {message_id}")

    async def handle_matrix_leave(self, user: 'u.User') -> None:
        if self.is_direct:
            self.log.info(f"{user.mxid} left private chat portal with {self.other_user}, "
                          f"cleaning up and deleting...")
            await self.cleanup_and_delete()
        else:
            self.log.debug(f"{user.mxid} left portal to {self.chat_id}")
            # TODO cleanup if empty

    async def _bridge_own_message_pm(self, source: 'u.User', sender: Optional['p.Puppet'], mid: str,
                                     invite: bool = True) -> Optional[IntentAPI]:
        # Use bridge bot as puppet for own user when puppet for own user is unavailable
        # TODO Use own LINE puppet instead, if it's available
        intent = sender.intent if sender else self.az.intent
        if self.is_direct and (sender is None or sender.mid == source.mid and not sender.is_real_user):
            if self.invite_own_puppet_to_pm and invite:
                await self.main_intent.invite_user(self.mxid, intent.mxid)
            elif await self.az.state_store.get_membership(self.mxid,
                                                          intent.mxid) != Membership.JOIN:
                self.log.warning(f"Ignoring own {mid} in private chat because own puppet is not in"
                                 " room.")
                intent = None
        return intent

    async def handle_remote_message(self, source: 'u.User', sender: Optional['p.Puppet'],
                                    evt: Message) -> None:
        if evt.is_outgoing:
            if source.intent:
                intent = source.intent
            else:
                if not self.invite_own_puppet_to_pm:
                    self.log.warning(f"Ignoring message {evt.id}: double puppeting isn't enabled")
                    return
                intent = await self._bridge_own_message_pm(source, sender, f"message {evt.id}")
                if not intent:
                    return
        elif self.other_user:
            intent = (await p.Puppet.get_by_mid(self.other_user)).intent
        elif sender:
            intent = sender.intent
        else:
            self.log.warning(f"Ignoring message {evt.id}: sender puppet is unavailable")
            return

        if await DBMessage.get_by_mid(evt.id):
            self.log.debug(f"Ignoring duplicate message {evt.id}")
            return

        event_id = None
        if evt.image_url:
            content = await self._handle_remote_photo(source, intent, evt)
            event_id = await self._send_message(intent, content, timestamp=evt.timestamp)
        elif evt.html and not evt.html.isspace():
            chunks = []

            def handle_data(data):
                nonlocal chunks
                chunks.append({"type": "data", "data": data})

            def handle_starttag(tag, attrs):
                if tag == "img":
                    obj = {"type": tag}
                    for attr in attrs:
                        obj[attr[0]] = attr[1]
                    nonlocal chunks
                    chunks.append(obj)

            parser = HTMLParser()
            parser.handle_data = handle_data
            parser.handle_starttag = handle_starttag
            parser.feed(evt.html)

            msg_text = ""
            msg_html = None

            for chunk in chunks:
                ctype = chunk["type"]
                if ctype == "data":
                    msg_text += chunk["data"]
                    if msg_html:
                        msg_html += chunk["data"]
                elif ctype == "img":
                    if not msg_html:
                        msg_html = msg_text

                    cclass = chunk["class"]
                    if cclass == "emojione":
                        alt = chunk["alt"]
                    else:
                        alt = f':{"?" if "alt" not in chunk else "".join(filter(lambda char: char.isprintable(), chunk["alt"]))}:'

                    msg_text += alt
                    # TODO Make a standalone function for this, and cache mxc in DB
                    #      ID is some combination of data-stickon-pkg-cd, data-stickon-stk-cd, src
                    resp = await source.client.read_image(chunk["src"])
                    media_info = await self._reupload_remote_media(resp.data, intent, resp.mime)
                    msg_html += f'<img data-mx-emoticon src="{media_info.mxc}" alt="{alt}" title="{alt}" height="32">'

            content = TextMessageEventContent(
                msgtype=MessageType.TEXT,
                format=Format.HTML if msg_html else None,
                body=msg_text, formatted_body=msg_html)
            event_id = await self._send_message(intent, content, timestamp=evt.timestamp)
        if event_id:
            msg = DBMessage(mxid=event_id, mx_room=self.mxid, mid=evt.id, chat_id=self.chat_id)
            await msg.insert()
            await self._send_delivery_receipt(event_id)
            self.log.debug(f"Handled remote message {evt.id} -> {event_id}")

    async def _handle_remote_photo(self, source: 'u.User', intent: IntentAPI, message: Message
                                   ) -> Optional[MediaMessageEventContent]:
        resp = await source.client.read_image(message.image_url)
        media_info = await self._reupload_remote_media(resp.data, intent, resp.mime)
        return MediaMessageEventContent(url=media_info.mxc, file=media_info.decryption_info,
                                        msgtype=MessageType.IMAGE, body=media_info.file_name,
                                        info=ImageInfo(mimetype=media_info.mime_type, size=media_info.size))

    async def _reupload_remote_media(self, data: bytes, intent: IntentAPI,
                                     mime_type: str = None, file_name: str = None
                                     ) -> ReuploadedMediaInfo:
        if not mime_type:
            mime_type = magic.from_buffer(data, mime=True)
        upload_mime_type = mime_type
        if not file_name:
            file_name = f"image{mimetypes.guess_extension(mime_type)}"
        upload_file_name = file_name

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

    async def update_info(self, conv: ChatInfo, client: Optional[Client]) -> None:
        if self.is_direct:
            self.other_user = conv.participants[0].id
            if self._main_intent is self.az.intent:
                self._main_intent = (await p.Puppet.get_by_mid(self.other_user)).intent
        for participant in conv.participants:
            puppet = await p.Puppet.get_by_mid(participant.id)
            await puppet.update_info(participant, client)
        # TODO Consider setting no room name for non-group chats.
        #      But then the LINE bot itself may appear in the title...
        changed = await self._update_name(f"{conv.name} (LINE)")
        if client:
            if not self.is_direct:
                changed = await self._update_icon(conv.icon, client) or changed
            elif puppet and puppet.avatar_mxc != self.icon_mxc:
                changed = True
                self.icon_mxc = puppet.avatar_mxc
                if self.mxid:
                    await self.main_intent.set_room_avatar(self.mxid, self.icon_mxc)
        if changed:
            await self.update_bridge_info()
            await self.update()
        # NOTE Don't call this yet, lest puppets join earlier than
        #      when their user actually joined or sent a message.
        #await self._update_participants(conv.participants)

    async def _update_name(self, name: str) -> bool:
        if self.name != name:
            self.name = name
            if self.mxid:
                await self.main_intent.set_room_name(self.mxid, name)
            return True
        return False

    async def _update_icon(self, icon: Optional[PathImage], client: Client) -> bool:
        icon_path = icon.path if icon else None
        if icon_path != self.icon_path:
            self.icon_path = icon_path
            if icon and icon.url:
                resp = await client.read_image(icon.url)
                self.icon_mxc = await self.main_intent.upload_media(resp.data, mime_type=resp.mime)
            else:
                self.icon_mxc = ContentURI("")
            if self.mxid:
                await self.main_intent.set_room_avatar(self.mxid, self.icon_mxc)
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
        try:
            with self.backfill_lock:
                await self._backfill(source)
        except Exception:
            self.log.exception("Failed to backfill portal")

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
            # Member joins/leaves are not shown in chat history.
            # Best we can do is have a puppet join if its user had sent a message.
            members_known = set(await self.main_intent.get_room_members(self.mxid)) if not self.is_direct else None
            for evt in messages:
                puppet = await p.Puppet.get_by_mid(evt.sender.id) if not self.is_direct else None
                if puppet and evt.sender.id not in members_known:
                    await puppet.update_info(evt.sender, source.client)
                    members_known.add(evt.sender.id)
                await self.handle_remote_message(source, puppet, evt)
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

        await self.update_info(info, source.client)
        await self.backfill(source)
        await self._update_participants(info.participants)

    async def _create_matrix_room(self, source: 'u.User', info: ChatInfo) -> Optional[RoomID]:
        if self.mxid:
            await self._update_matrix_room(source, info)
            return self.mxid
        await self.update_info(info, source.client)
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
        # NOTE Set the room title even for direct chats, because
        #      the LINE bot itself may appear in the title otherwise.
        #if self.encrypted or not self.is_direct:
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
                    self.main_intent.mxid: 100,
                }
            }
        })
        if self.icon_mxc:
            initial_state.append({
                "type": str(EventType.ROOM_AVATAR),
                "content": {
                    "url": self.icon_mxc
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
                # For multi-user chats, backfill before updating participants,
                # to act as as a best guess of when users actually joined.
                # No way to tell when a user actually left, so just check the
                # participants list after backfilling.
                await self.backfill(source)
                await self._update_participants(info.participants)
            else:
                puppet = await p.Puppet.get_by_custom_mxid(source.mxid)
                if puppet:
                    try:
                        await puppet.az.intent.join_room_by_id(self.mxid)
                    except MatrixError:
                        self.log.debug("Failed to join custom puppet into newly created portal",
                                       exc_info=True)
                await self.backfill(source)

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
        self.name = None
        self.icon_path = None
        self.icon_mxc = None
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
