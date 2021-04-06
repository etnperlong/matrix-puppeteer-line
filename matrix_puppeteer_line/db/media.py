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
class Media:
    db: ClassVar[Database] = fake_db

    media_id: str
    mxc: ContentURI
    # TODO Consider whether mime_type, file_name, and size are needed.

    async def insert(self) -> None:
        q = ("INSERT INTO media (media_id, mxc) "
             "VALUES ($1, $2)")
        await self.db.execute(q, self.media_id, self.mxc)

    async def update(self) -> None:
        q = ("UPDATE media SET mxc=$2 "
             "WHERE media_id=$1")
        await self.db.execute(q, self.media_id, self.mxc)

    @classmethod
    async def get_by_id(cls, media_id: str) -> Optional[ContentURI]:
        q = ("SELECT media_id, mxc "
             "FROM media WHERE media_id=$1")
        row = await cls.db.fetchrow(q, media_id)
        if not row:
            return None
        return cls(**row)
