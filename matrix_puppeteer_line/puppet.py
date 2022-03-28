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
from typing import Optional, Dict, List, TYPE_CHECKING, cast

from mautrix.bridge import BasePuppet
from mautrix.types import UserID, ContentURI
from mautrix.util.simple_template import SimpleTemplate

from .db import Puppet as DBPuppet, Stranger
from .config import Config
from .rpc import Participant, Client, PathImage
from . import user as u

if TYPE_CHECKING:
    from .__main__ import MessagesBridge


class Puppet(DBPuppet, BasePuppet):
    by_mid: Dict[str, 'Puppet'] = {}
    hs_domain: str
    mxid_template: SimpleTemplate[str]

    bridge: 'MessagesBridge'
    config: Config

    default_mxid: UserID

    def __init__(self, mid: str, name: Optional[str] = None,
                 avatar_path: Optional[str] = None, avatar_mxc: Optional[ContentURI] = None,
                 name_set: bool = False, avatar_set: bool = False,
                 is_registered: bool = False) -> None:
        super().__init__(mid, name, avatar_path, avatar_mxc, name_set, avatar_set, is_registered)
        self.log = self.log.getChild(mid)

        self.default_mxid = self.get_mxid_from_id(mid)
        self.intent = self.az.intent.user(self.default_mxid)

    @classmethod
    def init_cls(cls, bridge: 'MessagesBridge') -> None:
        cls.config = bridge.config
        cls.loop = bridge.loop
        cls.mx = bridge.matrix
        cls.az = bridge.az
        cls.bridge = bridge
        cls.hs_domain = cls.config["homeserver.domain"]
        cls.mxid_template = SimpleTemplate(cls.config["bridge.username_template"], "userid",
                                           prefix="@", suffix=f":{cls.hs_domain}", type=str)
        secret = cls.config["bridge.login_shared_secret"]
        if secret:
            cls.login_shared_secret_map[cls.hs_domain] = secret.encode("utf-8")
        cls.login_device_name = "LINE Bridge"

    async def update_info(self, info: Participant, client: Optional[Client]) -> None:
        update = False
        update = await self._update_name(info.name) or update
        if client:
            update = await self._update_avatar(info.avatar, client) or update
        if update:
            await self.update()

    async def _update_name(self, name: str) -> bool:
        name = self.config["bridge.displayname_template"].format(displayname=name)
        if name != self.name or not self.name_set:
            self.name = name
            try:
                await self.intent.set_displayname(self.name)
                self.name_set = True
            except Exception:
                self.log.exception("Failed to set displayname")
                self.name_set = False
            return True
        return False

    async def _update_avatar(self, avatar: Optional[PathImage], client: Client) -> bool:
        if avatar:
            if avatar.url and not avatar.path:
                if self.avatar_set and self.avatar_path:
                    self.log.warn(f"Not updating user avatar of {self.name}: new avatar exists, but in a form that cannot be uniquely identified")
                    return False
                else:
                    self.log.warn(f"Using URL as path for user avatar of {self.name}: no previous avatar exists")
                    avatar_path = avatar_url = avatar.url
            else:
                avatar_path = avatar.path
                avatar_url = avatar.url
        else:
            avatar_path = avatar_url = None

        if not self.avatar_set or avatar_path != self.avatar_path:
            self.log.info(f"Updating user avatar of {self.name}")
            self.avatar_path = avatar_path
            if avatar_url:
                resp = await client.read_image(avatar.url)
                self.avatar_mxc = await self.intent.upload_media(resp.data, mime_type=resp.mime)
            else:
                self.avatar_mxc = ContentURI("")
            try:
                await self.intent.set_avatar_url(self.avatar_mxc)
                self.avatar_set = True
            except Exception as e:
                self.log.exception(f"Failed to set user avatar: {e}")
                self.avatar_set = False
            return True
        else:
            self.log.debug(f"No need to update user avatar of {self.name}, new avatar has same path as old one")
            return False

    def _add_to_cache(self) -> None:
        self.by_mid[self.mid] = self

    async def save(self) -> None:
        await self.update()

    @classmethod
    async def get_by_mxid(cls, mxid: UserID, create: bool = True) -> Optional['Puppet']:
        mid = cls.get_id_from_mxid(mxid)
        if mid:
            return await cls.get_by_mid(mid, create)
        return None

    @classmethod
    def get_id_from_mxid(cls, mxid: UserID) -> Optional[str]:
        return cls.mxid_template.parse(mxid)

    @classmethod
    def get_mxid_from_id(cls, mid: str) -> UserID:
        return UserID(cls.mxid_template.format_full(mid))

    @classmethod
    async def get_by_mid(cls, mid: str, create: bool = True) -> Optional['Puppet']:
        if mid is None:
            return None

        # TODO Might need to parse a real id from "_OWN"
        try:
            return cls.by_mid[mid]
        except KeyError:
            pass

        puppet = cast(cls, await super().get_by_mid(mid))
        if puppet is not None:
            puppet._add_to_cache()
            return puppet

        if create:
            puppet = cls(mid)
            await puppet.insert()
            puppet._add_to_cache()
            return puppet

        return None

    @classmethod
    async def get_by_profile(cls, info: Participant, client: Optional[Client] = None) -> 'Puppet':
        stranger = await Stranger.get_by_profile(info)
        if not stranger:
            stranger = await Stranger.init_available_or_new()

            puppet = cls(stranger.fake_mid)
            # NOTE An update will insert anyways, so just do it now
            await puppet.insert()
            await puppet.update_info(info, client)
            puppet._add_to_cache()

            # Get path from puppet in case it uses the URL as the path.
            # But that should never happen in practice for strangers,
            # which should only occur in rooms, where avatars have paths.
            stranger.avatar_path = puppet.avatar_path
            stranger.name = info.name
            await stranger.insert()
            # TODO Need a way to keep stranger name/avatar up to date,
            #      lest name/avatar changes get seen as another stranger.
            #      Also need to detect when a stranger becomes a friend.
        return await cls.get_by_mid(stranger.fake_mid)

    @classmethod
    async def get_by_sender(cls, info: Participant, client: Optional[Client] = None) -> 'Puppet':
        puppet = await cls.get_by_mid(info.id)
        return puppet if puppet else await cls.get_by_profile(info, client)

    # TODO When supporting multiple bridge users, this should return the user whose puppet this is
    @classmethod
    def is_mid_for_own_puppet(cls, mid) -> bool:
        return mid and mid.startswith("_OWN_")

    @property
    def is_own_puppet(self) -> bool:
        return self.mid.startswith("_OWN_")

    @classmethod
    async def get_by_custom_mxid(cls, mxid: UserID) -> Optional['u.User']:
        if mxid == cls.config["bridge.user"]:
            return await cls.bridge.get_user(mxid)
        return None

    @classmethod
    async def get_all(cls) -> List['Puppet']:
        return [p for p in await super().get_all() if not p.is_own_puppet]
