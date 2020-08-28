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
from typing import Optional
import io

import qrcode
import PIL as _

from mautrix.types import MediaMessageEventContent, MessageType, ImageInfo, EventID

from . import command_handler, CommandEvent, SECTION_CONNECTION, SECTION_AUTH


@command_handler(needs_auth=False, management_only=True, help_section=SECTION_AUTH,
                 help_text="Log into Android Messages")
async def login(evt: CommandEvent) -> None:
    status = await evt.sender.client.start()
    if status.is_logged_in:
        await evt.reply("You're already logged in")
        return
    qr_event_id: Optional[EventID] = None
    async for url in evt.sender.client.login():
        buffer = io.BytesIO()
        image = qrcode.make(url)
        size = image.pixel_size
        image.save(buffer, "PNG")
        qr = buffer.getvalue()
        mxc = await evt.az.intent.upload_media(qr, "image/png", "login-qr.png", len(qr))
        content = MediaMessageEventContent(body=url, url=mxc, msgtype=MessageType.IMAGE,
                                           info=ImageInfo(mimetype="image/png", size=len(qr),
                                                          width=size, height=size))
        if qr_event_id:
            content.set_edit(qr_event_id)
            await evt.az.intent.send_message(evt.room_id, content)
        else:
            content.set_reply(evt.event_id)
            qr_event_id = await evt.az.intent.send_message(evt.room_id, content)
    await evt.reply("Successfully logged in, now syncing")
    await evt.sender.sync()
