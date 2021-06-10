// matrix-puppeteer-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
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
	static devtools = false
	static noSandbox = false
	static viewport = { width: 960, height: 880 }
	static url = undefined
	static extensionDir = "extension_files"

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
		this.numChatNotifications = new Map()
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

		let extensionArgs = [
			`--disable-extensions-except=${MessagesPuppeteer.extensionDir}`,
			`--load-extension=${MessagesPuppeteer.extensionDir}`
		]
		if (MessagesPuppeteer.noSandbox) {
			extensionArgs = extensionArgs.concat(`--no-sandbox`)
		}

		this.browser = await puppeteer.launch({
			executablePath: MessagesPuppeteer.executablePath,
			userDataDir: this.profilePath,
			args: extensionArgs,
			headless: false, // Needed to load extensions
			defaultViewport: MessagesPuppeteer.viewport,
			devtools: MessagesPuppeteer.devtools,
			timeout: 0,
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
		await this.page.exposeFunction("__mautrixReceiveMessageID",
			id => this.sentMessageIDs.add(id))
		await this.page.exposeFunction("__mautrixReceiveChanges",
			this._receiveChatListChanges.bind(this))
		await this.page.exposeFunction("__mautrixReceiveMessages",
			this._receiveMessages.bind(this))
		await this.page.exposeFunction("__mautrixReceiveReceiptDirectLatest",
			this._receiveReceiptDirectLatest.bind(this))
		await this.page.exposeFunction("__mautrixReceiveReceiptMulti",
			this._receiveReceiptMulti.bind(this))
		await this.page.exposeFunction("__mautrixLoggedOut",
			this._onLoggedOut.bind(this))
		await this.page.exposeFunction("__chronoParseDate", chrono.parseDate)

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
		default:
			this._sendLoginFailure(`Invalid login type: ${login_type}`)
			return
		}

		await this.page.evaluate(
			element => window.__mautrixController.addPINAppearObserver(element), loginContentArea)

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
			() => this.page.waitForSelector("#mainApp:not(.MdNonDisp)", {timeout: 2000})
				.then(value => {
					loginSuccess = true
					return value
				}),
			() => this.page.waitForSelector("#login_incorrect", {visible: true, timeout: 2000})
				.then(value => this.page.evaluate(element => element?.innerText, value)),
			() => this._waitForLoginCancel(),
		].map(promiseFn => cancelableResolve(promiseFn)))

		this.log("Removing observers")
		// TODO __mautrixController is undefined when cancelling, why?
		await this.page.evaluate(ownID => window.__mautrixController.setOwnID(ownID), this.id)
		await this.page.evaluate(() => window.__mautrixController.removeQRChangeObserver())
		await this.page.evaluate(() => window.__mautrixController.removeQRAppearObserver())
		await this.page.evaluate(() => window.__mautrixController.removeEmailAppearObserver())
		await this.page.evaluate(() => window.__mautrixController.removePINAppearObserver())
		delete this.login_email
		delete this.login_password

		const messageSyncElement = loginSuccess ? await this.page.waitForSelector("#wrap_message_sync") : null
		if (!loginSuccess || !messageSyncElement) {
			this._sendLoginFailure(result)
			return
		}

		this._sendLoginSuccess()
		this.log("Waiting for sync")
		try {
			await this.page.waitForFunction(
				messageSyncElement => {
					const text = messageSyncElement.innerText
					return text.startsWith("Syncing messages...")
						&& (text.endsWith("100%") || text.endsWith("NaN%"))
						// TODO Sometimes it gets stuck at 99%...??
				},
				{timeout: 10000}, // Assume 10 seconds is long enough
				messageSyncElement)
		} catch (err) {
			//this._sendLoginFailure(`Failed to sync: ${err}`)
			this.log("LINE's sync took too long, assume it's fine and carry on...")
		} finally {
			const syncText = await messageSyncElement.evaluate(e => e.innerText)
			this.log(`Final sync text is: "${syncText}"`)
		}

		this.loginRunning = false
		// Don't start observing yet, instead wait for explicit request.
		// But at least view the most recent chat.
		try {
			const mostRecentChatID = await this.page.$eval("#_chat_list_body li",
				element => window.__mautrixController.getChatListItemID(element.firstElementChild))
			await this._switchChat(mostRecentChatID)
		} catch (e) {
			this.log("No chats available to focus on")
		}
		this.log("Login complete")
	}

	/**
	 * Cancel an ongoing login attempt.
	 */
	async cancelLogin() {
		if (this.loginRunning) {
			this.loginRunning = false
			this.loginCancelled = true
			await this._preparePage(false)
		}
	}

	_waitForLoginCancel() {
		return new Promise((resolve, reject) => {
			if (this.loginCancelled) {
				this.loginCancelled = false
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
		const selectors = [
			"#mainApp:not(.MdNonDisp)",
			"#wrap_message_sync",
			"#_chat_list_body",
		]
		for (const selector of selectors) {
			if (await this.page.$(selector) == null) {
				return false
			}
		}
		return true
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
		return await this.taskQueue.push(() =>
			this.page.evaluate(() => window.__mautrixController.parseChatList()))
	}

	/**
	 * @typedef ChatInfo
	 * @type object
	 * @property {[Participant]} participants
	 */

	/**
	 * Get info about a chat.
	 *
	 * @param {string} chatID - The chat ID whose info to get.
	 * @return {Promise<ChatInfo>} - Info about the chat.
	 */
	async getChatInfo(chatID) {
		return await this.taskQueue.push(() => this._getChatInfoUnsafe(chatID))
	}

	/**
	 * Send a message to a chat.
	 *
	 * @param {string} chatID - The ID of the chat to send a message to.
	 * @param {string} text   - The text to send.
	 * @return {Promise<{id: number}>} - The ID of the sent message.
	 */
	async sendMessage(chatID, text) {
		return { id: await this.taskQueue.push(() => this._sendMessageUnsafe(chatID, text)) }
	}

	/**
	 * Get messages in a chat.
	 *
	 * @param {string} chatID The ID of the chat whose messages to get.
	 * @return {Promise<[MessageData]>} - The messages visible in the chat.
	 */
	async getMessages(chatID) {
		return await this.taskQueue.push(async () => this._getMessagesUnsafe(chatID))
	}

	setLastMessageIDs(ids) {
		this.mostRecentMessages.clear()
		for (const [chatID, messageID] of Object.entries(ids)) {
			this.mostRecentMessages.set(chatID, messageID)
		}
		this.log("Updated most recent message ID map:")
		this.log(JSON.stringify(this.mostRecentMessages))
	}

	async readImage(imageUrl) {
		return await this.taskQueue.push(() =>
			this.page.evaluate(
				url => window.__mautrixController.readImage(url),
				imageUrl))
	}

	async sendFile(chatID, filePath) {
		return { id: await this.taskQueue.push(() => this._sendFileUnsafe(chatID, filePath)) }
	}

	async startObserving() {
		const chatID = await this.page.evaluate(() => window.__mautrixController.getCurrentChatID())
		this.log(`Adding observers for ${chatID || "empty chat"}`)
		await this.page.evaluate(
			() => window.__mautrixController.addChatListObserver())
		if (chatID) {
			await this.page.evaluate(
				(mostRecentMessage) => window.__mautrixController.addMsgListObserver(mostRecentMessage),
				this.mostRecentMessages.get(chatID))
		}
	}

	async stopObserving() {
		this.log("Removing observers")
		await this.page.evaluate(
			() => window.__mautrixController.removeChatListObserver())
		await this.page.evaluate(
			() => window.__mautrixController.removeMsgListObserver())
	}

	_listItemSelector(id) {
		return `#_chat_list_body div[data-chatid="${id}"]`
	}

	async _switchChat(chatID) {
		// TODO Allow passing in an element directly
		this.log(`Switching to chat ${chatID}`)
		const chatListItem = await this.page.$(this._listItemSelector(chatID))

		const chatName = await chatListItem.evaluate(
			element => window.__mautrixController.getChatListItemName(element))

		const isCorrectChatVisible = (targetText) => {
			const chatHeader = document.querySelector("#_chat_header_area > .mdRGT04Link")
			if (!chatHeader) return false
			const chatHeaderTitleElement = chatHeader.querySelector(".mdRGT04Ttl")
			return chatHeaderTitleElement.innerText == targetText
		}

		if (await this.page.evaluate(isCorrectChatVisible, chatName)) {
			this.log("Already viewing chat, no need to switch")
		} else {
			this.log("Ensuring msg list observer is removed")
			const hadMsgListObserver = await this.page.evaluate(
				() => window.__mautrixController.removeMsgListObserver())
			this.log(hadMsgListObserver ? "Observer was already removed" : "Removed observer")

			await chatListItem.click()
			this.log(`Waiting for chat header title to be "${chatName}"`)
			await this.page.waitForFunction(
				isCorrectChatVisible,
				{polling: "mutation"},
				chatName)

			// Always show the chat details sidebar, as this makes life easier
			this.log("Waiting for detail area to be auto-hidden upon entering chat")
			await this.page.waitForFunction(
				detailArea => detailArea.childElementCount == 0,
				{},
				await this.page.$("#_chat_detail_area"))
			this.log("Clicking chat header to show detail area")
			await this.page.click("#_chat_header_area > .mdRGT04Link")
			this.log("Waiting for detail area")
			await this.page.waitForSelector("#_chat_detail_area > .mdRGT02Info")

			if (hadMsgListObserver) {
				this.log("Restoring msg list observer")
				await this.page.evaluate(
					(mostRecentMessage) => window.__mautrixController.addMsgListObserver(mostRecentMessage),
					this.mostRecentMessages.get(chatID))
			} else {
				this.log("Not restoring msg list observer, as there never was one")
			}
		}
	}

	async _getChatInfoUnsafe(chatID) {
		const chatListInfo = await this.page.$eval(this._listItemSelector(chatID),
			(element, chatID) => window.__mautrixController.parseChatListItem(element, chatID),
			chatID)

		let [isDirect, isGroup, isRoom] = [false,false,false]
		switch (chatID.charAt(0)) {
		case "u":
			isDirect = true
			break
		case "c":
			isGroup = true
			break
		case "r":
			isRoom = true
			break
		}

		let participants
		if (!isDirect) {
			this.log("Found multi-user chat, so viewing it to get participants")
			// TODO This will mark the chat as "read"!
			await this._switchChat(chatID)
			const participantList = await this.page.$("#_chat_detail_area > .mdRGT02Info ul.mdRGT13Ul")
			// TODO Is a group not actually created until a message is sent(?)
			//      If so, maybe don't create a portal until there is a message.
			participants = await participantList.evaluate(
				element => window.__mautrixController.parseParticipantList(element))
		} else {
			this.log(`Found direct chat with ${chatID}`)
			//const chatDetailArea = await this.page.waitForSelector("#_chat_detail_area > .mdRGT02Info")
			//await chatDetailArea.$(".MdTxtDesc02") || // 1:1 chat with custom title - get participant's real name
			participants = [{
				id: chatID,
				avatar: chatListInfo.icon,
				name: chatListInfo.name,
			}]
		}

		this.log("Found participants:")
		for (const participant of participants) {
			this.log(JSON.stringify(participant))
		}
		return {participants, ...chatListInfo}
	}

	// TODO Catch "An error has occurred" dialog
	//      Selector is just "dialog", then "button"
	//      Child of "#layer_contents"
	//      Always present, just made visible via classes

	async _sendMessageUnsafe(chatID, text) {
		// Sync all messages in this chat first
		this._receiveMessages(chatID, await this._getMessagesUnsafe(chatID), true)
		// TODO Initiate the promise in the content script
		await this.page.evaluate(
			() => window.__mautrixController.promiseOwnMessage(5000, "time"))

		const input = await this.page.$("#_chat_room_input")
		await input.click()
		await input.type(text)
		await input.press("Enter")

		return await this._waitForSentMessage(chatID)
	}

	async _sendFileUnsafe(chatID, filePath) {
		this._receiveMessages(chatID, await this._getMessagesUnsafe(chatID), true)
		await this.page.evaluate(
			() => window.__mautrixController.promiseOwnMessage(
				10000, // Use longer timeout for file uploads
				"#_chat_message_success_menu",
				"#_chat_message_fail_menu"))

		try {
			this.log(`About to ask for file chooser in ${chatID}`)
			const [fileChooser] = await Promise.all([
				this.page.waitForFileChooser(),
				this.page.click("#_chat_room_plus_btn")
			])
			this.log(`About to upload ${filePath}`)
			await fileChooser.accept([filePath])
		} catch (e) {
			this.log(`Failed to upload file to ${chatID}`)
			return -1
		}

		return await this._waitForSentMessage(chatID)
	}

	async _waitForSentMessage(chatID) {
		try {
			this.log("Waiting for message to be sent")
			const id = await this.page.evaluate(
				() => window.__mautrixController.waitForOwnMessage())
			this.log(`Successfully sent message ${id} to ${chatID}`)
			return id
		} catch (e) {
			// TODO Catch if something other than a timeout
			this.error(`Timed out sending message to ${chatID}`)
			// TODO Figure out why e is undefined...
			//this.error(e)
			return -1
		}
	}

	_receiveMessages(chatID, messages, skipProcessing = false) {
		if (this.client) {
			if (!skipProcessing) {
				messages = this._processMessages(chatID, messages)
			}
			for (const message of messages) {
				this.client.sendMessage(message).catch(err =>
					this.error("Failed to send message", message.id, "to client:", err))
			}
		} else {
			this.log("No client connected, not sending messages")
		}
	}

	async _getMessagesUnsafe(chatID) {
		// TODO Consider making a wrapper for pausing/resuming the msg list observers
		this.log("Ensuring msg list observer is removed")
		const hadMsgListObserver = await this.page.evaluate(
			() => window.__mautrixController.removeMsgListObserver())
		this.log(hadMsgListObserver ? "Observer was already removed" : "Removed observer")

		// TODO Handle unloaded messages. Maybe scroll up
		// TODO This will mark the chat as "read"!
		await this._switchChat(chatID)
		// TODO Is it better to reset the notification count in _switchChat instead of here?
		this.numChatNotifications.set(chatID, 0)
		let messages = await this.page.evaluate(
			mostRecentMessage => window.__mautrixController.parseMessageList(mostRecentMessage),
			this.mostRecentMessages.get(chatID))
		// Doing this before restoring the observer since it updates minID
		messages = this._processMessages(chatID, messages)

		if (hadMsgListObserver) {
			this.log("Restoring msg list observer")
			await this.page.evaluate(
				mostRecentMessage => window.__mautrixController.addMsgListObserver(mostRecentMessage),
				this.mostRecentMessages.get(chatID))
		} else {
			this.log("Not restoring msg list observer, as there never was one")
		}

		return messages
	}

	_processMessages(chatID, messages) {
		// TODO Probably don't need minID filtering if Puppeteer context handles it now
		const minID = this.mostRecentMessages.get(chatID) || 0
		const filteredMessages = messages.filter(msg => msg.id > minID && !this.sentMessageIDs.has(msg.id))

		if (filteredMessages.length > 0) {
			const newFirstID = filteredMessages[0].id
			const newLastID = filteredMessages[filteredMessages.length - 1].id
			this.mostRecentMessages.set(chatID, newLastID)
			const range = newFirstID === newLastID ? newFirstID : `${newFirstID}-${newLastID}`
			this.log(`Loaded ${messages.length} messages in ${chatID}, got ${filteredMessages.length} newer than ${minID} (${range})`)
			for (const message of filteredMessages) {
				message.chat_id = chatID
			}
			return filteredMessages
		} else {
			return []
		}
	}

	async _processChatListChangeUnsafe(chatListInfo) {
		const chatID = chatListInfo.id
		this.updatedChats.delete(chatID)
		this.log("Processing change to", chatID)
		// TODO Also process name/icon changes

		const prevNumNotifications = this.numChatNotifications.get(chatID) || 0
		const diffNumNotifications = chatListInfo.notificationCount - prevNumNotifications

		if (chatListInfo.notificationCount == 0 && diffNumNotifications < 0) {
			// Message was read from another LINE client, so there's no new info to bridge.
			// But if the diff == 0, it's an own message sent from LINE, and must bridge it!
			this.numChatNotifications.set(chatID, 0)
			return
		}

		const mustSync =
			// Can only use previews for DMs, because sender can't be found otherwise!
			   chatListInfo.id.charAt(0) != 'u'
			|| diffNumNotifications > 1
			// Sync when lastMsg is a canned message for a non-previewable message type.
			|| chatListInfo.lastMsg.endsWith(" sent a photo.")
			|| chatListInfo.lastMsg.endsWith(" sent a sticker.")
			|| chatListInfo.lastMsg.endsWith(" sent a location.")
			// TODO More?
		// TODO With MSC2409, only sync if >1 new messages arrived,
		//      or if message is unpreviewable.
		//      Otherwise, send a dummy notice & sync when its read.

		let messages
		if (!mustSync) {
			messages = [{
				chat_id: chatListInfo.id,
				id: null, // because sidebar messages have no ID
				timestamp: null, // because this message was sent right now
				is_outgoing: chatListInfo.notificationCount == 0,
				sender: null, // because only DM messages are handled
				html: chatListInfo.lastMsg,
			}]
			this.numChatNotifications.set(chatID, chatListInfo.notificationCount)
		} else {
			messages = await this._getMessagesUnsafe(chatListInfo.id)
			this.numChatNotifications.set(chatID, 0)
			if (messages.length === 0) {
				this.log("No new messages found in", chatListInfo.id)
				return
			}
		}

		if (this.client) {
			for (const message of messages) {
				await this.client.sendMessage(message).catch(err =>
					this.error("Failed to send message", message.id || "with no ID", "to client:", err))
			}
		} else {
			this.log("No client connected, not sending messages")
		}
	}

	_receiveChatListChanges(changes) {
		this.log(`Received chat list changes: ${changes.map(item => item.id)}`)
		for (const item of changes) {
			if (!this.updatedChats.has(item.id)) {
				this.updatedChats.add(item.id)
				this.taskQueue.push(() => this._processChatListChangeUnsafe(item))
					.catch(err => this.error("Error handling chat list changes:", err))
			}
		}
	}

	_receiveReceiptDirectLatest(chat_id, receipt_id) {
		this.log(`Received read receipt ${receipt_id} for chat ${chat_id}`)
		if (this.client) {
			this.client.sendReceipt({chat_id: chat_id, id: receipt_id})
				.catch(err => this.error("Error handling read receipt:", err))
		} else {
			this.log("No client connected, not sending receipts")
		}
	}

	async _receiveReceiptMulti(chat_id, receipts) {
		// Use async to ensure that receipts are sent in order
		this.log(`Received bulk read receipts for chat ${chat_id}:`, receipts)
		if (this.client) {
			for (const receipt of receipts) {
				receipt.chat_id = chat_id
				try {
					await this.client.sendReceipt(receipt)
				} catch(err) {
					this.error("Error handling read receipt:", err)
				}
			}
		} else {
			this.log("No client connected, not sending receipts")
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
			this.client.sendPIN(pin).catch(err =>
				this.error("Failed to send new PIN to client:", err))
		} else {
			this.log("No client connected, not sending new PIN")
		}
	}

	_sendLoginSuccess() {
		this.error("Login success")
		if (this.client) {
			this.client.sendLoginSuccess().catch(err =>
				this.error("Failed to send login success to client:", err))
		} else {
			this.log("No client connected, not sending login success")
		}
	}

	_sendLoginFailure(reason) {
		this.loginRunning = false
		this.error(`Login failure: ${reason ? reason : "cancelled"}`)
		if (this.client) {
			this.client.sendLoginFailure(reason).catch(err =>
				this.error("Failed to send login failure to client:", err))
		} else {
			this.log("No client connected, not sending login failure")
		}
	}

	_onLoggedOut() {
		this.log("Got logged out!")
		this.stopObserving()
		if (this.client) {
			this.client.sendLoggedOut().catch(err =>
				this.error("Failed to send logout notice to client:", err))
		} else {
			this.log("No client connected, not sending logout notice")
		}
	}
}
