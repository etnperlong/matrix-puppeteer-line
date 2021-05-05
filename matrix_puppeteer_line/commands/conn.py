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
from mautrix.bridge.commands import HelpSection, command_handler

from .typehint import CommandEvent

SECTION_CONNECTION = HelpSection("Connection management", 15, "")


@command_handler(needs_auth=False, management_only=True, help_section=SECTION_CONNECTION,
                 help_text="Mark this room as your bridge notice room")
async def set_notice_room(evt: CommandEvent) -> None:
    evt.sender.notice_room = evt.room_id
    await evt.sender.update()
    await evt.reply("This room has been marked as your bridge notice room")


@command_handler(needs_auth=False, management_only=True, help_section=SECTION_CONNECTION,
                 help_text="Check if you're logged into LINE")
async def ping(evt: CommandEvent) -> None:
    status = await evt.sender.client.start()
    if status.is_logged_in:
        await evt.reply("You're logged in")
    elif status.is_permanently_disconnected or not status.is_connected:
        await evt.reply("You're not connected")
    else:
        await evt.reply("You're not logged in")


@command_handler(needs_auth=True, management_only=False, help_section=SECTION_CONNECTION,
                 help_text="Synchronize portals")
async def sync(evt: CommandEvent) -> None:
    await evt.sender.sync()
