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
from typing import Optional, ClassVar, Dict, TYPE_CHECKING

from attr import dataclass

from mautrix.types import RoomID, EventID
from mautrix.util.async_db import Database

fake_db = Database("") if TYPE_CHECKING else None


@dataclass
class Message:
    db: ClassVar[Database] = fake_db

    mxid: EventID
    mx_room: RoomID
    mid: Optional[int]
    chat_id: str

    async def insert(self) -> None:
        q = "INSERT INTO message (mxid, mx_room, mid, chat_id) VALUES ($1, $2, $3, $4)"
        await self.db.execute(q, self.mxid, self.mx_room, self.mid, self.chat_id)

    async def update_ids(self, new_mxid: EventID, new_mid: int) -> None:
        q = ("UPDATE message SET mxid=$1, mid=$2 "
             "WHERE mxid=$3 AND mx_room=$4 AND chat_id=$5")
        await self.db.execute(q, new_mxid, new_mid,
                              self.mxid, self.mx_room, self.chat_id)

    @classmethod
    async def get_max_mid(cls, room_id: RoomID) -> int:
        return await cls.db.fetchval("SELECT MAX(mid) FROM message WHERE mx_room=$1", room_id)

    @classmethod
    async def get_max_mids(cls) -> Dict[str, int]:
        rows = await cls.db.fetch("SELECT chat_id, MAX(mid) AS max_mid "
                                  "FROM message GROUP BY chat_id")
        data = {}
        for row in rows:
            data[row["chat_id"]] = row["max_mid"]
        return data

    @classmethod
    async def get_num_noid_msgs(cls, room_id: RoomID) -> int:
        return await cls.db.fetchval("SELECT COUNT(*) FROM message "
                                     "WHERE mid IS NULL AND mx_room=$1", room_id)

    @classmethod
    async def is_last_by_mxid(cls, mxid: EventID, room_id: RoomID) -> bool:
        q = ("SELECT mxid "
             "FROM message INNER JOIN ( "
             "    SELECT mx_room, MAX(mid) AS max_mid "
             "    FROM message GROUP BY mx_room "
             ") by_room "
             "ON mid=max_mid "
             "WHERE by_room.mx_room=$1")
        last_mxid = await cls.db.fetchval(q, room_id)
        return last_mxid == mxid

    @classmethod
    async def get_by_mxid(cls, mxid: EventID, mx_room: RoomID) -> Optional['Message']:
        row = await cls.db.fetchrow("SELECT mxid, mx_room, mid, chat_id "
                                    "FROM message WHERE mxid=$1 AND mx_room=$2", mxid, mx_room)
        if not row:
            return None
        return cls(**row)

    @classmethod
    async def get_by_mid(cls, mid: int) -> Optional['Message']:
        row = await cls.db.fetchrow("SELECT mxid, mx_room, mid, chat_id FROM message WHERE mid=$1",
                                    mid)
        if not row:
            return None
        return cls(**row)

    @classmethod
    async def get_next_noid_msg(cls, room_id: RoomID) -> Optional['Message']:
        row = await cls.db.fetchrow("SELECT mxid, mx_room, mid, chat_id FROM message "
                                    "WHERE mid IS NULL AND mx_room=$1", room_id)
        if not row:
            return None
        return cls(**row)

    @classmethod
    async def delete_all_noid_msgs(cls, room_id: RoomID) -> None:
        status = await cls.db.execute("DELETE FROM message "
                                      "WHERE mid IS NULL AND mx_room=$1", room_id)
        # Skip leading "DELETE "
        return int(status[7:])
