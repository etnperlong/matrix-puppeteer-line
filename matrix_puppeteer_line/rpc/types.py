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
from typing import Optional, List

from attr import dataclass

from mautrix.types import SerializableAttrs


class RPCError(Exception):
    pass


@dataclass
class PathImage(SerializableAttrs['PathImage']):
    path: str
    url: str


@dataclass
class ChatListInfo(SerializableAttrs['ChatListInfo']):
    id: int
    name: str
    icon: Optional[PathImage]
    lastMsg: str
    lastMsgDate: str


@dataclass
class Participant(SerializableAttrs['Participant']):
    id: str
    avatar: Optional[PathImage]
    name: str


@dataclass
class ChatInfo(ChatListInfo, SerializableAttrs['ChatInfo']):
    participants: List[Participant]


@dataclass
class Message(SerializableAttrs['Message']):
    id: int
    chat_id: int
    is_outgoing: bool
    sender: Optional[Participant]
    timestamp: int = None
    text: Optional[str] = None
    image_url: Optional[str] = None


@dataclass
class ImageData:
    mime: str
    data: bytes


@dataclass
class StartStatus(SerializableAttrs['StartStatus']):
    started: bool
    is_logged_in: bool
    is_connected: bool
    is_permanently_disconnected: bool
