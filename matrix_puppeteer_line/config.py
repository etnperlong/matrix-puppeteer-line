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
from typing import Any, List, NamedTuple
import os

from mautrix.util.config import ConfigUpdateHelper, ForbiddenDefault
from mautrix.bridge.config import BaseBridgeConfig

Permissions = NamedTuple("Permissions", user=bool, admin=bool, level=str)


class Config(BaseBridgeConfig):
    def __getitem__(self, key: str) -> Any:
        try:
            return os.environ[f"matrix_puppeteer_line_{key.replace('.', '_').upper()}"]
        except KeyError:
            return super().__getitem__(key)

    @property
    def forbidden_defaults(self) -> List[ForbiddenDefault]:
        return [
            *super().forbidden_defaults,
            ForbiddenDefault("appservice.database", "postgres://username:password@hostname/db"),
            ForbiddenDefault("bridge.user", "@admin:example.com"),
        ]

    def do_update(self, helper: ConfigUpdateHelper) -> None:
        super().do_update(helper)
        copy, copy_dict, base = helper

        copy("appservice.provisioning.enabled")
        copy("appservice.provisioning.prefix")
        copy("appservice.provisioning.shared_secret")
        if base["appservice.provisioning.shared_secret"] == "generate":
            base["appservice.provisioning.shared_secret"] = self._new_token()

        copy("appservice.community_id")

        copy("metrics.enabled")
        copy("metrics.listen_port")

        copy("bridge.username_template")
        copy("bridge.displayname_template")

        copy("bridge.displayname_max_length")

        copy("bridge.initial_conversation_sync")
        copy("bridge.invite_own_puppet_to_pm")
        copy("bridge.login_shared_secret")
        copy("bridge.federate_rooms")
        copy("bridge.backfill.invite_own_puppet")
        copy("bridge.backfill.initial_limit")
        copy("bridge.backfill.disable_notifications")
        copy("bridge.encryption.allow")
        copy("bridge.encryption.default")
        copy("bridge.encryption.key_sharing.allow")
        copy("bridge.encryption.key_sharing.require_cross_signing")
        copy("bridge.encryption.key_sharing.require_verification")
        copy("bridge.private_chat_portal_meta")
        copy("bridge.delivery_receipts")
        copy("bridge.delivery_error_reports")
        copy("bridge.resend_bridge_info")
        copy("bridge.command_prefix")
        copy("bridge.user")

        copy("puppeteer.connection.type")
        if base["puppeteer.connection.type"] == "unix":
            copy("puppeteer.connection.path")
        else:
            copy("puppeteer.connection.host")
            copy("puppeteer.connection.port")
