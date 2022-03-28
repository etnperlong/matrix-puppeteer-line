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
from mautrix.bridge.commands import HelpSection, command_handler

from .. import puppet as pu
from .typehint import CommandEvent

SECTION_CHATS = HelpSection("Contacts & Chats", 40, "")


@command_handler(needs_auth=True, management_only=False, help_section=SECTION_CHATS,
                 help_text="List all LINE contacts")
async def list_contacts(evt: CommandEvent) -> None:
    # TODO Use a generator if it's worth it
    puppets = await pu.Puppet.get_all()
    puppets.sort(key=lambda puppet: puppet.name)
    results = "".join(f"* [{puppet.name}](https://matrix.to/#/{puppet.default_mxid})\n"
                      for puppet in puppets)
    if results:
        await evt.reply(f"Contacts:\n\n{results}")
    else:
        await evt.reply("No contacts found.")