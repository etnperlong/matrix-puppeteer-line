# matrix-puppeteer-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
# Copyright (C) 2020-2022 Tulir Asokan, Andrew Ferrazzutti
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
from mautrix.errors import IntentError
from mautrix.errors.request import MatrixRequestError
from mautrix.util.simple_lock import SimpleLock

from .db import Portal as DBPortal, Message as DBMessage, Receipt as DBReceipt, ReceiptReaction as DBReceiptReaction, Media as DBMedia
from .config import Config
from .rpc import ChatInfo, Participant, Message, Receipt, Client, PathImage
from .rpc.types import RPCError
from . import user as u, puppet as p

if TYPE_CHECKING:
    from .__main__ import MessagesBridge

try:
    from mautrix.crypto.attachments import encrypt_attachment, decrypt_attachment
except ImportError:
    encrypt_attachment = decrypt_attachment = None

StateBridge = EventType.find("m.bridge", EventType.Class.STATE)
StateHalfShotBridge = EventType.find("uk.half-shot.bridge", EventType.Class.STATE)
MediaInfo = NamedTuple('MediaInfo', mxc=Optional[ContentURI],
                       decryption_info=Optional[EncryptedFile],
                       mime_type=str, file_name=str, size=int)


class Portal(DBPortal, BasePortal):
    invite_own_puppet_to_pm: bool = False
    by_mxid: Dict[RoomID, 'Portal'] = {}
    by_chat_id: Dict[str, 'Portal'] = {}
    config: Config
    matrix: 'm.MatrixHandler'
    az: AppService

    _main_intent: Optional[IntentAPI]
    _create_room_lock: asyncio.Lock
    backfill_lock: SimpleLock
    _last_participant_update: Set[str]

    def __init__(self, chat_id: str, other_user: Optional[str] = None,
                 mxid: Optional[RoomID] = None, name: Optional[str] = None,
                 icon_path: Optional[str] = None, icon_mxc: Optional[ContentURI] = None,
                 encrypted: bool = False) -> None:
        super().__init__(chat_id, other_user, mxid, name, icon_path, icon_mxc, encrypted)
        self._create_room_lock = asyncio.Lock()
        self.log = self.log.getChild(str(chat_id))

        self.backfill_lock = SimpleLock("Waiting for backfilling to finish before handling %s",
                                        log=self.log)
        self._main_intent = None
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
    def needs_bridgebot(self) -> bool:
        # TODO Ask Tulir why e2b needs the bridgebot to be in the room
        # Reminder that the bridgebot's intent is used for non-DM rooms
        return not self.is_direct or (self.encrypted and self.matrix.e2ee)

    @property
    def needs_portal_meta(self) -> bool:
        return self.encrypted or not self.is_direct or self.config["bridge.private_chat_portal_meta"]

    @property
    def main_intent(self) -> IntentAPI:
        if not self._main_intent:
            raise ValueError("Portal must be postinit()ed before main_intent can be used")
        return self._main_intent

    @classmethod
    def init_cls(cls, bridge: 'MessagesBridge') -> None:
        BasePortal.bridge = bridge
        cls.config = bridge.config
        cls.matrix = bridge.matrix
        cls.az = bridge.az
        cls.loop = bridge.loop
        cls.bridge = bridge
        cls.invite_own_puppet_to_pm = cls.config["bridge.invite_own_puppet_to_pm"]
        cls.emoji_scale_factor = max(int(cls.config["bridge.emoji_scale_factor"]), 1)
        NotificationDisabler.puppet_cls = p.Puppet
        NotificationDisabler.config_enabled = cls.config["bridge.backfill.disable_notifications"]

    async def _send_delivery_receipt(self, event_id: EventID) -> None:
        # TODO Also send receipt from own puppet, if it's in the room
        if event_id and self.config["bridge.delivery_receipts"]:
            try:
                await self.az.intent.mark_read(self.mxid, event_id)
            except Exception:
                self.log.exception("Failed to send delivery receipt for %s", event_id)

    async def _cleanup_noid_msgs(self) -> None:
        num_noid_msgs = await DBMessage.delete_all_noid_msgs(self.mxid)
        if num_noid_msgs > 0:
            self.log.warn(f"Found {num_noid_msgs} messages in chat {self.chat_id} with no ID that could not be matched with a real ID")

    async def handle_matrix_message(self, sender: 'u.User', message: MessageEventContent,
                                    event_id: EventID) -> None:
        if not await sender.is_logged_in():
            self.log.debug(f"Ignoring message {event_id} as sender {sender.mxid} is not connected")
            return
        elif ((message.get(self.bridge.real_user_content_key,
                           False) and await p.Puppet.get_by_custom_mxid(sender.mxid))):
            self.log.debug(f"Ignoring puppet-sent message by confirmed puppet user {sender.mxid}")
            await self._send_delivery_receipt(event_id)
            return
        # TODO deduplication of outgoing messages
        text = message.body
        if message.msgtype.is_text:
            if message.msgtype == MessageType.EMOTE:
                text = f"/me {text}"
            try:
                message_id = await sender.client.send(self.chat_id, text)
            except RPCError as e:
                self.log.warning(f"Failed to send message {event_id} to chat {self.chat_id}: {e}")
                message_id = -1
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
            try:
                message_id = await sender.client.send_file(self.chat_id, file_path)
            except RPCError as e:
                self.log.warning(f"Failed to upload media {event_id} to chat {self.chat_id}: {e}")
                message_id = -1
            remove(file_path)

        await self._cleanup_noid_msgs()
        msg = None
        if message_id != -1:
            try:
                msg = DBMessage(mxid=event_id, mx_room=self.mxid, mid=message_id, chat_id=self.chat_id, is_outgoing=True)
                await msg.insert()
                await self._send_delivery_receipt(event_id)
                self.log.debug(f"Handled Matrix message {event_id} -> {message_id}")
            except UniqueViolationError as e:
                self.log.warning(f"Failed to handle Matrix message {event_id} -> {message_id}: {e}")
        if not msg and self.config["bridge.delivery_error_reports"]:
            await self.main_intent.send_notice(
                self.mxid,
                "Posting this message to LINE may have failed.",
                relates_to=RelatesTo(rel_type=RelationType.REPLY, event_id=event_id))

    async def handle_matrix_leave(self, user: 'u.User') -> None:
        self.log.info(f"{user.mxid} left portal to {self.chat_id}, "
                      f"cleaning up and deleting...")
        if await user.is_logged_in():
            await user.client.forget_chat(self.chat_id)
        await self.cleanup_and_delete()

    async def _bridge_own_message_pm(self, source: 'u.User', puppet: Optional['p.Puppet'], mid: str,
                                     invite: bool = True) -> Optional[IntentAPI]:
        intent = puppet.intent if puppet else (await source.get_own_puppet()).intent
        if self.is_direct and (not puppet or puppet.mid == source.mid and not puppet.is_real_user):
            if self.invite_own_puppet_to_pm and invite:
                try:
                    await intent.ensure_joined(self.mxid)
                except IntentError as e:
                    if self.main_intent != self.az.intent:
                        await self.main_intent.invite_user(self.mxid, intent.mxid)
                        await intent.ensure_joined(self.mxid)
                    else:
                        self.log.warning(f"Unable to invite own puppet to {self.mxid}: {e}")
                        intent = None
            elif await self.az.state_store.get_membership(self.mxid,
                                                          intent.mxid) != Membership.JOIN:
                self.log.warning(f"Ignoring own {mid} in private chat because own puppet is not in"
                                 " room.")
                intent = None
        return intent

    async def handle_remote_message(self, source: 'u.User', evt: Message, handle_receipt: bool = True) -> None:
        if await DBMessage.get_by_mid(evt.id):
            self.log.debug(f"Ignoring duplicate message {evt.id}")
            return

        if evt.is_outgoing:
            if source.intent:
                intent = source.intent
            else:
                if not self.invite_own_puppet_to_pm:
                    self.log.warning(f"Ignoring message {evt.id}: double puppeting isn't enabled")
                    return
                puppet = await p.Puppet.get_by_mid(evt.sender.id) if evt.sender else None
                intent = await self._bridge_own_message_pm(source, puppet, f"message {evt.id}")
                if not intent:
                    return
        else:
            if self.is_direct:
                # TODO Respond to name/avatar changes of users in a DM
                intent = (await p.Puppet.get_by_mid(self.other_user)).intent
            elif evt.sender:
                puppet = await p.Puppet.get_by_mid(evt.sender.id)
                if puppet:
                    await puppet.update_info(evt.sender, source.client)
                else:
                    self.log.warning(f"Could not find ID of LINE user who sent message {evt.id or 'with no ID'}")
                    puppet = await p.Puppet.get_by_profile(evt.sender, source.client)
                intent = puppet.intent
            else:
                self.log.info(f"Using bridgebot for unknown sender of message {evt.id or 'with no ID'}")
                intent = self.az.intent
            if not evt.member_info:
                await intent.ensure_joined(self.mxid)

        if evt.id:
            msg = await DBMessage.get_next_noid_msg(self.mxid)
            if not msg:
                self.log.info(f"Handling new message {evt.id} in chat {self.mxid}")
                prev_event_id = None
            elif not msg.mxid:
                self.log.error(f"Preseen message {evt.id} in chat {self.mxid} has no mxid")
                return
            else:
                self.log.info(f"Handling preseen message {evt.id} in chat {self.mxid}: {msg.mxid}")
                if not self.is_direct:
                    # Non-DM previews are always sent by bridgebot.
                    # Must delete the bridgebot message and send a new message from the correct puppet.
                    await self.az.intent.redact(self.mxid, msg.mxid, "Found actual sender")
                    prev_event_id = None
                else:
                    prev_event_id = msg.mxid
        else:
            self.log.info(f"Handling new message with no ID in chat {self.mxid}")
            msg = None
            prev_event_id = None

        if prev_event_id and evt.html:
            # No need to update a previewed text message, as their previews are accurate
            event_id = prev_event_id
        elif evt.image and evt.image.url:
            if not evt.image.is_sticker or self.config["bridge.receive_stickers"]:
                media_info = await self._handle_remote_media(
                    source, intent, evt.image.url,
                    deduplicate=not self.encrypted and evt.image.is_sticker)
                image_info = ImageInfo(
                    # Element Web doesn't animate PNGs, but setting the mimetype to GIF works.
                    # (PNG stickers never animate, and PNG images only animate after being clicked on.)
                    # Making this exception since E.W. seems to be the only client that supports inline animated stickers & images.
                    # TODO Open an E.W. issue for this
                    # TODO Test Element Android
                    # TODO Find & test other non-GIF formats for animated images
                    mimetype="image/gif" if evt.image.is_animated and media_info.mime_type == "image/png" else media_info.mime_type,
                    size=media_info.size) if media_info else None
            else:
                media_info = None
            send_sticker = self.config["bridge.use_sticker_events"] and evt.image.is_sticker and not self.encrypted and media_info
            # TODO Element Web messes up text->sticker edits!!
            #      File a case on it
            if send_sticker and not prev_event_id:
                #relates_to = RelatesTo(rel_type=RelationType.REPLACE, event_id=prev_event_id) if prev_event_id else None
                event_id = await intent.send_sticker(self.mxid, media_info.mxc, image_info, "<sticker>", timestamp=evt.timestamp)
            else:
                if media_info:
                    content = MediaMessageEventContent(
                        url=media_info.mxc, file=media_info.decryption_info,
                        msgtype=MessageType.IMAGE,
                        body=media_info.file_name,
                        info=image_info)
                else:
                    content = TextMessageEventContent(
                        msgtype=MessageType.NOTICE,
                        body=f"<{'sticker' if evt.image.is_sticker else 'image'}>")
                if prev_event_id:
                    content.set_edit(prev_event_id)
                event_id = await self._send_message(intent, content, timestamp=evt.timestamp)
        elif evt.html and not evt.html.isspace():

            chunks = []

            def handle_data(data):
                nonlocal chunks
                chunks.append({"type": "data", "data": data})

            def handle_starttag(tag, attrs):
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
                if ctype == "br":
                    msg_text += "\n"
                    if not msg_html:
                        msg_html = msg_text
                    msg_html += "<br>"
                elif ctype == "data":
                    msg_text += chunk["data"]
                    if msg_html:
                        msg_html += chunk["data"]
                elif ctype == "img":
                    height = int(chunk.get("height", 19)) * self.emoji_scale_factor
                    cclass = chunk["class"]
                    if cclass == "emojione":
                        alt = chunk["alt"]
                        media_id = None
                    else:
                        alt = "".join(filter(lambda char: char.isprintable(), chunk["alt"])).strip()
                        alt = f':{alt if alt else "n/a"}:'
                        media_id = f'{chunk.get("data-stickon-pkg-cd", 0)}/{chunk.get("data-stickon-stk-cd", 0)}'

                    # NOTE Not encrypting content linked to by HTML tags
                    if not self.encrypted and self.config["bridge.receive_stickers"]:
                        media_info = await self._handle_remote_media(source, intent, chunk["src"], media_id, deduplicate=True)
                        if not msg_html:
                            msg_html = msg_text
                        msg_html += f'<img data-mx-emoticon src="{media_info.mxc}" alt="{alt}" title="{alt}" height="{height}">'
                    msg_text += alt

            content = TextMessageEventContent(
                msgtype=MessageType.TEXT,
                format=Format.HTML if msg_html else None,
                body=msg_text, formatted_body=msg_html)
            event_id = await self._send_message(intent, content, timestamp=evt.timestamp)
        elif evt.member_info:
            # TODO Track invites. Both LINE->LINE and Matrix->LINE
            # TODO Make use of evt.timestamp, but how?
            if evt.member_info.joined:
                await intent.ensure_joined(self.mxid)
            elif evt.member_info.left:
                try:
                    await intent.leave_room(self.mxid)
                except MatrixRequestError as e:
                    self.log.warn(f"Puppet for user {evt.sender.id} already left portal {self.mxid}")
            event_id = None
        else:
            content = TextMessageEventContent(
                msgtype=MessageType.NOTICE,
                body="<Unbridgeable message>")
            if prev_event_id:
                content.set_edit(prev_event_id)
            event_id = await self._send_message(intent, content, timestamp=evt.timestamp)

        if not msg:
            msg = DBMessage(mxid=event_id, mx_room=self.mxid, mid=evt.id, chat_id=self.chat_id, is_outgoing=evt.is_outgoing)
            try:
                await msg.insert()
                self.log.debug(f"Handled remote message {evt.id or 'with no ID'} -> {event_id or 'with no mxid'}")
            except UniqueViolationError as e:
                self.log.debug(f"Failed to handle remote message {evt.id or 'with no ID'} -> {event_id or 'with no mxid'}: {e}")
        else:
            await msg.update_ids(new_mxid=event_id, new_mid=evt.id)
            self.log.debug(f"Handled preseen remote message {evt.id} -> {event_id}")

        if handle_receipt and evt.is_outgoing and evt.receipt_count:
            await self._handle_receipt(event_id, evt.id, evt.receipt_count)

    async def handle_remote_receipt(self, receipt: Receipt) -> None:
        msg = await DBMessage.get_by_mid(receipt.id)
        if msg:
            await self._handle_receipt(msg.mxid, receipt.id, receipt.count)
        else:
            self.log.debug(f"Could not find message for read receipt {receipt.id}")

    async def _handle_receipt(self, event_id: EventID, receipt_id: int, receipt_count: int) -> None:
        if self.is_direct:
            await self.main_intent.send_receipt(self.mxid, event_id)
        else:
            # Update receipts not only for this message, but also for
            # all messages before it with an equivalent "read by" count.
            prev_receipt_id = await DBReceipt.get_max_mid(self.chat_id, receipt_count) or 0
            messages = await DBMessage.get_all_since(self.chat_id, prev_receipt_id, receipt_id)

            # Remove reactions for outdated "read by" counts.
            for message in messages:
                reaction = await DBReceiptReaction.get_by_relation(message.mxid, self.mxid)
                if reaction:
                    await self.main_intent.redact(self.mxid, reaction.mxid)
                    await reaction.delete()

            # If there are as many receipts as there are chat participants, then everyone
            # must have read the message, so send real read receipts from each puppet.
            # TODO Not just -1 if there are multiple _OWN_ puppets...
            is_fully_read = receipt_count >= len(self._last_participant_update) - 1
            if is_fully_read:
                for mid in filter(lambda mid: not p.Puppet.is_mid_for_own_puppet(mid), self._last_participant_update):
                    intent = (await p.Puppet.get_by_mid(mid)).intent
                    await intent.send_receipt(self.mxid, event_id)
            else:
                # TODO messages list should exclude non-outgoing messages,
                #     but include them just to get rid of potential stale reactions
                for message in (msg for msg in messages if msg.is_outgoing):
                    # TODO Translatable string for "Read by"
                    try:
                        reaction_mxid = await self.main_intent.react(self.mxid, message.mxid, f"(Read by {receipt_count})")
                        await DBReceiptReaction(reaction_mxid, self.mxid, message.mxid, receipt_count).insert()
                    except Exception as e:
                        self.log.warning(f"Failed to send read receipt reaction for message {message.mxid} in {self.chat_id}: {e}")

        try:
            await DBReceipt(mid=receipt_id, chat_id=self.chat_id, num_read=receipt_count).insert_or_update()
            self.log.debug(f"Handled read receipt for message {receipt_id} read by {receipt_count}")
        except Exception as e:
            self.log.debug(f"Failed to handle read receipt for message {receipt_id} read by {receipt_count}: {e}")

    async def _handle_remote_media(self, source: 'u.User', intent: IntentAPI,
                                        media_url: str, media_id: Optional[str] = None,
                                        deduplicate: bool = False) -> MediaInfo:
        if not media_id:
            media_id = media_url
        db_media_info = await DBMedia.get_by_id(media_id) if deduplicate else None
        if not db_media_info:
            # NOTE Blob URL of stickers only persists for a single session...still better than nothing.
            self.log.debug(f"{'Did not find existing mxc URL for' if deduplicate else 'Not deduplicating'} {media_id}, uploading media now")
            try:
                resp = await source.client.read_image(media_url)
            except (RPCError, TypeError) as e:
                self.log.warning(f"Failed to download remote media from chat {self.chat_id}: {e}")
                return None
            media_info = await self._reupload_remote_media(resp.data, intent, resp.mime, disable_encryption=deduplicate)
            if deduplicate:
                await DBMedia(
                    media_id=media_id, mxc=media_info.mxc,
                    size=media_info.size, mime_type=media_info.mime_type, file_name=media_info.file_name
                    ).insert()
            return media_info
        else:
            self.log.debug(f"Found existing mxc URL for {media_id}: {db_media_info.mxc}")
            return MediaInfo(db_media_info.mxc, None, db_media_info.mime_type, db_media_info.file_name, db_media_info.size)

    async def _reupload_remote_media(self, data: bytes, intent: IntentAPI,
                                     mime_type: str = None, file_name: str = None,
                                     disable_encryption: bool = True) -> MediaInfo:
        if not mime_type:
            mime_type = magic.from_buffer(data, mime=True)
        upload_mime_type = mime_type
        if not file_name:
            file_name = f"image{mimetypes.guess_extension(mime_type)}"
        upload_file_name = file_name

        decryption_info = None
        if self.encrypted and encrypt_attachment and not disable_encryption:
            data, decryption_info = encrypt_attachment(data)
            upload_mime_type = "application/octet-stream"
            upload_file_name = None

        mxc = await intent.upload_media(data, mime_type=upload_mime_type,
                                        filename=upload_file_name)

        if decryption_info:
            self.log.debug(f"Uploaded encrypted media as {mxc}")
            decryption_info.url = mxc
            mxc = None
        else:
            self.log.debug(f"Uploaded media as {mxc}")

        return MediaInfo(mxc, decryption_info, mime_type, file_name, len(data))

    async def update_info(self, conv: ChatInfo, client: Optional[Client]) -> None:
        for participant in conv.participants:
            # REMINDER: multi-user chats include your own LINE user in the participant list
            if participant.id != None:
                puppet = await p.Puppet.get_by_mid(participant.id, client)
                await puppet.update_info(participant, client)
            else:
                self.log.warning(f"Could not find ID of LINE user {participant.name}")
                puppet = await p.Puppet.get_by_profile(participant, client)

        if self.needs_portal_meta:
            changed = await self._update_name(f"{conv.name} (LINE)")
            path_image = conv.icon if not self.is_direct else participant.avatar
            changed = await self._update_icon(path_image, client) or changed
        else:
            changed = await self._update_name(None)
            changed = await self._update_icon(None, client) or changed
        if changed:
            await self.update_bridge_info()
            await self.update()
        # NOTE Don't call this yet, lest puppets join earlier than
        #      when their user actually joined or sent a message.
        #await self._update_participants(conv.participants)

    async def _update_name(self, name: Optional[str]) -> bool:
        if self.name != name:
            self.name = name
            if self.mxid:
                await self.main_intent.set_room_name(self.mxid, name)
            return True
        return False

    async def _update_icon(self, icon: Optional[PathImage], client: Optional[Client]) -> bool:
        if icon:
            if icon.url and not icon.path:
                self.log.warn(f"Using URL as path for room icon of {self.name or self.chat_id}")
                icon_path = icon_url = icon.url
            else:
                icon_path = icon.path
                icon_url = icon.url
        else:
            icon_path = icon_url = None

        if icon_path != self.icon_path:
            self.log.info(f"Updating room icon of {self.name or self.chat_id}")
            self.icon_path = icon_path
            if icon_url:
                if not client:
                    self.log.error(f"Cannot update room icon: no connection to LINE")
                    return
                resp = await client.read_image(icon.url)
                self.icon_mxc = await self.main_intent.upload_media(resp.data, mime_type=resp.mime)
            else:
                self.icon_mxc = ContentURI("")
            if self.mxid:
                try:
                    await self.main_intent.set_room_avatar(self.mxid, self.icon_mxc)
                except Exception as e:
                    self.log.exception(f"Failed to set room icon: {e}")
            return True
        else:
            self.log.debug(f"No need to update room icon of {self.name or self.chat_id}, new icon has same path as old one")
            return False

    async def _update_participants(self, participants: List[Participant]) -> None:
        if not self.mxid:
            return

        # Store the current member list to prevent unnecessary updates
        current_members = set()
        for participant in participants:
            current_members.add(
                participant.id if participant.id != None else \
                (await p.Puppet.get_by_profile(participant)).mid)

        if current_members == self._last_participant_update:
            self.log.trace("Not updating participants: list matches cached list")
            return
        self._last_participant_update = current_members

        # TODO When supporting multiple bridge users, do this per user
        forbid_own_puppets = \
            not self.invite_own_puppet_to_pm or \
            (await u.User.get_by_mxid(self.config["bridge.user"], False)).intent is not None

        # Make sure puppets who should be here are here
        for participant in participants:
            if forbid_own_puppets and p.Puppet.is_mid_for_own_puppet(participant.id):
                continue
            intent = (await p.Puppet.get_by_sender(participant)).intent
            await intent.ensure_joined(self.mxid)

        print(current_members)

        # Puppets who shouldn't be here should leave
        for user_id in await self.main_intent.get_room_members(self.mxid):
            if user_id == self.az.bot_mxid:
                if forbid_own_puppets and not self.needs_bridgebot:
                    await self.az.intent.leave_room(self.mxid)
                continue

            mid = p.Puppet.get_id_from_mxid(user_id)
            is_own_puppet = p.Puppet.is_mid_for_own_puppet(mid)
            if mid and mid not in current_members and not is_own_puppet \
                or forbid_own_puppets and is_own_puppet:
                print(mid)
                puppet = await p.Puppet.get_by_mxid(user_id)
                await puppet.intent.leave_room(self.mxid)

    async def backfill(self, source: 'u.User', info: ChatInfo) -> None:
        try:
            with self.backfill_lock:
                await self._backfill(source, info)
        except Exception:
            self.log.exception("Failed to backfill portal")

    async def _backfill(self, source: 'u.User', info: ChatInfo) -> None:
        self.log.debug("Backfilling history through %s", source.mxid)

        events = await source.client.get_messages(self.chat_id)

        max_mid = await DBMessage.get_max_mid(self.mxid) or 0
        messages = [msg for msg in events.messages
                    if msg.id > max_mid]

        if not messages:
            self.log.debug("Didn't get any messages from server")
        else:
            self.log.debug("Got %d messages from server", len(messages))
            async with NotificationDisabler(self.mxid, source):
                for evt in messages:
                    await self.handle_remote_message(source, evt, handle_receipt=self.is_direct)
            self.log.info("Backfilled %d messages through %s", len(messages), source.mxid)
            await self._cleanup_noid_msgs()


        # Need to update participants even for DMs, to kick own puppet if needed
        await self._update_participants(info.participants)

        if not self.is_direct:
            # Update participants before sending any receipts
            # TODO Joins and leaves are (usually) shown after all, so track them properly.
            #      In the meantime, just check the participants list after backfilling.
            for evt in messages:
                if evt.is_outgoing and evt.receipt_count:
                    await self.handle_remote_message(source, evt, handle_receipt=False)


        max_mid_per_num_read = await DBReceipt.get_max_mid_per_num_read(self.chat_id)
        receipts = [rct for rct in events.receipts
                    if rct.id > max_mid_per_num_read.get(rct.count, 0)]

        if not receipts:
            self.log.debug("Didn't get any receipts from server")
        else:
            self.log.debug("Got %d receipts from server", len(receipts))
            for rct in receipts:
                await self.handle_remote_receipt(rct)
            self.log.info("Backfilled %d receipts through %s", len(receipts), source.mxid)

    @property
    def bridge_info_state_key(self) -> str:
        return f"net.miscworks.line://line/{self.chat_id}"

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
        await self.update_info(info, source.client)

        await self.main_intent.invite_user(self.mxid, source.mxid, check_cache=True)
        puppet = await p.Puppet.get_by_custom_mxid(source.mxid)
        if puppet and puppet.intent:
            await puppet.intent.ensure_joined(self.mxid)

        await self.backfill(source, info)

    async def _create_matrix_room(self, source: 'u.User', info: ChatInfo) -> Optional[RoomID]:
        if self.mxid:
            await self._update_matrix_room(source, info)
            return self.mxid

        self.log.debug("Creating Matrix room")
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
                    source.mxid: 25,
                },
                "events": {
                    str(EventType.REACTION): 100,
                    str(EventType.ROOM_ENCRYPTION): 25,
                }
            }
        })

        await self.update_info(info, source.client)
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
            self.mxid = await self.main_intent.create_room(name=self.name, is_direct=self.is_direct,
                                                           initial_state=initial_state,
                                                           invitees=invites)
            if not self.mxid:
                raise Exception("Failed to create room: no mxid returned")

            if self.needs_bridgebot:
                try:
                    await self.az.intent.ensure_joined(self.mxid)
                except Exception:
                    self.log.warning("Failed to add bridge bot "
                                     f"to new private chat {self.mxid}")

            await self.update()
            self.log.debug(f"Matrix room created: {self.mxid}")
            self.by_mxid[self.mxid] = self
            await self.backfill(source, info)

        return self.mxid

    async def postinit(self) -> None:
        self.by_chat_id[self.chat_id] = self
        if self.mxid:
            self.by_mxid[self.mxid] = self
        if self.is_direct:
            self.other_user = self.chat_id
            self._main_intent = (await p.Puppet.get_by_mid(self.other_user)).intent
        else:
            self._main_intent = self.az.intent

    async def delete(self) -> None:
        self.by_chat_id.pop(self.chat_id, None)
        self.by_mxid.pop(self.mxid, None)
        await super().delete()

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
    async def get_by_chat_id(cls, chat_id: str, create: bool = False) -> Optional['Portal']:
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
