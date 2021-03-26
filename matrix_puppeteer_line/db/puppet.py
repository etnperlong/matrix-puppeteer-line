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
from typing import Optional, ClassVar, TYPE_CHECKING

from attr import dataclass

from mautrix.types import ContentURI
from mautrix.util.async_db import Database

fake_db = Database("") if TYPE_CHECKING else None


@dataclass
class Puppet:
    db: ClassVar[Database] = fake_db

    mid: str
    name: Optional[str]
    avatar_path: Optional[str]
    avatar_mxc: Optional[ContentURI]
    name_set: bool
    avatar_set: bool
    is_registered: bool

    async def insert(self) -> None:
        q = ("INSERT INTO puppet (mid, name, "
             "                   avatar_path, avatar_mxc, name_set, avatar_set, "
             "                   is_registered) "
             "VALUES ($1, $2, $3, $4, $5, $6, $7)")
        await self.db.execute(q, self.mid, self.name,
                              self.avatar_path, self.avatar_mxc, self.name_set, self.avatar_set,
                              self.is_registered)

    async def update(self) -> None:
        q = ("UPDATE puppet SET name=$2, "
             "                  avatar_path=$3, avatar_mxc=$4, name_set=$5, avatar_set=$6, "
             "                  is_registered=$7 "
             "WHERE mid=$1")
        await self.db.execute(q, self.mid, self.name,
                              self.avatar_path, self.avatar_mxc, self.name_set, self.avatar_set,
                              self.is_registered)

    @classmethod
    async def get_by_mid(cls, mid: str) -> Optional['Puppet']:
        q = ("SELECT mid, name, avatar_path, avatar_mxc, name_set, avatar_set, is_registered "
             "FROM puppet WHERE mid=$1")
        row = await cls.db.fetchrow(q, mid)
        if not row:
            return None
        return cls(**row)
