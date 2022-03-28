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
from typing import Optional, ClassVar, List, TYPE_CHECKING

from attr import dataclass

from mautrix.types import RoomID, ContentURI
from mautrix.util.async_db import Database

fake_db = Database("") if TYPE_CHECKING else None


@dataclass
class Portal:
    db: ClassVar[Database] = fake_db

    chat_id: str
    other_user: str # TODO Remove, as it's redundant: other_user == chat_id for direct chats
    mxid: Optional[RoomID]
    name: Optional[str]
    icon_path: Optional[str]
    icon_mxc: Optional[ContentURI]
    encrypted: bool

    async def insert(self) -> None:
        q = ("INSERT INTO portal (chat_id, other_user, mxid, name, icon_path, icon_mxc, encrypted) "
             "VALUES ($1, $2, $3, $4, $5, $6, $7)")
        await self.db.execute(q, self.chat_id, self.other_user, self.mxid, self.name,
                              self.icon_path, self.icon_mxc,
                              self.encrypted)

    async def update(self) -> None:
        q = ("UPDATE portal SET other_user=$2, mxid=$3, name=$4, "
             "                  icon_path=$5, icon_mxc=$6, encrypted=$7 "
             "WHERE chat_id=$1")
        await self.db.execute(q, self.chat_id, self.other_user, self.mxid, self.name,
                              self.icon_path, self.icon_mxc,
                              self.encrypted)

    async def delete(self) -> None:
        q = "DELETE FROM portal WHERE chat_id=$1"
        await self.db.execute(q, self.chat_id)

    @classmethod
    async def get_by_mxid(cls, mxid: RoomID) -> Optional['Portal']:
        q = ("SELECT chat_id, other_user, mxid, name, icon_path, icon_mxc, encrypted "
             "FROM portal WHERE mxid=$1")
        row = await cls.db.fetchrow(q, mxid)
        if not row:
            return None
        return cls(**row)

    @classmethod
    async def get_by_chat_id(cls, chat_id: str) -> Optional['Portal']:
        q = ("SELECT chat_id, other_user, mxid, name, icon_path, icon_mxc, encrypted "
             "FROM portal WHERE chat_id=$1")
        row = await cls.db.fetchrow(q, chat_id)
        if not row:
            return None
        return cls(**row)

    @classmethod
    async def find_private_chats(cls) -> List['Portal']:
        rows = await cls.db.fetch("SELECT chat_id, other_user, mxid, name, "
                                  "       icon_path, icon_mxc, encrypted "
                                  "FROM portal WHERE other_user IS NOT NULL")
        return [cls(**row) for row in rows]

    @classmethod
    async def all_with_room(cls) -> List['Portal']:
        rows = await cls.db.fetch("SELECT chat_id, other_user, mxid, name, "
                                  "       icon_path, icon_mxc, encrypted "
                                  "FROM portal WHERE mxid IS NOT NULL")
        return [cls(**row) for row in rows]
