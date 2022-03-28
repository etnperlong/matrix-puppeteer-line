// matrix-puppeteer-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
// Copyright (C) 2020-2022 Tulir Asokan, Andrew Ferrazzutti
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
	constructor(listenConfig) {
		this.listenConfig = listenConfig
		this.server = net.createServer(this.acceptConnection)
		this.connections = []
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
			sock.destroy()
		} else {
			const connID = this.connIDSequence++
			this.connections[connID] = sock
			new Client(this, sock, connID).start()
		}
	}

	async startUnix(socketPath) {
		try {
			await fs.promises.access(path.dirname(socketPath))
		} catch (err) {
			await fs.promises.mkdir(path.dirname(socketPath), 0o700)
		}
		try {
			await fs.promises.unlink(socketPath)
		} catch (err) {}
		await promisify(cb => this.server.listen(socketPath, cb))
		await fs.promises.chmod(socketPath, 0o700)
		this.log("Now listening at", socketPath)
	}

	async startTCP(port, host) {
		await promisify(cb => this.server.listen(port, host, cb))
		this.log(`Now listening at ${host || ""}:${port}`)
	}

	async start() {
		this.log("Starting server")

		if (this.listenConfig.type === "unix") {
			await this.startUnix(this.listenConfig.path)
		} else if (this.listenConfig.type === "tcp") {
			await this.startTCP(this.listenConfig.port, this.listenConfig.host)
		}
	}

	async stop() {
		this.stopped = true
		for (const client of this.clients.values()) {
			await client.stop("Server is shutting down")
		}
		for (const socket of this.connections) {
			socket.end()
			socket.destroy()
		}
		this.log("Stopping server")
		await promisify(cb => this.server.close(cb))
		if (this.listenConfig.type === "unix") {
			try {
				await fs.promises.unlink(this.listenConfig.path)
			} catch (err) {}
		}
		this.log("Stopping puppets")
		for (const puppet of this.puppets.values()) {
			await puppet.stop()
		}
	}
}
