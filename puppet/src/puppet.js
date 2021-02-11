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
	//static viewport = { width: 1920, height: 1080 }
	static url = undefined
	static extensionDir = 'extension_files'

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
	async start() {
		this.log("Launching browser")

		const extensionArgs = [
			`--disable-extensions-except=${MessagesPuppeteer.extensionDir}`,
			`--load-extension=${MessagesPuppeteer.extensionDir}`
		]

		this.browser = await puppeteer.launch({
			executablePath: MessagesPuppeteer.executablePath,
			userDataDir: this.profilePath,
			args: MessagesPuppeteer.noSandbox ? extensionArgs.concat("--no-sandbox") : extensionArgs,
			headless: false, // Needed to load extensions
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
		await this.page.setBypassCSP(true) // Needed to load content scripts
		await this._preparePage(true)

		this.log("Exposing functions")
		await this.page.exposeFunction("__mautrixReceiveQR", this._receiveQRChange.bind(this))
		await this.page.exposeFunction("__mautrixSendEmailCredentials", this._sendEmailCredentials.bind(this))
		await this.page.exposeFunction("__mautrixReceivePIN", this._receivePIN.bind(this))
		await this.page.exposeFunction("__mautrixExpiry", this._receiveExpiry.bind(this))
		/* TODO
		await this.page.exposeFunction("__mautrixReceiveMessageID",
			id => this.sentMessageIDs.add(id))
		await this.page.exposeFunction("__mautrixReceiveChanges",
			this._receiveChatListChanges.bind(this))
		await this.page.exposeFunction("__chronoParseDate", chrono.parseDate)
		*/

		// NOTE Must *always* re-login on a browser session, so no need to check if already logged in
		this.loginRunning = false
		this.loginCancelled = false
		this.taskQueue.start()
		this.log("Startup complete")
	}

	async _preparePage(navigateTo) {
		if (navigateTo) {
			await this.page.goto(MessagesPuppeteer.url)
		} else {
			await this.page.reload()
		}
		this.log("Injecting content script")
		await this.page.addScriptTag({ path: "./src/contentscript.js", type: "module" })
	}

	/**
	 * Wait for the session to be logged in and monitor changes while it's not.
	 */
	async waitForLogin(login_type, login_data) {
		if (await this.isLoggedIn()) {
			return
		}
		this.loginRunning = true
		this.loginCancelled = false

		const loginContentArea = await this.page.waitForSelector("#login_content")

		switch (login_type) {
		case "qr": {
			this.log("Running QR login")
			const qrButton = await this.page.waitForSelector("#login_qr_btn")
			await qrButton.click()

			const qrElement = await this.page.waitForSelector("#login_qrcode_area div[title]", {visible: true})
			const currentQR = await this.page.evaluate(element => element.title, qrElement)
			this._receiveQRChange(currentQR)

			await this.page.evaluate(
				element => window.__mautrixController.addQRChangeObserver(element), qrElement)
			await this.page.evaluate(
				element => window.__mautrixController.addQRAppearObserver(element), loginContentArea)

			break
		}
		case "email": {
			this.log("Running email login")
			if (!login_data) {
				this._sendLoginFailure("No login credentials provided for email login")
				return
			}

			const emailButton = await this.page.waitForSelector("#login_email_btn")
			await emailButton.click()

			await this.page.waitForSelector("#login_email_area", {visible: true})
			this.login_email = login_data["email"]
			this.login_password = login_data["password"]
			await this._sendEmailCredentials()

			await this.page.evaluate(
				element => window.__mautrixController.addEmailAppearObserver(element), loginContentArea)

			break
		}
		// TODO Phone number login
		default:
			this._sendLoginFailure(`Invalid login type: ${login_type}`)
			return
		}

		await this.page.evaluate(
			element => window.__mautrixController.addPINAppearObserver(element), loginContentArea)
		await this.page.$eval("#layer_contents",
			element => window.__mautrixController.addExpiryObserver(element))

		this.log("Waiting for login response")
		let doneWaiting = false
		let loginSuccess = false
		const cancelableResolve = (promiseFn) => {
			const executor = (resolve, reject) => {
				promiseFn().then(
					value => {
						doneWaiting = true
						resolve(value)
					},
					reason => {
						if (!doneWaiting) {
							setTimeout(executor, 1000, resolve, reject)
						} else {
							resolve()
						}
					}
				)
			}
			return new Promise(executor)
		}

		const result = await Promise.race([
			() => this.page.waitForSelector("#wrap_message_sync", {timeout: 2000})
				.then(value => {
					loginSuccess = true
					return value
				}),
			() => this.page.waitForSelector("#login_incorrect", {visible: true, timeout: 2000})
				.then(value => this.page.evaluate(element => element.innerText, value)),
			() => this._waitForLoginCancel(),
		].map(promiseFn => cancelableResolve(promiseFn)))

		this.log("Removing observers")
		await this.page.evaluate(() => window.__mautrixController.removeQRChangeObserver())
		await this.page.evaluate(() => window.__mautrixController.removeQRAppearObserver())
		await this.page.evaluate(() => window.__mautrixController.removeEmailAppearObserver())
		await this.page.evaluate(() => window.__mautrixController.removePINAppearObserver())
		await this.page.evaluate(() => window.__mautrixController.removeExpiryObserver())
		delete this.login_email
		delete this.login_password

		if (!loginSuccess) {
			this._sendLoginFailure(result)
			return
		}

		this.log("Waiting for sync")
		await this.page.waitForFunction(
			messageSyncElement => {
				const text = messageSyncElement.innerText
				return text == 'Syncing messages... 100%'
			},
			{},
			result)

		await this.startObserving()
		this.loginRunning = false
		this.log("Login complete")
	}

	/**
	 * Cancel an ongoing login attempt.
	 */
	async cancelLogin() {
		if (this.loginRunning) {
			this.loginCancelled = true
			await this._preparePage(false)
		}
	}

	_waitForLoginCancel() {
		return new Promise((resolve, reject) => {
			if (this.loginCancelled) {
				resolve()
			} else {
				reject()
			}
		})
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
		return await this.page.$("#wrap_message_sync") !== null
	}

	async isPermanentlyDisconnected() {
		// TODO
		//return await this.page.$("mw-unable-to-connect-container") !== null
		return false
	}

	async isOpenSomewhereElse() {
		/* TODO
		try {
			const text = await this.page.$eval("mws-dialog mat-dialog-content div",
				elem => elem.textContent)
			return text?.trim() === "Messages for web is open in more than one tab or browser"
		} catch (err) {
			return false
		}
		*/
		return false
	}

	async isDisconnected() {
		if (!await this.isLoggedIn()) {
			return true
		}
		/* TODO
		const offlineIndicators = await Promise.all([
			this.page.$("mw-main-nav mw-banner mw-error-banner"),
			this.page.$("mw-main-nav mw-banner mw-information-banner[title='Connecting']"),
			this.page.$("mw-unable-to-connect-container"),
			this.isOpenSomewhereElse(),
		])
		return offlineIndicators.some(indicator => Boolean(indicator))
		*/
		return false
	}

	/**
	 * Get the IDs of the most recent chats.
	 *
	 * @return {Promise<[ChatListInfo]>} - List of chat IDs in order of most recent message.
	 */
	async getRecentChats() {
		/* TODO
		return await this.page.$eval("mws-conversations-list .conv-container",
			elem => window.__mautrixController.parseChatList(elem))
		*/
		return null
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
		await this.page.$eval("#wrap_chat_list",
			element => window.__mautrixController.addChatListObserver(element))
	}

	async stopObserving() {
		this.log("Removing chat list observer")
		await this.page.evaluate(() => window.__mautrixController.removeChatListObserver())
	}

	_listItemSelector(id) {
		// TODO
		//return `mws-conversation-list-item > a.list-item[href="/web/conversations/${id}"]`
		return ''
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

	async _sendEmailCredentials() {
		this.log("Inputting login credentials")

		// Triple-click input fields to select all existing text and replace it on type
		let input

		input = await this.page.$("#line_login_email")
		await input.click({clickCount: 3})
		await input.type(this.login_email)

		input = await this.page.$("#line_login_pwd")
		await input.click({clickCount: 3})
		await input.type(this.login_password)

		await this.page.click("button#login_btn")
	}

	_receiveQRChange(url) {
		if (this.client) {
			this.client.sendQRCode(url).catch(err =>
				this.error("Failed to send new QR to client:", err))
		} else {
			this.log("No client connected, not sending new QR")
		}
	}

	_receivePIN(pin) {
		if (this.client) {
			this.client.sendPIN(`Your PIN is: ${pin}`).catch(err =>
				this.error("Failed to send new PIN to client:", err))
		} else {
			this.log("No client connected, not sending new PIN")
		}
	}

	_sendLoginFailure(reason) {
		this.error(`Login failure: ${reason ? reason : 'cancelled'}`)
		if (this.client) {
			this.client.sendFailure(reason).catch(err =>
				this.error("Failed to send failure reason to client:", err))
		} else {
			this.log("No client connected, not sending failure reason")
		}
	}

	async _receiveExpiry(button) {
		this.log("Something expired, clicking OK button to continue")
		await this.page.click(button)
	}
}
