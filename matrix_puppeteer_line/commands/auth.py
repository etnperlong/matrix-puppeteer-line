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
from typing import Optional, AsyncGenerator, Tuple, TYPE_CHECKING
import io

import qrcode
import PIL as _

from mautrix.types import TextMessageEventContent, MediaMessageEventContent, MessageType, ImageInfo, EventID
from mautrix.bridge.commands import HelpSection, command_handler

from .typehint import CommandEvent

SECTION_AUTH = HelpSection("Authentication", 10, "")

from ..db import LoginCredential

if TYPE_CHECKING:
    from ..user import User


async def _login_prep(evt: CommandEvent, login_type: str) -> bool:
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

async def _login_do(
    gen: AsyncGenerator[Tuple[str, str], None],
    *,
    evt: Optional[CommandEvent] = None,
    sender: Optional["User"] = None,
) -> bool:
    qr_event_id: Optional[EventID] = None
    pin_event_id: Optional[EventID] = None
    failure = False

    if not evt and not sender:
        raise ValueError("Must set either a CommandEvent or a User")
    if evt:
        sender = evt.sender
        az = evt.az
        room_id = evt.room_id
    else:
        az = sender.az
        room_id = sender.notice_room
        if not room_id:
            sender.log.warning("Cannot auto-loggin: must have a notice room to do so")
            return False

    async for item in gen:
        if item[0] == "qr":
            message = "Open LINE on your smartphone and scan this QR code:"
            content = TextMessageEventContent(body=message, msgtype=MessageType.NOTICE)
            if evt:
                content.set_reply(evt.event_id)
            await az.intent.send_message(room_id, content)

            url = item[1]
            buffer = io.BytesIO()
            image = qrcode.make(url)
            size = image.pixel_size
            image.save(buffer, "PNG")
            qr = buffer.getvalue()
            mxc = await az.intent.upload_media(qr, "image/png", "login-qr.png", len(qr))
            content = MediaMessageEventContent(body=url, url=mxc, msgtype=MessageType.IMAGE,
                                               info=ImageInfo(mimetype="image/png", size=len(qr),
                                                              width=size, height=size))
            if qr_event_id:
                content.set_edit(qr_event_id)
                await az.intent.send_message(room_id, content)
            else:
                qr_event_id = await az.intent.send_message(room_id, content)
        elif item[0] == "pin":
            pin = item[1]
            message = f"Enter this PIN in LINE on your smartphone:\n{pin}"
            content = TextMessageEventContent(body=message, msgtype=MessageType.NOTICE)
            if pin_event_id:
                content.set_edit(pin_event_id)
                await az.intent.send_message(room_id, content)
            else:
                pin_event_id = await az.intent.send_message(room_id, content)
        elif item[0] == "login_success":
            await az.intent.send_notice(room_id, "Successfully logged in, waiting for LINE to load...")
        elif item[0] in ("login_failure", "error"):
            # TODO Handle errors differently?
            failure = True
            reason = item[1]
            if reason:
                await az.intent.send_notice(room_id, reason)
        # else: pass

    login_success = not failure and sender.command_status
    if login_success:
        await az.intent.send_notice(room_id, "LINE loading complete")
        await sender.sync()
    # else command was cancelled or failed. Don't post message about it, "cancel" command or failure did already
    sender.command_status = None
    return login_success

@command_handler(needs_auth=False, management_only=True, help_section=SECTION_AUTH,
                 help_text="Log into LINE via QR code")
async def login_qr(evt: CommandEvent) -> None:
    if not await _login_prep(evt, "qr"):
        return
    gen = evt.sender.client.login(evt.sender)
    await _login_do(gen, evt=evt)

@command_handler(needs_auth=False, management_only=True, help_section=SECTION_AUTH,
                 help_text="Log into LINE via email/password, and optionally save credentials for auto-login",
                 help_args="[--save] <_email_> <_password_>")
async def login_email(evt: CommandEvent) -> None:
    await evt.az.intent.redact(evt.room_id, evt.event_id)
    if evt.args and evt.args[0] == "--save":
        save = True
        evt.args.pop(0)
    else:
        save = False
    if len(evt.args) != 2:
        await evt.reply("Usage: `$cmdprefix+sp login-email [--save] <email> <password>`")
        return
    if not await _login_prep(evt, "email"):
        return
    await evt.reply("Logging in...")
    login_data = {
        "email": evt.args[0],
        "password": evt.args[1]
    }
    gen = evt.sender.client.login(
        evt.sender,
        login_data=login_data
    )
    login_success = await _login_do(gen, evt=evt)
    if login_success and save:
        if not evt.sender.notice_room:
            await evt.reply("WARNING: You do not have a notice room, but auto-login requires one.")
        await _save_password_helper(evt)

async def auto_login(sender: "User") -> bool:
    status = await sender.client.start()
    if status.is_logged_in:
        return True
    if sender.command_status is not None:
        return False
    creds = await LoginCredential.get_by_mxid(sender.mxid)
    if not creds:
        return False
    sender.command_status = {
        "action": "Login",
        "login_type": "email",
    }
    gen = sender.client.login(
        sender,
        login_data={
            "email": creds.email,
            "password": creds.password,
        }
    )
    return await _login_do(gen, sender=sender)

@command_handler(needs_auth=True, management_only=True, help_section=SECTION_AUTH,
                 help_text="Remember email/password credentials for auto-login",
                 help_args="<_email_> <_password_>")
async def save_password(evt: CommandEvent) -> None:
    await evt.az.intent.redact(evt.room_id, evt.event_id)
    if len(evt.args) != 2:
        await evt.reply("Usage: `$cmdprefix+sp save_password <email> <password>`")
        return
    await _save_password_helper(evt)

async def _save_password_helper(evt: CommandEvent) -> None:
    creds = await LoginCredential.get_by_mxid(evt.sender.mxid)
    if creds:
        creds.email = evt.args[0]
        creds.password = evt.args[1]
        await creds.update()
    else:
        await LoginCredential(evt.sender.mxid, email=evt.args[0], password=evt.args[1]).insert()
    await evt.reply("Login email/password saved, and will be used to log you back in if your LINE connection ends.")

@command_handler(needs_auth=False, management_only=True, help_section=SECTION_AUTH,
                 help_text="Delete saved email/password credentials")
async def forget_password(evt: CommandEvent) -> None:
    creds = await LoginCredential.get_by_mxid(evt.sender.mxid)
    if not creds:
        await evt.reply("The bridge wasn't storing your email/password, so there was nothing to forget.")
    else:
        await creds.delete()
        await evt.reply(
            "This bridge is no longer storing your email/password. \n"
            "You will have to log in manually the next time your LINE connection ends."
        )
