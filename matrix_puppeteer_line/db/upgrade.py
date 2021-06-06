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
from asyncpg import Connection

from mautrix.util.async_db import UpgradeTable

upgrade_table = UpgradeTable()


@upgrade_table.register(description="Initial revision")
async def upgrade_v1(conn: Connection) -> None:
    await conn.execute("""CREATE TABLE portal (
        chat_id     TEXT PRIMARY KEY,
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
        chat_id  TEXT NOT NULL,

        UNIQUE (mxid, mx_room)
    )""")


@upgrade_table.register(description="Avatars and icons")
async def upgrade_avatars(conn: Connection) -> None:
    await conn.execute("""ALTER TABLE puppet
       ADD COLUMN IF NOT EXISTS avatar_path TEXT,
       ADD COLUMN IF NOT EXISTS avatar_mxc TEXT,
       ADD COLUMN IF NOT EXISTS name_set BOOLEAN,
       ADD COLUMN IF NOT EXISTS avatar_set BOOLEAN
   """)
    await conn.execute("""ALTER TABLE portal
       ADD COLUMN IF NOT EXISTS icon_path TEXT,
       ADD COLUMN IF NOT EXISTS icon_mxc TEXT
   """)


@upgrade_table.register(description="Deduplicated media")
async def upgrade_media(conn: Connection) -> None:
    await conn.execute("""CREATE TABLE IF NOT EXISTS media (
        media_id   TEXT PRIMARY KEY,
        mxc        TEXT NOT NULL
    )""")


@upgrade_table.register(description="Helpful table constraints")
async def upgrade_table_constraints(conn: Connection) -> None:
    constraint_name = "portal_mxid_key"
    q = ( "SELECT EXISTS(SELECT FROM information_schema.constraint_table_usage "
         f"WHERE table_name='portal' AND constraint_name='{constraint_name}')")
    has_unique_mxid = await conn.fetchval(q)
    if not has_unique_mxid:
        await conn.execute(f"ALTER TABLE portal ADD CONSTRAINT {constraint_name} UNIQUE(mxid)")

    constraint_name = "message_chat_id_fkey"
    q = ( "SELECT EXISTS(SELECT FROM information_schema.table_constraints "
         f"WHERE table_name='message' AND constraint_name='{constraint_name}')")
    has_fkey = await conn.fetchval(q)
    if not has_fkey:
        await conn.execute(
        f"ALTER TABLE message ADD CONSTRAINT {constraint_name} "
            "FOREIGN KEY (chat_id) "
                "REFERENCES portal (chat_id) "
                "ON DELETE CASCADE")


@upgrade_table.register(description="Read receipts for groups & rooms")
async def upgrade_read_receipts(conn: Connection) -> None:
    await conn.execute("""CREATE TABLE IF NOT EXISTS receipt_reaction (
        mxid        TEXT NOT NULL,
        mx_room     TEXT NOT NULL,
        relates_to  TEXT NOT NULL,
        num_read    INTEGER NOT NULL,

        PRIMARY KEY (mxid, mx_room),
        FOREIGN KEY (mx_room)
            REFERENCES portal (mxid)
            ON DELETE CASCADE
    )""")


@upgrade_table.register(description="Media metadata")
async def upgrade_deduplicate_blob(conn: Connection) -> None:
    await conn.execute("""ALTER TABLE media
       ADD COLUMN IF NOT EXISTS mime_type  TEXT,
       ADD COLUMN IF NOT EXISTS file_name  TEXT,
       ADD COLUMN IF NOT EXISTS size       INTEGER
   """)