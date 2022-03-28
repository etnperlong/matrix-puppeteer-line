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
    table_name = "portal"
    constraint_name = f"{table_name}_mxid_key"
    q = ( "SELECT EXISTS(SELECT FROM information_schema.constraint_table_usage "
         f"WHERE table_name='{table_name}' AND constraint_name='{constraint_name}')")
    has_constraint = await conn.fetchval(q)
    if not has_constraint:
        await conn.execute(f"ALTER TABLE {table_name} ADD CONSTRAINT {constraint_name} UNIQUE(mxid)")

    table_name = "message"
    constraint_name = f"{table_name}_chat_id_fkey"
    q = ( "SELECT EXISTS(SELECT FROM information_schema.table_constraints "
         f"WHERE table_name='{table_name}' AND constraint_name='{constraint_name}')")
    has_constraint = await conn.fetchval(q)
    if not has_constraint:
        await conn.execute(
        f"ALTER TABLE {table_name} ADD CONSTRAINT {constraint_name} "
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


@upgrade_table.register(description="Strangers")
async def upgrade_strangers(conn: Connection) -> None:
    await conn.execute("""
    CREATE TABLE IF NOT EXISTS stranger (
        fake_mid     TEXT NOT NULL UNIQUE,
        name         TEXT NOT NULL,
        avatar_path  TEXT NOT NULL,
        available    BOOLEAN NOT NULL DEFAULT false,

        PRIMARY KEY (name, avatar_path),
        FOREIGN KEY (fake_mid)
            REFERENCES puppet (mid)
            ON DELETE CASCADE
   )""")


@upgrade_table.register(description="Track messages that lack an ID")
async def upgrade_noid_msgs(conn: Connection) -> None:
    await conn.execute("ALTER TABLE message DROP CONSTRAINT IF EXISTS message_pkey")
    await conn.execute("ALTER TABLE message ALTER COLUMN mid DROP NOT NULL")

    table_name = "message"
    constraint_name = f"{table_name}_mid_key"
    q = ( "SELECT EXISTS(SELECT FROM information_schema.constraint_table_usage "
         f"WHERE table_name='{table_name}' AND constraint_name='{constraint_name}')")
    has_constraint = await conn.fetchval(q)
    if not has_constraint:
        await conn.execute(f"ALTER TABLE {table_name} ADD UNIQUE (mid)")


@upgrade_table.register(description="Track LINE read receipts")
async def upgrade_latest_read_receipts(conn: Connection) -> None:
    await conn.execute("ALTER TABLE message DROP CONSTRAINT IF EXISTS message_mid_key")
    await conn.execute("ALTER TABLE message ADD UNIQUE (mid, chat_id)")
    await conn.execute("ALTER TABLE message "
                       "ADD COLUMN IF NOT EXISTS "
                       "is_outgoing BOOLEAN NOT NULL DEFAULT false")

    await conn.execute("""CREATE TABLE IF NOT EXISTS receipt (
        mid      INTEGER NOT NULL,
        chat_id  TEXT NOT NULL,
        num_read INTEGER NOT NULL DEFAULT 1,

        PRIMARY KEY (chat_id, num_read),
        FOREIGN KEY (mid, chat_id)
            REFERENCES message (mid, chat_id)
            ON DELETE CASCADE
    )""")


@upgrade_table.register(description="Allow messages with no mxid")
async def upgrade_nomxid_msgs(conn: Connection) -> None:
    await conn.execute("ALTER TABLE message ALTER COLUMN mxid DROP NOT NULL")


@upgrade_table.register(description="Allow storing email/password login credentials")
async def upgrade_login_credentials(conn: Connection) -> None:
    await conn.execute("""CREATE TABLE IF NOT EXISTS login_credential (
        mxid        TEXT PRIMARY KEY,
        email       TEXT NOT NULL,
        password    TEXT NOT NULL,

        FOREIGN KEY (mxid)
            REFERENCES "user" (mxid)
            ON DELETE CASCADE
    )""")