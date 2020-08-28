# mautrix-amp - A very hacky Matrix-SMS bridge based on using Android Messages for Web in Puppeteer
# Copyright (C) 2020 Tulir Asokan
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
from typing import Optional, ClassVar, TYPE_CHECKING

from attr import dataclass

from mautrix.types import UserID, RoomID
from mautrix.util.async_db import Database

fake_db = Database("") if TYPE_CHECKING else None


@dataclass
class User:
    db: ClassVar[Database] = fake_db

    mxid: UserID
    notice_room: Optional[RoomID]

    async def insert(self) -> None:
        q = ('INSERT INTO "user" (mxid, notice_room) '
             'VALUES ($1, $2)')
        await self.db.execute(q, self.mxid, self.notice_room)

    async def update(self) -> None:
        await self.db.execute('UPDATE "user" SET notice_room=$2 WHERE mxid=$1',
                              self.mxid, self.notice_room)

    @classmethod
    async def get_by_mxid(cls, mxid: UserID) -> Optional['User']:
        q = ("SELECT mxid, notice_room "
             'FROM "user" WHERE mxid=$1')
        row = await cls.db.fetchrow(q, mxid)
        if not row:
            return None
        return cls(**row)
