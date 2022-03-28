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
from typing import Optional, ClassVar, TYPE_CHECKING

from attr import dataclass

from mautrix.types import UserID
from mautrix.util.async_db import Database

fake_db = Database("") if TYPE_CHECKING else None


@dataclass
class LoginCredential:
    db: ClassVar[Database] = fake_db

    mxid: UserID
    email: str
    password: str

    async def insert(self) -> None:
        q = ("INSERT INTO login_credential (mxid, email, password) "
             "VALUES ($1, $2, $3)")
        await self.db.execute(q, self.mxid, self.email, self.password)

    async def update(self) -> None:
        await self.db.execute("UPDATE login_credential SET email=$2, password=$3 WHERE mxid=$1",
                              self.mxid, self.email, self.password)

    @classmethod
    async def get_by_mxid(cls, mxid: UserID) -> Optional["LoginCredential"]:
        q = ("SELECT mxid, email, password "
             "FROM login_credential WHERE mxid=$1")
        row = await cls.db.fetchrow(q, mxid)
        if not row:
            return None
        return cls(**row)

    async def delete(self) -> None:
        await self.db.execute("DELETE FROM login_credential WHERE mxid=$1",
                              self.mxid)
