// mautrix-amp - A very hacky Matrix-SMS bridge based on using Android Messages for Web in Puppeteer
// Copyright (C) 2020 Tulir Asokan
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
import net from "net"
import fs from "fs"
import path from "path"

import Client from "./client.js"
import { promisify } from "./util.js"

export default class PuppetAPI {
	path = "/var/run/mautrix-amp/puppet.sock"

	constructor() {
		this.server = net.createServer(this.acceptConnection)
		this.puppets = new Map()
		this.clients = new Map()
		this.connIDSequence = 0
		this.stopped = false
	}

	log(...text) {
		console.log("[API]", ...text)
	}

	acceptConnection = sock => {
		if (this.stopped) {
			sock.end()
		} else {
			new Client(this, sock, ++this.connIDSequence).start()
		}
	}

	async start() {
		this.log("Starting server")

		try {
			await fs.promises.access(path.dirname(this.path))
		} catch (err) {
			await fs.promises.mkdir(path.dirname(this.path), 0o700)
		}
		try {
			await fs.promises.unlink(this.path)
		} catch (err) {}
		await promisify(cb => this.server.listen(this.path, cb))
		await fs.promises.chmod(this.path, 0o700)
		this.log("Now listening at", this.path)
	}

	async stop() {
		this.stopped = true
		for (const client of this.clients.values()) {
			await client.stop("Server is shutting down")
		}
		this.log("Stopping server")
		await promisify(cb => this.server.close(cb))
		try {
			await fs.promises.unlink(this.path)
		} catch (err) {}
		this.log("Server stopped")
		for (const puppet of this.puppets.values()) {
			await puppet.stop()
		}
	}
}
