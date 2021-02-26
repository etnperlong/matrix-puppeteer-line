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
from asyncpg import Connection

from mautrix.util.async_db import UpgradeTable

upgrade_table = UpgradeTable()


@upgrade_table.register(description="Initial revision")
async def upgrade_v1(conn: Connection) -> None:
    await conn.execute("""CREATE TABLE portal (
        chat_id     INTEGER PRIMARY KEY,
        other_user  TEXT,
        mxid        TEXT,
        name        TEXT,
        encrypted   BOOLEAN NOT NULL DEFAULT false
    )""")
    await conn.execute("""CREATE TABLE "user" (
        mxid        TEXT PRIMARY KEY,
        notice_room TEXT
    )""")
    await conn.execute("""CREATE TABLE puppet (
        mid           TEXT PRIMARY KEY,
        name          TEXT,
        is_registered BOOLEAN NOT NULL DEFAULT false
    )""")
    await conn.execute("""CREATE TABLE message (
        mxid     TEXT NOT NULL,
        mx_room  TEXT NOT NULL,
        mid      INTEGER PRIMARY KEY,
        chat_id  INTEGER NOT NULL,

        UNIQUE (mxid, mx_room)
    )""")
