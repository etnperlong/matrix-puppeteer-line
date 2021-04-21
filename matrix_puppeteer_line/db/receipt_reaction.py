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
from typing import Optional, ClassVar, TYPE_CHECKING, ClassVar

from attr import dataclass

from mautrix.types import RoomID, EventID
from mautrix.util.async_db import Database

fake_db = Database("") if TYPE_CHECKING else None


@dataclass
class ReceiptReaction:
    db: ClassVar[Database] = fake_db

    mxid: EventID
    mx_room: RoomID
    relates_to: EventID
    num_read: int

    async def insert(self) -> None:
        q = "INSERT INTO receipt_reaction (mxid, mx_room, relates_to, num_read) VALUES ($1, $2, $3, $4)"
        await self.db.execute(q, self.mxid, self.mx_room, self.relates_to, self.num_read)

    async def update(self) -> None:
        q = ("UPDATE receipt_reaction SET relates_to=$3, num_read=$4 "
             "WHERE mxid=$1 AND mx_room=$2")
        await self.db.execute(q, self.mxid, self.mx_room, self.relates_to, self.num_read)

    async def delete(self) -> None:
        q = "DELETE FROM receipt_reaction WHERE mxid=$1 AND mx_room=$2"
        await self.db.execute(q, self.mxid, self.mx_room)

    @classmethod
    async def delete_all(cls, room_id: RoomID) -> None:
        await cls.db.execute("DELETE FROM message WHERE mx_room=$1", room_id)

    @classmethod
    async def get_by_mxid(cls, mxid: EventID, mx_room: RoomID) -> Optional['ReceiptReaction']:
        row = await cls.db.fetchrow("SELECT mxid, mx_room, relates_to, num_read "
                                    "FROM receipt_reaction WHERE mxid=$1 AND mx_room=$2", mxid, mx_room)
        if not row:
            return None
        return cls(**row)

    @classmethod
    async def get_by_relation(cls, mxid: EventID, mx_room: RoomID) -> Optional['ReceiptReaction']:
        row = await cls.db.fetchrow("SELECT mxid, mx_room, relates_to, num_read "
                                    "FROM receipt_reaction WHERE relates_to=$1 AND mx_room=$2", mxid, mx_room)
        if not row:
            return None
        return cls(**row)
