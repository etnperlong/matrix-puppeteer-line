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
from typing import Optional, AsyncGenerator, Tuple
import io

import qrcode
import PIL as _

from mautrix.types import TextMessageEventContent, MediaMessageEventContent, MessageType, ImageInfo, EventID
from mautrix.bridge.commands import HelpSection, command_handler

from .typehint import CommandEvent

SECTION_AUTH = HelpSection("Authentication", 10, "")


async def login_prep(evt: CommandEvent, login_type: str) -> bool:
    status = await evt.sender.client.start()
    if status.is_logged_in:
        await evt.reply("You're already logged in")
        return False

    if evt.sender.command_status is not None:
        action = evt.sender.command_status["action"]
        if action == "Login":
            await evt.reply(
                "A login is already in progress. Please follow the login instructions, "
                "or use the `$cmdprefix+sp cancel` command to start over.")
        else:
            await evt.reply(f"Cannot login while a {action} command is active.")
        return False

    evt.sender.command_status = {
        "action": "Login",
        "login_type": login_type,
    }
    return True

async def login_do(evt: CommandEvent, gen: AsyncGenerator[Tuple[str, str], None]) -> None:
    qr_event_id: Optional[EventID] = None
    pin_event_id: Optional[EventID] = None
    failure = False
    async for item in gen:
        if item[0] == "qr":
            url = item[1]
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
        elif item[0] == "pin":
            pin = item[1]
            message = f"Enter this PIN in LINE on your primary device:\n{pin}"
            content = TextMessageEventContent(body=message, msgtype=MessageType.NOTICE)
            if pin_event_id:
                content.set_edit(pin_event_id)
                await evt.az.intent.send_message(evt.room_id, content)
            else:
                content.set_reply(evt.event_id)
                pin_event_id = await evt.az.intent.send_message(evt.room_id, content)
        elif item[0] in ("failure", "error"):
            # TODO Handle errors differently?
            failure = True
            reason = item[1]
            if reason:
                content = TextMessageEventContent(body=reason, msgtype=MessageType.NOTICE)
                await evt.az.intent.send_message(evt.room_id, content)
        # else: pass

    if not failure and evt.sender.command_status:
        await evt.reply("Successfully logged in, now syncing")
        await evt.sender.sync()
        await evt.reply("Syncing complete")
    # else command was cancelled or failed. Don't post message about it, "cancel" command or failure did already
    evt.sender.command_status = None

@command_handler(needs_auth=False, management_only=True, help_section=SECTION_AUTH,
                 help_text="Log into LINE via QR code")
async def login_qr(evt: CommandEvent) -> None:
    if not await login_prep(evt, "qr"):
        return
    gen = evt.sender.client.login(evt.sender)
    await login_do(evt, gen)

@command_handler(needs_auth=False, management_only=True, help_section=SECTION_AUTH,
                 help_text="Log into LINE via email/password",
                 help_args="<_email_> <_password_>")
async def login_email(evt: CommandEvent) -> None:
    await evt.az.intent.redact(evt.room_id, evt.event_id)
    if len(evt.args) != 2:
        await evt.reply("Usage: `$cmdprefix+sp login <email> <password>`")
        return
    if not await login_prep(evt, "email"):
        return
    gen = evt.sender.client.login(
            evt.sender,
            login_data=dict(email=evt.args[0], password=evt.args[1]))
    await login_do(evt, gen)
