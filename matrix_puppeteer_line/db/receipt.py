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
from typing import List, ClassVar, Dict, Optional, TYPE_CHECKING

from attr import dataclass

from mautrix.util.async_db import Database

fake_db = Database("") if TYPE_CHECKING else None


@dataclass
class Receipt:
    db: ClassVar[Database] = fake_db

    mid: int
    chat_id: str
    num_read: int

    async def insert_or_update(self) -> None:
        q = ("INSERT INTO receipt (mid, chat_id, num_read) "
             "VALUES ($1, $2, $3) "
             "ON CONFLICT (chat_id, num_read) "
             "DO UPDATE SET mid=EXCLUDED.mid, num_read=EXCLUDED.num_read")
        await self.db.execute(q, self.mid, self.chat_id, self.num_read)

        # Delete lower counts for earlier messages
        # TODO Consider using a CHECK for this instead
        q = ("DELETE FROM receipt "
             "WHERE chat_id=$1 AND mid<$2 AND num_read<$3")
        await self.db.execute(q, self.chat_id, self.mid, self.num_read)

    @classmethod
    async def get_max_mid(cls, chat_id: str, num_read: int) -> Optional[int]:
        q = ("SELECT mid FROM receipt "
             "WHERE chat_id=$1 AND num_read=$2")
        return await cls.db.fetchval(q, chat_id, num_read)

    @classmethod
    async def get_max_mid_per_num_read(cls, chat_id: str) -> Dict[int, int]:
        rows = await cls.db.fetch("SELECT chat_id, mid, num_read FROM receipt WHERE chat_id=$1", chat_id)
        data = {}
        for row in rows:
            data[row["num_read"]] = row["mid"]
        return data

    @classmethod
    async def get_max_mids_per_num_read(cls) -> Dict[str, Dict[int, int]]:
        rows = await cls.db.fetch("SELECT chat_id, mid, num_read FROM receipt")
        data = {}
        for row in rows:
            chat_id = row["chat_id"]
            if chat_id not in data:
                inner_data = {}
                data[chat_id] = inner_data
            else:
                inner_data = data[chat_id]
            inner_data[row["num_read"]] = row["mid"]
        return data
