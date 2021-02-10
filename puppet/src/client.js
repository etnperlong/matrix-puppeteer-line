// mautrix-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
// Copyright (C) 2020-2021 Tulir Asokan, Andrew Ferrazzutti
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
import MessagesPuppeteer from "./puppet.js"
import { emitLines, promisify } from "./util.js"

export default class Client {
	/**
	 * @param {PuppetAPI} manager
	 * @param {import("net").Socket} socket
	 * @param {number} connID
	 * @param {?string} [userID]
	 * @param {?MessagesPuppeteer} [puppet]
	 */
	constructor(manager, socket, connID, userID = null, puppet = null) {
		this.manager = manager
		this.socket = socket
		this.connID = connID
		this.userID = userID
		this.puppet = puppet
		this.stopped = false
		this.notificationID = 0
		this.maxCommandID = 0
	}

	log(...text) {
		if (this.userID) {
			console.log(`[API/${this.userID}/${this.connID}]`, ...text)
		} else {
			console.log(`[API/${this.connID}]`, ...text)
		}
	}

	error(...text) {
		if (this.userID) {
			console.error(`[API/${this.userID}/${this.connID}]`, ...text)
		} else {
			console.error(`[API/${this.connID}]`, ...text)
		}
	}

	start() {
		this.log("Received connection", this.connID)
		emitLines(this.socket)
		this.socket.on("line", line => this.handleLine(line)
			.catch(err => this.log("Error handling line:", err)))
		this.socket.on("end", this.handleEnd)

		setTimeout(() => {
			if (!this.userID && !this.stopped) {
				this.log("Didn't receive register request within 3 seconds, terminating")
				this.stop("Register request timeout")
			}
		}, 3000)
	}

	async stop(error = null) {
		if (this.stopped) {
			return
		}
		this.stopped = true
		try {
			await this._write({ id: --this.notificationID, command: "quit", error })
			await promisify(cb => this.socket.end(cb))
		} catch (err) {
			this.error("Failed to end connection:", err)
			this.socket.destroy(err)
		}
	}

	handleEnd = () => {
		this.stopped = true
		if (this.userID && this.manager.clients.get(this.userID) === this) {
			this.manager.clients.delete(this.userID)
		}
		this.log(`Connection closed (user: ${this.userID})`)
	}

	/**
	 * Write JSON data to the socket.
	 *
	 * @param {object} data - The data to write.
	 * @return {Promise<void>}
	 */
	_write(data) {
		return promisify(cb => this.socket.write(JSON.stringify(data) + "\n", cb))
	}

	sendMessage(message) {
		this.log("Sending", message, "to client")
		return this._write({
			id: --this.notificationID,
			command: "message",
			message,
		})
	}

	sendQRCode(url) {
		this.log("Sending QR", url, "to client")
		return this._write({
			id: --this.notificationID,
			command: "qr",
			url,
		})
	}

	sendPIN(pin) {
		this.log(`Sending PIN ${pin} to client`)
		return this._write({
			id: --this.notificationID,
			command: "pin",
			pin,
		})
	}

	sendFailure(reason) {
		this.log(`Sending failure "${reason}" to client`)
		return this._write({
			id: --this.notificationID,
			command: "failure",
			reason,
		})
	}

	handleStart = async (req) => {
		let started = false
		if (this.puppet === null) {
			this.log("Opening new puppeteer for", this.userID)
			this.puppet = new MessagesPuppeteer(this.userID, this)
			this.manager.puppets.set(this.userID, this.puppet)
			await this.puppet.start(!!req.debug)
			started = true
		}
		return {
			started,
			is_logged_in: await this.puppet.isLoggedIn(),
			is_connected: !await this.puppet.isDisconnected(),
			is_permanently_disconnected: await this.puppet.isPermanentlyDisconnected(),
		}
	}

	handleStop = async () => {
		if (this.puppet === null) {
			return { stopped: false }
		}
		this.log("Closing puppeteer for", this.userID)
		this.manager.puppets.delete(this.userID)
		await this.puppet.stop()
		this.puppet = null
		return { stopped: true }
	}

	handleUnknownCommand = () => {
		throw new Error("Unknown command")
	}

	handleRegister = async (req) => {
		this.userID = req.user_id
		this.log("Registered socket", this.connID, "->", this.userID)
		if (this.manager.clients.has(this.userID)) {
			const oldClient = this.manager.clients.get(this.userID)
			this.manager.clients.set(this.userID, this)
			this.log("Terminating previous socket", oldClient.connID, "for", this.userID)
			await oldClient.stop("Socket replaced by new connection")
		} else {
			this.manager.clients.set(this.userID, this)
		}
		this.puppet = this.manager.puppets.get(this.userID) || null
		if (this.puppet) {
			this.puppet.client = this
		}
		return { client_exists: this.puppet !== null }
	}

	async handleLine(line) {
		if (this.stopped) {
			this.log("Ignoring line, client is stopped")
			return
		}
		let req
		try {
			req = JSON.parse(line)
		} catch (err) {
			this.log("Non-JSON request:", line)
			return
		}
		if (!req.command || !req.id) {
			this.log("Invalid request:", line)
			return
		}
		if (req.id <= this.maxCommandID) {
			this.log("Ignoring old request", req.id)
			return
		}
		this.log("Received request", req.id, "with command", req.command)
		this.maxCommandID = req.id
		let handler
		if (!this.userID) {
			if (req.command !== "register") {
				this.log("First request wasn't a register request, terminating")
				await this.stop("Invalid first request")
				return
			} else if (!req.user_id) {
				this.log("Register request didn't contain user ID, terminating")
				await this.stop("Invalid register request")
				return
			}
			handler = this.handleRegister
		} else {
			handler = {
				start: this.handleStart,
				stop: this.handleStop,
				disconnect: () => this.stop(),
				login: req => this.puppet.waitForLogin(req.login_type, req.login_data),
				cancel_login: () => this.puppet.cancelLogin(),
				send: req => this.puppet.sendMessage(req.chat_id, req.text),
				set_last_message_ids: req => this.puppet.setLastMessageIDs(req.msg_ids),
				get_chats: () => this.puppet.getRecentChats(),
				get_chat: req => this.puppet.getChatInfo(req.chat_id),
				get_messages: req => this.puppet.getMessages(req.chat_id),
				is_connected: async () => ({ is_connected: !await this.puppet.isDisconnected() }),
			}[req.command] || this.handleUnknownCommand
		}
		const resp = { id: req.id }
		try {
			resp.command = "response"
			resp.response = await handler(req)
		} catch (err) {
			resp.command = "error"
			resp.error = err.toString()
			this.log("Error handling request", req.id, err)
		}
		await this._write(resp)
	}
}
