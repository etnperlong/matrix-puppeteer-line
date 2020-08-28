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
import process from "process"
import path from "path"

import puppeteer from "puppeteer"
import chrono from "chrono-node"

import TaskQueue from "./taskqueue.js"
import { sleep } from "./util.js"

export default class MessagesPuppeteer {
	static profileDir = "./profiles"
	static executablePath = undefined
	static disableDebug = false
	static noSandbox = false
	static viewport = { width: 1920, height: 1080 }
	static url = "https://messages.google.com/web/"

	/**
	 *
	 * @param {string} id
	 * @param {?Client} [client]
	 */
	constructor(id, client = null) {
		let profilePath = path.join(MessagesPuppeteer.profileDir, id)
		if (!profilePath.startsWith("/")) {
			profilePath = path.join(process.cwd(), profilePath)
		}
		this.id = id
		this.profilePath = profilePath
		this.updatedChats = new Set()
		this.sentMessageIDs = new Set()
		this.mostRecentMessages = new Map()
		this.taskQueue = new TaskQueue(this.id)
		this.client = client
	}

	log(...text) {
		console.log(`[Puppeteer/${this.id}]`, ...text)
	}

	error(...text) {
		console.error(`[Puppeteer/${this.id}]`, ...text)
	}

	/**
	 * Start the browser and open the messages for web page.
	 * This must be called before doing anything else.
	 */
	async start(debug = false) {
		this.log("Launching browser")
		this.browser = await puppeteer.launch({
			executablePath: MessagesPuppeteer.executablePath,
			userDataDir: this.profilePath,
			args: MessagesPuppeteer.noSandbox ? ["--no-sandbox"] : undefined,
			headless: MessagesPuppeteer.disableDebug || !debug,
			defaultViewport: MessagesPuppeteer.viewport,
		})
		this.log("Opening new tab")
		const pages = await this.browser.pages()
		if (pages.length > 0) {
			this.page = pages[0]
		} else {
			this.page = await this.browser.newPage()
		}
		this.log("Opening", MessagesPuppeteer.url)
		await this.page.goto(MessagesPuppeteer.url)

		this.log("Injecting content script")
		await this.page.addScriptTag({ path: "./src/contentscript.js", type: "module" })
		this.log("Exposing functions")
		await this.page.exposeFunction("__mautrixReceiveQR", this._receiveQRChange.bind(this))
		await this.page.exposeFunction("__mautrixReceiveMessageID",
				id => this.sentMessageIDs.add(id))
		await this.page.exposeFunction("__mautrixReceiveChanges",
			this._receiveChatListChanges.bind(this))
		await this.page.exposeFunction("__chronoParseDate", chrono.parseDate)

		this.log("Waiting for load")
		// Wait for the page to load (either QR code for login or chat list when already logged in)
		await Promise.race([
			this.page.waitForSelector("mw-main-container mws-conversations-list .conv-container",
				{ visible: true, timeout: 60000 }),
			this.page.waitForSelector("mw-authentication-container mw-qr-code",
				{ visible: true, timeout: 60000 }),
			this.page.waitForSelector("mw-unable-to-connect-container",
				{ visible: true, timeout: 60000 }),
		])
		this.taskQueue.start()
		if (await this.isLoggedIn()) {
			await this.startObserving()
		}
		this.log("Startup complete")
	}

	/**
	 * Wait for the session to be logged in and monitor QR code changes while it's not.
	 */
	async waitForLogin() {
		if (await this.isLoggedIn()) {
			return
		}
		const qrSelector = "mw-authentication-container mw-qr-code"
		this.log("Clicking Remember Me button")
		await this.page.click("mat-slide-toggle:not(.mat-checked) > label")
		this.log("Fetching current QR code")
		const currentQR = await this.page.$eval(qrSelector,
			element => element.getAttribute("data-qr-code"))
		this._receiveQRChange(currentQR)
		this.log("Adding QR observer")
		await this.page.$eval(qrSelector,
			element => window.__mautrixController.addQRObserver(element))
		this.log("Waiting for login")
		await this.page.waitForSelector("mws-conversations-list .conv-container", {
			visible: true,
			timeout: 0,
		})
		this.log("Removing QR observer")
		await this.page.evaluate(() => window.__mautrixController.removeQRObserver())
		await this.startObserving()
		this.log("Login complete")
	}

	/**
	 * Close the browser.
	 */
	async stop() {
		this.taskQueue.stop()
		if (this.page) {
			await this.page.close()
		}
		if (this.browser) {
			await this.browser.close()
		}
		this.log("Everything stopped")
	}

	/**
	 * Check if the session is currently logged in.
	 *
	 * @return {Promise<boolean>} - Whether or not the session is logged in.
	 */
	async isLoggedIn() {
		return await this.page.$("mw-main-container mws-conversations-list") !== null
	}

	async isPermanentlyDisconnected() {
		return await this.page.$("mw-unable-to-connect-container") !== null
	}

	async isDisconnected() {
		// TODO we should observe this banner appearing and disappearing to notify about disconnects
		return await this.page.$("mw-main-container mw-error-banner") !== null
	}

	/**
	 * Get the IDs of the most recent chats.
	 *
	 * @return {Promise<[ChatListInfo]>} - List of chat IDs in order of most recent message.
	 */
	async getRecentChats() {
		return await this.page.$eval("mws-conversations-list .conv-container",
			elem => window.__mautrixController.parseChatList(elem))
	}

	/**
	 * @typedef ChatInfo
	 * @type object
	 * @property {[Participant]} participants
	 * @property {boolean} readonly
	 */

	/**
	 * Get info about a chat.
	 *
	 * @param {number} id - The chat ID whose info to get.
	 * @return {Promise<ChatInfo>} - Info about the chat.
	 */
	async getChatInfo(id) {
		return await this.taskQueue.push(() => this._getChatInfoUnsafe(id))
	}

	/**
	 * Send a message to a chat.
	 *
	 * @param {number} chatID - The ID of the chat to send a message to.
	 * @param {string} text   - The text to send.
	 * @return {Promise<{id: number}>} - The ID of the sent message.
	 */
	async sendMessage(chatID, text) {
		return { id: await this.taskQueue.push(() => this._sendMessageUnsafe(chatID, text)) }
	}

	/**
	 * Get messages in a chat.
	 *
	 * @param {number} id The ID of the chat whose messages to get.
	 * @return {Promise<[MessageData]>} - The messages visible in the chat.
	 */
	async getMessages(id) {
		return this.taskQueue.push(async () => {
			const messages = await this._getMessagesUnsafe(id)
			if (messages.length > 0) {
				this.mostRecentMessages.set(id, messages[messages.length - 1].id)
			}
			for (const message of messages) {
				message.chat_id = id
			}
			return messages
		})
	}

	setLastMessageIDs(ids) {
		for (const [chatID, messageID] of Object.entries(ids)) {
			this.mostRecentMessages.set(+chatID, messageID)
		}
		this.log("Updated most recent message ID map:", this.mostRecentMessages)
	}

	async startObserving() {
		this.log("Adding chat list observer")
		await this.page.$eval("mws-conversations-list .conv-container",
			element => window.__mautrixController.addChatListObserver(element))
	}

	async stopObserving() {
		this.log("Removing chat list observer")
		await this.page.evaluate(() => window.__mautrixController.removeChatListObserver())
	}

	_listItemSelector(id) {
		return `mws-conversation-list-item > a.list-item[href="/web/conversations/${id}"]`
	}

	async _switchChatUnsafe(id) {
		this.log("Switching to chat", id)
		await this.page.click(this._listItemSelector(id))
	}

	async _getChatInfoUnsafe(id) {
		await this._switchChatUnsafe(id)
		await this.page.waitForSelector("mw-conversation-menu button", { timeout: 500 })
		await this.page.click("mw-conversation-menu button")
		await this.page.waitForSelector(".mat-menu-panel button.mat-menu-item.details",
			{ timeout: 500 })
		const readonly = await this.page.$("mw-conversation-container .compose-readonly") !== null
		// There's a 250ms animation and I don't know how to wait for it properly
		await sleep(250)
		await this.page.click(".mat-menu-panel button.mat-menu-item.details")
		await this.page.waitForSelector("mws-dialog mw-conversation-details .participants",
			{ timeout: 500 })
		const participants = await this.page.$eval(
			"mws-dialog mw-conversation-details .participants",
			elem => window.__mautrixController.parseParticipantList(elem))
		await this.page.click("mws-dialog mat-dialog-actions button.confirm")
		return {
			participants,
			readonly,
			...await this.page.$eval(this._listItemSelector(id),
				elem => window.__mautrixController.parseChatListItem(elem)),
		}
	}

	async _sendMessageUnsafe(chatID, text) {
		await this._switchChatUnsafe(chatID)
		await this.page.focus("mws-message-compose .input-box textarea")
		await this.page.keyboard.type(text)
		await this.page.click(".compose-container > mws-message-send-button > button")
		const id = await this.page.$eval("mws-message-wrapper.outgoing[msg-id^='tmp_']",
			elem => window.__mautrixController.waitForMessage(elem))
		this.log("Successfully sent message", id, "to", chatID)
		return id
	}

	async _getMessagesUnsafe(id, minID = 0) {
		await this._switchChatUnsafe(id)
		this.log("Waiting for messages to load")
		await this.page.waitFor("mws-message-wrapper")
		const messages = await this.page.$eval("mws-messages-list .content",
			element => window.__mautrixController.parseMessageList(element))
		return messages.filter(msg => msg.id > minID && !this.sentMessageIDs.has(msg.id))
	}

	async _processChatListChangeUnsafe(id) {
		this.updatedChats.delete(id)
		this.log("Processing change to", id)
		const lastMsgID = this.mostRecentMessages.get(id) || 0
		const messages = await this._getMessagesUnsafe(id, lastMsgID)
		if (messages.length === 0) {
			this.log("No new messages found in", id)
			return
		}
		const newFirstID = messages[0].id
		const newLastID = messages[messages.length - 1].id
		this.mostRecentMessages.set(id, newLastID)
		const range = newFirstID === newLastID ? newFirstID : `${newFirstID}-${newLastID}`
		this.log(`Loaded ${messages.length} messages in ${id} after ${lastMsgID}: got ${range}`)

		if (this.client) {
			for (const message of messages) {
				message.chat_id = id
				await this.client.sendMessage(message).catch(err =>
					this.error("Failed to send message", message.id, "to client:", err))
			}
		} else {
			this.log("No client connected, not sending messages")
		}
	}

	_receiveChatListChanges(changes) {
		this.log("Received chat list changes:", changes)
		for (const item of changes) {
			if (!this.updatedChats.has(item)) {
				this.updatedChats.add(item)
				this.taskQueue.push(() => this._processChatListChangeUnsafe(item))
					.catch(err => this.error("Error handling chat list changes:", err))
			}
		}
	}

	_receiveQRChange(url) {
		if (this.client) {
			this.client.sendQRCode(url).catch(err =>
				this.error("Failed to send new QR to client:", err))
		} else {
			this.log("No client connected, not sending new QR")
		}
	}
}
