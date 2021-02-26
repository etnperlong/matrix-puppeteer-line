# matrix-appservice-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
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
from typing import Optional, ClassVar, List, TYPE_CHECKING

from attr import dataclass

from mautrix.types import RoomID
from mautrix.util.async_db import Database

fake_db = Database("") if TYPE_CHECKING else None


@dataclass
class Portal:
    db: ClassVar[Database] = fake_db

    chat_id: str
    other_user: str
    mxid: Optional[RoomID]
    name: Optional[str]
    encrypted: bool

    async def insert(self) -> None:
        q = ("INSERT INTO portal (chat_id, other_user, mxid, name, encrypted) "
             "VALUES ($1, $2, $3, $4, $5)")
        await self.db.execute(q, self.chat_id, self.other_user, self.mxid, self.name,
                              self.encrypted)

    async def update(self) -> None:
        q = ("UPDATE portal SET other_user=$2, mxid=$3, name=$4, encrypted=$5 "
             "WHERE chat_id=$1")
        await self.db.execute(q, self.chat_id, self.other_user,
                              self.mxid, self.name, self.encrypted)

    @classmethod
    async def get_by_mxid(cls, mxid: RoomID) -> Optional['Portal']:
        q = ("SELECT chat_id, other_user, mxid, name, encrypted "
             "FROM portal WHERE mxid=$1")
        row = await cls.db.fetchrow(q, mxid)
        if not row:
            return None
        return cls(**row)

    @classmethod
    async def get_by_chat_id(cls, chat_id: int) -> Optional['Portal']:
        q = ("SELECT chat_id, other_user, mxid, name, encrypted "
             "FROM portal WHERE chat_id=$1")
        row = await cls.db.fetchrow(q, chat_id)
        if not row:
            return None
        return cls(**row)

    @classmethod
    async def find_private_chats(cls) -> List['Portal']:
        rows = await cls.db.fetch("SELECT chat_id, other_user, mxid, name, encrypted "
                                  "FROM portal WHERE other_user IS NOT NULL")
        return [cls(**row) for row in rows]

    @classmethod
    async def all_with_room(cls) -> List['Portal']:
        rows = await cls.db.fetch("SELECT chat_id, other_user, mxid, name, encrypted "
                                  "FROM portal WHERE mxid IS NOT NULL")
        return [cls(**row) for row in rows]
