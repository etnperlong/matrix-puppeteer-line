from typing import TYPE_CHECKING

from mautrix.bridge.commands import CommandEvent as BaseCommandEvent

if TYPE_CHECKING:
    from ..__main__ import MessagesBridge
    from ..user import User


class CommandEvent(BaseCommandEvent):
    bridge: 'MessagesBridge'
    sender: 'User'
