# matrix-appservice-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
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
from typing import Awaitable, Dict, Optional
import logging
import asyncio

from aiohttp import web

from mautrix.types import UserID
from mautrix.util.logging import TraceLogger

from .. import user as u


class ProvisioningAPI:
    log: TraceLogger = logging.getLogger("mau.web.provisioning")
    app: web.Application

    def __init__(self, shared_secret: str) -> None:
        self.app = web.Application()
        self.shared_secret = shared_secret
        self.app.router.add_get("/api/whoami", self.status)
        self.app.router.add_get("/api/login", self.login)

    @property
    def _acao_headers(self) -> Dict[str, str]:
        return {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Allow-Methods": "GET",
        }

    @property
    def _headers(self) -> Dict[str, str]:
        return {
            **self._acao_headers,
            "Content-Type": "application/json",
        }

    async def login_options(self, _: web.Request) -> web.Response:
        return web.Response(status=200, headers=self._headers)

    @staticmethod
    def _get_ws_token(request: web.Request) -> Optional[str]:
        if not request.path.endswith("/login"):
            return None

        try:
            auth_parts = request.headers["Sec-WebSocket-Protocol"].split(",")
        except KeyError:
            return None
        for part in auth_parts:
            part = part.strip()
            if part.startswith("net.maunium.line.auth-"):
                return part[len("net.maunium.line.auth-"):]
        return None

    def check_token(self, request: web.Request) -> Awaitable['u.User']:
        try:
            token = request.headers["Authorization"]
            token = token[len("Bearer "):]
        except KeyError:
            token = self._get_ws_token(request)
            if not token:
                raise web.HTTPBadRequest(text='{"error": "Missing Authorization header"}',
                                         headers=self._headers)
        except IndexError:
            raise web.HTTPBadRequest(text='{"error": "Malformed Authorization header"}',
                                     headers=self._headers)
        if token != self.shared_secret:
            raise web.HTTPForbidden(text='{"error": "Invalid token"}', headers=self._headers)
        try:
            user_id = request.query["user_id"]
        except KeyError:
            raise web.HTTPBadRequest(text='{"error": "Missing user_id query param"}',
                                     headers=self._headers)

        return u.User.get_by_mxid(UserID(user_id))

    async def status(self, request: web.Request) -> web.Response:
        user = await self.check_token(request)
        data = {
            "mxid": user.mxid,
            "line": {
                "connected": True,
            } if await user.is_logged_in() else None,
        }
        return web.json_response(data, headers=self._acao_headers)

    async def login(self, request: web.Request) -> web.WebSocketResponse:
        user = await self.check_token(request)

        status = await user.client.start()
        if status.is_logged_in:
            raise web.HTTPConflict(text='{"error": "Already logged in"}', headers=self._headers)

        ws = web.WebSocketResponse(protocols=["net.maunium.line.login"])
        await ws.prepare(request)
        try:
            async for url in user.client.login():
                self.log.debug("Sending QR URL %s to websocket", url)
                await ws.send_json({"url": url})
        except Exception:
            await ws.send_json({"success": False})
            self.log.exception("Error logging in")
        else:
            await ws.send_json({"success": True})
            asyncio.create_task(user.sync())
        await ws.close()
        return ws
