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
from mautrix.bridge import Bridge
from mautrix.bridge.state_store.asyncpg import PgBridgeStateStore
from mautrix.types import RoomID, UserID
from mautrix.util.async_db import Database

from .version import version, linkified_version
from .config import Config
from .db import upgrade_table, init as init_db
from .matrix import MatrixHandler
from .user import User
from .portal import Portal
from .puppet import Puppet
from .web import ProvisioningAPI
from . import commands as _


class MessagesBridge(Bridge):
    module = "matrix_puppeteer_line"
    name = "matrix-puppeteer-line"
    command = "python -m matrix_puppeteer_line"
    description = ("A very hacky Matrix-LINE bridge based on running "
                   "LINE's Chrome extension in Puppeteer.")
    repo_url = "https://src.miscworks.net/fair/matrix-puppeteer-line"
    real_user_content_key = "net.miscworks.line.puppet"
    version = version
    markdown_version = linkified_version
    config_class = Config
    matrix_class = MatrixHandler

    db: Database
    matrix: MatrixHandler
    config: Config
    state_store: PgBridgeStateStore
    provisioning_api: ProvisioningAPI

    def make_state_store(self) -> None:
        self.state_store = PgBridgeStateStore(self.db, self.get_puppet, self.get_double_puppet)

    def prepare_db(self) -> None:
        self.db = Database(self.config["appservice.database"], upgrade_table=upgrade_table,
                           loop=self.loop)
        init_db(self.db)

    def prepare_bridge(self) -> None:
        super().prepare_bridge()
        cfg = self.config["appservice.provisioning"]
        self.provisioning_api = ProvisioningAPI(cfg["shared_secret"])
        self.az.app.add_subapp(cfg["prefix"], self.provisioning_api.app)

    async def start(self) -> None:
        await self.db.start()
        await self.state_store.upgrade_table.upgrade(self.db.pool)
        User.init_cls(self)
        Puppet.init_cls(self)
        Portal.init_cls(self)
        if self.config["bridge.resend_bridge_info"]:
            self.add_startup_actions(self.resend_bridge_info())
        main_user = await User.get_by_mxid(self.config["bridge.user"])
        self.add_startup_actions(main_user.connect())
        await super().start()

    def prepare_stop(self) -> None:
        self.add_shutdown_actions(user.stop() for user in User.by_mxid.values())
        for puppet in Puppet.by_custom_mxid.values():
            puppet.stop()

    async def resend_bridge_info(self) -> None:
        self.config["bridge.resend_bridge_info"] = False
        self.config.save()
        self.log.info("Re-sending bridge info state event to all portals")
        async for portal in Portal.all_with_room():
            await portal.update_bridge_info()
        self.log.info("Finished re-sending bridge info state events")

    async def get_user(self, user_id: UserID, create: bool = True) -> User:
        return await User.get_by_mxid(user_id, create=create)

    async def get_portal(self, room_id: RoomID) -> Portal:
        return await Portal.get_by_mxid(room_id)

    async def get_puppet(self, user_id: UserID, create: bool = False) -> Puppet:
        return await Puppet.get_by_mxid(user_id, create=create)

    async def get_double_puppet(self, user_id: UserID) -> User:
        return await Puppet.get_by_custom_mxid(user_id)

    def is_bridge_ghost(self, user_id: UserID) -> bool:
        return bool(Puppet.get_id_from_mxid(user_id))


MessagesBridge().run()
