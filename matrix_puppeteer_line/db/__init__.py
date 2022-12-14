from mautrix.util.async_db import Database

from .upgrade import upgrade_table
from .user import User
from .puppet import Puppet
from .stranger import Stranger
from .portal import Portal
from .message import Message
from .media import Media
from .receipt import Receipt
from .receipt_reaction import ReceiptReaction
from .login_credential import LoginCredential


def init(db: Database) -> None:
    for table in (User, Puppet, Stranger, Portal, Message, Media, Receipt, ReceiptReaction, LoginCredential):
        table.db = db


__all__ = [
    "upgrade_table",
    "User",
    "Puppet",
    "Stranger",
    "Portal",
    "Message",
    "Media",
    "Receipt",
    "ReceiptReaction",
    "LoginCredential"
]
