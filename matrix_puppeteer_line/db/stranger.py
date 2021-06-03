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
from random import randint, seed

from mautrix.util.async_db import Database

fake_db = Database("") if TYPE_CHECKING else None


@dataclass
class Stranger:
    db: ClassVar[Database] = fake_db

    # Optional properties are ones that should be set by Puppet
    fake_mid: str
    name: Optional[str] = None
    avatar_path: Optional[str] = None
    available: bool = False

    async def insert(self) -> None:
        q = ("INSERT INTO stranger (fake_mid, name, avatar_path, available) "
             "VALUES ($1, $2, $3, $4)")
        await self.db.execute(q, self.fake_mid, self.name, self.avatar_path, self.available)

    async def update_profile_info(self) -> None:
        q = ("UPDATE stranger SET name=$2, avatar_path=$3 "
             "WHERE fake_mid=$1")
        await self.db.execute(q, self.fake_mid, self.name, self.avatar_path)

    async def make_available(self) -> None:
        q = ("UPDATE stranger SET available=true "
             "WHERE name=$1 AND avatar_path=$2")
        await self.db.execute(q, self.name, self.avatar_path)

    @classmethod
    async def get_by_mid(cls, mid: str) -> Optional['Stranger']:
        q = ("SELECT fake_mid, name, avatar_path, available "
             "FROM stranger WHERE fake_mid=$1")
        row = await cls.db.fetchrow(q, mid)
        if not row:
            return None
        return cls(**row)

    @classmethod
    async def get_by_profile(cls, info: 'Participant') -> Optional['Stranger']:
        q = ("SELECT fake_mid, name, avatar_path, available "
             "FROM stranger WHERE name=$1 AND avatar_path=$2")
        row = await cls.db.fetchrow(q, info.name, info.avatar.path if info.avatar else "")
        if not row:
            return None
        return cls(**row)

    @classmethod
    async def get_any_available(cls) -> Optional['Stranger']:
        q = ("SELECT fake_mid, name, avatar_path, available "
             "FROM stranger WHERE available=true")
        row = await cls.db.fetchrow(q)
        if not row:
            return None
        return cls(**row)

    @classmethod
    async def init_available_or_new(cls) -> 'Stranger':
        stranger = await cls.get_any_available()
        if not stranger:
            while True:
                fake_mid = "_STRANGER_"
                for _ in range(32):
                    fake_mid += f"{randint(0,15):x}"
                if await cls.get_by_mid(fake_mid) != None:
                    # Extremely unlikely event of a randomly-generated ID colliding with another.
                    # If it happens, must be not that unlikely after all, so pick a new seed.
                    seed()
                else:
                    stranger = cls(fake_mid)
                    break
        return stranger