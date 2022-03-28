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
import process from "process"
import path from "path"
import { exec, execSync } from "child_process"

import puppeteer from "puppeteer"
import chrono from "chrono-node"

import TaskQueue from "./taskqueue.js"
import { sleep } from "./util.js"

export default class MessagesPuppeteer {
	static profileDir = "./profiles"
	static executablePath = undefined
	static cycleDelay = 5000
	static useXdotool = false
	static jiggleDelay = 30000
	static devtools = false
	static noSandbox = false
	static viewport = { width: 960, height: 840 }
	static url = undefined
	static extensionDir = "extension_files"

	/**
	 *
	 * @param {string} id
	 * @param {?Client} [client]
	 */
	constructor(id, ownID, sendPlaceholders, client = null) {
		let profilePath = path.join(MessagesPuppeteer.profileDir, id)
		if (!profilePath.startsWith("/")) {
			profilePath = path.join(process.cwd(), profilePath)
		}
		this.id = id
		this.ownID = ownID
		this.windowID = null
		this.sendPlaceholders = sendPlaceholders
		this.profilePath = profilePath
		this.updatedChats = new Set()
		this.mostRecentMessages = new Map()
		this.mostRecentOwnMessages = new Map()
		this.mostRecentReceipts = new Map()
		this.numChatNotifications = new Map()
		this.cycleTimerID = null
		this.jiggleTimerID = null
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

		const args = [
			`--disable-extensions-except=${MessagesPuppeteer.extensionDir}`,
			`--load-extension=${MessagesPuppeteer.extensionDir}`,
			`--window-size=${MessagesPuppeteer.viewport.width},${MessagesPuppeteer.viewport.height+120}`,
		]
		if (MessagesPuppeteer.noSandbox) {
			args = args.concat(`--no-sandbox`)
		}

		this.browser = await puppeteer.launch({
			executablePath: MessagesPuppeteer.executablePath,
			userDataDir: this.profilePath,
			args: args,
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

		{
			this.log("Finding extension UUID")
			await this.page.goto("chrome://system")
			const selector = "#extensions-value"
			await this.page.waitForSelector(selector, 0)
			const lineDetails = await this.page.$eval(selector, e => e.innerText)
			const uuid = lineDetails.match(/(.*) : LINE : version/)[1]
			this.log(`Found extension UUID ${uuid}`)
			MessagesPuppeteer.url = `chrome-extension://${uuid}/index.html`
		}

		this.blankPage = await this.browser.newPage()
		if (MessagesPuppeteer.useXdotool) {
			this.log("Finding window ID")
			const buffer = execSync("xdotool search 'about:blank'")
			this.windowID = Number.parseInt(buffer)
			this.log(`Found window ID ${this.windowID}`)
		}

		this.log(`Opening ${MessagesPuppeteer.url}`)
		await this.page.setBypassCSP(true) // Needed to load content scripts
		await this._preparePage(true)

		this.log("Exposing functions")
		await this.page.exposeFunction("__mautrixLog", this.log.bind(this))
		await this.page.exposeFunction("__mautrixError", this.error.bind(this))
		await this.page.exposeFunction("__mautrixReceiveQR", this._receiveQRChange.bind(this))
		await this.page.exposeFunction("__mautrixSendEmailCredentials", this._sendEmailCredentials.bind(this))
		await this.page.exposeFunction("__mautrixReceivePIN", this._receivePIN.bind(this))
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
		await this.page.bringToFront()
		if (navigateTo) {
			await this.page.goto(MessagesPuppeteer.url)
		} else {
			await this.page.reload()
		}
		this.log("Injecting content script")
		await this.page.addScriptTag({ path: "./src/contentscript.js", type: "module" })
	}

	async _interactWithPage(promiser) {
		await this.page.bringToFront()
		try {
			await promiser()
		} catch (e) {
			this.error(`Error while interacting with page: ${e}`)
			throw e
		} finally {
			await this.blankPage.bringToFront()
		}
	}

	async _retryUntilSuccess(numTries, failMessage, fn, ...args) {
		while (true) {
			try {
				await fn(...args)
				return
			} catch (e) {
				if (numTries && --numTries == 0) {
					throw e
				} else if (failMessage) {
					this.log(failMessage)
				}
			}
		}
	}

	/**
	 * Set the contents of a text input field to the given text.
	 * Works by triple-clicking the input field to select all existing text, to replace it on type.
	 *
	 * @param {ElementHandle} inputElement - The input element to type into.
	 * @param {string} text                - The text to input.
	 */
	async _enterText(inputElement, text) {
		await inputElement.click({clickCount: 3})
		await inputElement.type(text)
	}

	/**
	 * Wait for the session to be logged in and monitor changes while it's not.
	 */
	async waitForLogin(login_type, login_data) {
		if (await this.isLoggedIn()) {
			return
		}
		this.loginRunning = true
		await this.page.bringToFront()

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

		if (!this.loginCancelled) {
			this.log("Removing observers")
			// TODO __mautrixController is undefined when cancelling, why?
			await this.page.evaluate(ownID => window.__mautrixController.setOwnID(ownID), this.ownID)
			await this.page.evaluate(() => window.__mautrixController.removeQRChangeObserver())
			await this.page.evaluate(() => window.__mautrixController.removeQRAppearObserver())
			await this.page.evaluate(() => window.__mautrixController.removeEmailAppearObserver())
			await this.page.evaluate(() => window.__mautrixController.removePINAppearObserver())
		} else {
			this.loginCancelled = false
		}
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
		await this.blankPage.bringToFront()
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
		this.stopObserving()
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
		if (!this.page) {
			return false
		}
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
	 * Get all contacts in the Friends list.
	 *
	 * @return {Promise<Participant[]>}
	 */
	async getContacts() {
		return await this.taskQueue.push(() =>
			this.page.evaluate(() => window.__mautrixController.parseFriendsList()))
	}

	/**
	 * Get the IDs of the most recent chats.
	 *
	 * @return {Promise<ChatListInfo[]>} - List of chat IDs in order of most recent message.
	 */
	async getRecentChats() {
		return await this.taskQueue.push(async () => {
			await this._visitJoinedNonrecentGroups()
			return await this.page.evaluate(() => window.__mautrixController.parseChatList())
		})
	}

	/**
	 * Visit all groups that aren't in the list of recent chats.
	 * Doing so will put them in that list, so they will be included in syncs.
	 *
	 * TODO Instead of visiting the groups, just sync the groups' metadata, and
	 *      lazy-create portals for them via GET /_matrix/app/v1/rooms/{roomAlias}.
	 *      But that requires portals to have an alias! Use the chat ID for that.
	 */
	async _visitJoinedNonrecentGroups() {
		// Group list is only populated once it's viewed!
		await this.page.$eval("#leftSide li[data-type=groups_list] > button", e => e.click())
		await this.page.waitForSelector("#wrap_group_list > div.MdScroll")

		const groupIDs = await this.page.evaluate(() => window.__mautrixController.getJoinedNonrecentGroupIDs())
		for (const groupID of groupIDs) {
			await this._switchChat(groupID)
		}

		await this.page.$eval("#leftSide li[data-type=chats_list] > button", e => e.click())
	}

	/**
	 * @typedef ChatInfo
	 * @type object
	 * @property {Participant[]} participants
	 */

	/**
	 * Get info about a chat.
	 *
	 * @param {string} chatID - The chat ID whose info to get.
	 * @param {boolean} forceView - Whether the LINE tab should always be viewed, even if the chat is already active.
	 * @return {Promise<ChatInfo>} - Info about the chat.
	 */
	async getChatInfo(chatID, forceView) {
		return await this.taskQueue.push(() => this._getChatInfoUnsafe(chatID, forceView))
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
	 * @return {Promise<ChatEvents>} - New messages and receipts synced fron the chat.
	 */
	async getMessages(chatID) {
		return await this.taskQueue.push(() => this._getMessagesUnsafe(chatID))
	}

	setLastMessageIDs(msgIDs, ownMsgIDs, rctIDs) {
		this.mostRecentMessages.clear()
		for (const [chatID, messageID] of Object.entries(msgIDs)) {
			this.mostRecentMessages.set(chatID, messageID)
		}
		this.log("Updated most recent message ID map:")
		this.log(JSON.stringify(msgIDs))

		for (const [chatID, messageID] of Object.entries(ownMsgIDs)) {
			this.mostRecentOwnMessages.set(chatID, messageID)
		}
		this.log("Updated most recent own message ID map:")
		this.log(JSON.stringify(ownMsgIDs))

		this.mostRecentReceipts.clear()
		for (const [chatID, receipts] of Object.entries(rctIDs)) {
			const receiptMap = this._getReceiptMap(chatID)
			for (const [count, receiptID] of Object.entries(receipts)) {
				receiptMap.set(+count, receiptID)
			}
		}
		this.log("Updated most recent receipt ID map")
		for (const [chatID, receiptMap] of this.mostRecentReceipts) {
			this.log(`${chatID}:`)
			for (const [count, receiptID] of receiptMap) {
				this.log(`Read by ${count}: ${receiptID}`)
			}
		}
	}

	forgetChat(chatID) {
		this.mostRecentMessages.delete(chatID)
		this.mostRecentOwnMessages.delete(chatID)
		this.mostRecentReceipts.delete(chatID)
		// TODO Delete chat from recents list
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

	_cycleTimerStart() {
		if (MessagesPuppeteer.cycleDelay < 0) {
			this.log("Chat cycling disabled")
			return
		}

		this.cycleTimerID = setTimeout(
			() => this.taskQueue.push(() => this._cycleChatUnsafe()),
			MessagesPuppeteer.cycleDelay)
	}

	async _cycleChatUnsafe() {
		this.log("Cycling chats")
		const initialID = this.cycleTimerID

		const currentChatID = await this.page.evaluate(() => window.__mautrixController.getCurrentChatID())
		const chatList = await this.page.evaluate(() => window.__mautrixController.parseChatListForCycle())
		// Add 1 to start at the chat after the currently-viewed one
		const offset = 1 + Math.max(chatList.findIndex(item => item.id == currentChatID), 0)

		// Visit next chat for which:
		// - there are no unread notifications
		// - the most recently-sent own message is not fully read
		let chatIDToSync
		for (let i = 0, n = chatList.length; i < n; i++) {
			const chatListItem = chatList[(i+offset) % n]

			if (chatListItem.notificationCount > 0) {
				// Chat has unread notifications, so don't view it
				continue
			}

			if (chatListItem.otherParticipantCount == 0) {
				// Chat has no other participants (must be a non-DM with only you), so nothing to sync
				continue
			}

			const mostRecentOwnMsgID = this.mostRecentOwnMessages.get(chatListItem.id)
			if (mostRecentOwnMsgID == undefined) {
				// Chat doesn't have any own messages, so no need to view it
				continue
			}

			const receiptMap = this._getReceiptMap(chatListItem.id)
			const mostRecentFullyReadMsgID = receiptMap.get(chatListItem.otherParticipantCount)
			if (mostRecentFullyReadMsgID == mostRecentOwnMsgID) {
				// Latest own message is fully-read, nothing to see here, move along
				continue
			}

			chatIDToSync = chatListItem.id
			this.log(`Viewing chat ${chatIDToSync} to check for new read receipts`)
			await this._syncChat(chatIDToSync)
			break
		}

		if (!chatIDToSync) {
			this.log("Found no chats in need of read receipt updates")
		}

		if (this.cycleTimerID == initialID) {
			this._cycleTimerStart()
		}
	}

	/**
	 * Jiggle the mouse periodically.
	 * Have to do this to keep the LINE extension "awake". Ridiculous, but necessary...
	 */
	_jiggleTimerStart() {
		this.jiggleTimerID = setTimeout(() => this._jiggleMouse(), MessagesPuppeteer.jiggleDelay)
	}

	_jiggleMouse() {
		const initialID = this.jiggleTimerID

		exec(`xdotool mousemove --sync --window ${this.windowID} 0 0`, {},
		(error, stdout, stderr) => {
			if (error) {
				this.log(`Error while jiggling mouse: ${error}`)
			}

			if (this.jiggleTimerID == initialID) {
				this._jiggleTimerStart()
			}
		})
	}

	async startObserving() {
		// TODO Highly consider syncing anything that was missed since stopObserving...
		const chatID = await this.page.evaluate(() => window.__mautrixController.getCurrentChatID())
		this.log(`Adding observers for ${chatID || "empty chat"}, and global timers`)
		await this.page.evaluate(
			() => window.__mautrixController.addChatListObserver())
		if (chatID) {
			await this.page.evaluate(
				(mostRecentMessage) => window.__mautrixController.addMsgListObserver(mostRecentMessage),
				this.mostRecentMessages.get(chatID))
		}

		if (this.cycleTimerID == null) {
			this._cycleTimerStart()
		}
		if (MessagesPuppeteer.useXdotool && this.jiggleTimerID == null) {
			this._jiggleTimerStart()
		}
	}

	async stopObserving() {
		this.log("Removing observers and timers")
		await this.page.evaluate(
			() => window.__mautrixController.removeChatListObserver())
		await this.page.evaluate(
			() => window.__mautrixController.removeMsgListObserver())

		if (this.cycleTimerID != null) {
			clearTimeout(this.cycleTimerID)
			this.cycleTimerID = null
		}
		if (this.jiggleTimerID != null) {
			clearTimeout(this.jiggleTimerID)
			this.jiggleTimerID = null
		}
	}

	async getOwnProfile() {
		return await this.taskQueue.push(() => this._getOwnProfileUnsafe())
	}

	async _getOwnProfileUnsafe() {
		// NOTE Will send a read receipt if a chat was in view!
		//      Best to use this on startup when no chat is viewed.
		let ownProfile
		await this._interactWithPage(async () => {
			this.log("Opening settings view")
			await this.page.click("button.mdGHD01SettingBtn")
			await this.page.waitForSelector("#context_menu li#settings", {visible: true}).then(e => e.click())
			await this.page.waitForSelector("#settings_contents", {visible: true})

			this.log("Getting own profile info")
			ownProfile = {
				id: this.ownID,
				name: await this.page.$eval("#settings_basic_name_input", e => e.innerText),
				avatar: {
					path: null,
					url: await this.page.$eval(".mdCMN09ImgInput", e => {
						const imgStr = e.style?.getPropertyValue("background-image")
						const matches = imgStr.match(/url\("(blob:.*)"\)/)
						return matches?.length == 2 ? matches[1] : null
					}),
				},
			}

			const backSelector = "#label_setting button"
			await this.page.click(backSelector)
			await this.page.waitForSelector(backSelector, {visible: false})
		})
		return ownProfile
	}

	_chatItemSelector(id) {
		return `#_chat_list_body div[data-chatid="${id}"]`
	}

	_friendItemSelector(id) {
		return `#contact_wrap_friends > ul > li[data-mid="${id}"]`
	}

	_groupItemSelector(id) {
		return `#joined_group_list_body > li[data-chatid="${id}"]`
	}

	async _switchChat(chatID, forceView = false) {
		// TODO Allow passing in an element directly
		this.log(`Switching to chat ${chatID}`)
		let chatItem = await this.page.$(this._chatItemSelector(chatID))

		let chatName
		if (!!chatItem) {
			chatName = await chatItem.evaluate(
				element => window.__mautrixController.getChatListItemName(element))
		}

		const isCorrectChatVisible = (targetText) => {
			const chatHeader = document.querySelector("#_chat_header_area > .mdRGT04Link")
			if (!chatHeader) return false
			const chatHeaderTitleElement = chatHeader.querySelector(".mdRGT04Ttl")
			return chatHeaderTitleElement.innerText == targetText
		}

		if (!!chatItem && await this.page.evaluate(isCorrectChatVisible, chatName)) {
			if (!forceView) {
				this.log("Already viewing chat, no need to switch")
			} else {
				await this._interactWithPage(async () => {
					this.log("Already viewing chat, but got request to view it")
					this.page.waitForTimeout(500)
				})
			}
		} else {
			this.log("Ensuring msg list observer is removed")
			const hadMsgListObserver = await this.page.evaluate(
				() => window.__mautrixController.removeMsgListObserver())
			this.log(hadMsgListObserver ? "Observer was already removed" : "Removed observer")

			let switchedTabs = false
			let needRealClick = false
			if (!chatItem) {
				this.log(`Chat ${chatID} not in recents list`)

				if (chatID.charAt(0) != "u") {
					needRealClick = true
					const unselectedTabButton = await this.page.$(`#leftSide li[data-type=groups_list] > button:not(.ExSelected)`)
					if (unselectedTabButton) {
						switchedTabs = true
						await unselectedTabButton.evaluate(e => e.click())
						await this.page.waitForSelector("#wrap_group_list > div.MdScroll")
					}
					chatItem = await this.page.$(this._groupItemSelector(chatID))
				} else {
					chatItem = await this.page.$(this._friendItemSelector(chatID))
				}

				if (!chatItem) {
					throw `Cannot find a ${type} with ID ${chatID}`
				}

				// Both functions are the same, but keep them separate in case the
				// HTML of friend/group item titles ever diverge
				chatName = await chatItem.evaluate(
					chatID.charAt(0) == "u"
					? element => window.__mautrixController.getFriendsListItemName(element)
					: element => window.__mautrixController.getGroupListItemName(element))
			}

			await this._retryUntilSuccess(3, "Clicking chat item didn't work...try again",
				async () => {
					this.log("Clicking chat item")
					if (!needRealClick) {
						await chatItem.evaluate(e => e.click())
					} else {
						await this._interactWithPage(async () => {
							await chatItem.click()
						})
					}
					this.log(`Waiting for chat header title to be "${chatName}"`)
					await this.page.waitForFunction(
						isCorrectChatVisible,
						{polling: "mutation", timeout: 1000},
						chatName)
				})
			if (switchedTabs) {
				await this.page.$eval("#leftSide li[data-type=chats_list] > button", e => e.click())
			}

			await this._interactWithPage(async () => {
				// Always show the chat details sidebar, as this makes life easier
				this.log("Waiting for detail area to be auto-hidden upon entering chat")
				await this.page.waitForFunction(
					detailArea => detailArea.childElementCount == 0,
					{},
					await this.page.$("#_chat_detail_area"))

				await this._retryUntilSuccess(3, "Clicking chat header didn't work...try again",
					async () => {
						this.log("Clicking chat header to show detail area")
						await this.page.click("#_chat_header_area > .mdRGT04Link")
						this.log("Waiting for detail area")
						await this.page.waitForSelector("#_chat_detail_area > .mdRGT02Info", {timeout: 1000})
					})
			})

			this.log("Waiting for any item to appear in chat")
			try {
				await this.page.waitForSelector("#_chat_room_msg_list div", {timeout: 2000})

				this.log("Waiting for chat to stabilize")
				await this.page.evaluate(() => window.__mautrixController.waitForMessageListStability())
			} catch (e) {
				this.log("No messages in chat found. Maybe no messages were ever sent yet?")
			}

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

	async _getChatInfoUnsafe(chatID, forceView) {
		// TODO Commonize this
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

		const chatListItem = await this.page.$(this._chatItemSelector(chatID))
		if (!chatListItem) {
			if (isDirect) {
				const friendsListItem = await this.page.$(this._friendItemSelector(chatID))
				if (!friendsListItem) {
					throw `Cannot find friend with ID ${chatID}`
				}
				const friendsListInfo = await friendsListItem.evaluate(
					(element, chatID) => window.__mautrixController.parseFriendsListItem(element, chatID),
					chatID)

				this.log(`Found NEW direct chat with ${chatID}`)
				return {
					participants: [friendsListInfo],
					id: chatID,
					name: friendsListInfo.name,
					icon: friendsListInfo.avatar,
					lastMsg: null,
					lastMsgDate: null,
				}
			} else {
				// TODO
				throw "Can't yet get info of new groups/rooms"
			}
		}

		const chatListInfo = await chatListItem.evaluate(
			(element, chatID) => window.__mautrixController.parseChatListItem(element, chatID),
			chatID)

		let participants
		if (!isDirect) {
			this.log("Found multi-user chat, so viewing it to get participants")
			// TODO This will mark the chat as "read"!
			await this._switchChat(chatID, forceView)
			const participantList = await this.page.$("#_chat_detail_area > .mdRGT02Info ul.mdRGT13Ul")
			// TODO Is a group not actually created until a message is sent(?)
			//      If so, maybe don't create a portal until there is a message.
			participants = await participantList.evaluate(
				element => window.__mautrixController.parseParticipantList(element))
		} else {
			this.log(`Found direct chat with ${chatID}`)
			if (forceView) {
				this.log("Viewing chat on request")
				await this._switchChat(chatID, forceView)
			}
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
		await this._syncChat(chatID)
		// TODO Initiate the promise in the content script
		await this.page.evaluate(
			() => window.__mautrixController.promiseOwnMessage(15000, "time"))

		const input = await this.page.$("#_chat_room_input")
		await this._interactWithPage(async () => {
			// Live-typing in the field can have its text mismatch what was requested!!
			// Probably because the input element is a div instead of a real text input...ugh!
			// Setting its innerText directly works fine though...
			await input.click()
			await input.evaluate((e, text) => e.innerText = text, text)
			await this._retryUntilSuccess(0, "Failed to press Enter when sending message, try again",
				async () => {
					await input.press("Enter")
					await this.page.waitForFunction(
						e => e.innerText == "",
						{timeout: 500},
						input)
				})
		})

		return await this._waitForSentMessage(chatID)
	}

	async _sendFileUnsafe(chatID, filePath) {
		await this._syncChat(chatID)
		await this.page.evaluate(
			() => window.__mautrixController.promiseOwnMessage(
				30000, // Use longer timeout for file uploads
				"#_chat_message_success_menu",
				"#_chat_message_fail_menu"))

		try {
			this._interactWithPage(async () => {
				this.log(`About to ask for file chooser in ${chatID}`)
				const [fileChooser] = await Promise.all([
					this.page.waitForFileChooser(),
					this.page.click("#_chat_room_plus_btn")
				])
				this.log(`About to upload ${filePath}`)
				await fileChooser.accept([filePath])
			})
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
			this.mostRecentMessages.set(chatID, id)
			this.mostRecentOwnMessages.set(chatID, id)
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
		if (!skipProcessing) {
			messages = this._processMessages(chatID, messages)
		}
		if (this.client) {
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


		const receiptMap = this._getReceiptMap(chatID)

		// Sync receipts seen from newly-synced messages
		// TODO When user leaves, clear the read-by count for the old number of other participants
		let minCountToFind = 1
		for (let i = messages.length-1; i >= 0; i--) {
			const message = messages[i]
			if (!message.is_outgoing) {
				continue
			}
			const count = message.receipt_count
			if (count >= minCountToFind && message.id > (receiptMap.get(count) || 0)) {
				minCountToFind = count+1
				receiptMap.set(count, message.id)
			}
			// TODO Early exit when count == num other participants
		}

		// Sync receipts from previously-seen messages
		const receipts = await this.page.evaluate(
			mostRecentReceipts => window.__mautrixController.parseReceiptList(mostRecentReceipts),
			Object.fromEntries(receiptMap))
		for (const receipt of receipts) {
			receiptMap.set(receipt.count, receipt.id)
			receipt.chat_id = chatID
		}

		this._trimReceiptMap(receiptMap)


		if (hadMsgListObserver) {
			this.log("Restoring msg list observer")
			await this.page.evaluate(
				mostRecentMessage => window.__mautrixController.addMsgListObserver(mostRecentMessage),
				this.mostRecentMessages.get(chatID))
		} else {
			this.log("Not restoring msg list observer, as there never was one")
		}

		return {
			messages: messages,
			receipts: receipts
		}
	}

	_processMessages(chatID, messages) {
		// TODO Probably don't need minID filtering if Puppeteer context handles it now
		const minID = this.mostRecentMessages.get(chatID) || 0
		const filteredMessages = messages.filter(msg => msg.id > minID)

		if (filteredMessages.length > 0) {
			const newFirstID = filteredMessages[0].id
			const newLastID = filteredMessages[filteredMessages.length - 1].id
			this.mostRecentMessages.set(chatID, newLastID)
			const range = newFirstID === newLastID ? newFirstID : `${newFirstID}-${newLastID}`
			this.log(`Loaded ${messages.length} messages in ${chatID}, got ${filteredMessages.length} newer than ${minID} (${range})`)
			for (const message of filteredMessages) {
				message.chat_id = chatID
			}
			for (let i = filteredMessages.length - 1; i >= 0; i--) {
				const message = filteredMessages[i]
				if (message.is_outgoing) {
					this.mostRecentOwnMessages.set(chatID, message.id)
					break
				}
			}
			return filteredMessages
		} else {
			return []
		}
	}

	_getReceiptMap(chatID) {
		if (!this.mostRecentReceipts.has(chatID)) {
			const newMap = new Map()
			this.mostRecentReceipts.set(chatID, newMap)
			return newMap
		} else {
			return this.mostRecentReceipts.get(chatID)
		}
	}

	_trimReceiptMap(receiptMap) {
		// Delete lower counts for earlier messages
		let prevCount = null
		for (const count of Array.from(receiptMap.keys()).sort()) {
			if (prevCount != null && receiptMap.get(prevCount) < receiptMap.get(count)) {
				receiptMap.delete(count)
			}
			prevCount = count
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
			this.log("Notifications dropped--must have read messages from another LINE client, skip")
			this.numChatNotifications.set(chatID, 0)
			return
		}

		const mustSync =
			// If >1, a notification was missed. Only way to get them is to view the chat.
			// If == 0, might be own message...or just a shuffled chat, or something else.
			// To play it safe, just sync them. Should be no harm, as they're viewed already.
			   diffNumNotifications != 1
			// Without placeholders, some messages require visiting their chat to be synced.
			|| !this.sendPlaceholders
			&& (
				// Can only use previews for DMs, because sender can't be found otherwise!
				   chatListInfo.id.charAt(0) != 'u'
				// Sync when lastMsg is a canned message for a non-previewable message type.
				|| chatListInfo.lastMsg.endsWith(" sent a photo.")
				|| chatListInfo.lastMsg.endsWith(" sent a sticker.")
				|| chatListInfo.lastMsg.endsWith(" sent a location.")
				// TODO More?
			)

		let messages
		if (!mustSync) {
			messages = [{
				chat_id: chatListInfo.id,
				id: null, // because sidebar messages have no ID
				timestamp: null, // because this message was sent right now
				is_outgoing: false, // because there's no reliable way to detect own messages...
				sender: null, // because there's no way to tell who sent a message
				html: chatListInfo.lastMsg,
			}]
			this.numChatNotifications.set(chatID, chatListInfo.notificationCount)
			this._receiveMessages(chatID, messages, true)
		} else {
			this.numChatNotifications.set(chatID, 0)
			await this._syncChat(chatListInfo.id)
		}
	}

	async _syncChat(chatID) {
		const {messages, receipts} = await this._getMessagesUnsafe(chatID)

		if (messages.length == 0) {
			this.log("No new messages found in", chatID)
		} else {
			this._receiveMessages(chatID, messages, true)
		}

		if (receipts.length == 0) {
			this.log("No new receipts found in", chatID)
		} else {
			this._receiveReceiptMulti(chatID, receipts, true)
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
		const receiptMap = this._getReceiptMap(chat_id)
		const prevReceiptID = (receiptMap.get(1) || 0)
		if (receipt_id <= prevReceiptID) {
			this.log(`Received OUTDATED read receipt ${receipt_id} (older than ${prevReceiptID}) for chat ${chat_id}`)
			return
		}
		receiptMap.set(1, receipt_id)

		this.log(`Received read receipt ${receipt_id} (since ${prevReceiptID}) for chat ${chat_id}`)
		if (this.client) {
			this.client.sendReceipt({chat_id: chat_id, id: receipt_id})
				.catch(err => this.error("Error handling read receipt:", err))
		} else {
			this.log("No client connected, not sending receipts")
		}
	}

	async _receiveReceiptMulti(chat_id, receipts, skipProcessing = false) {
		// Use async to ensure that receipts are sent in order

		if (!skipProcessing) {
			const receiptMap = this._getReceiptMap(chat_id)
			receipts.filter(receipt => {
				if (receipt.id > (receiptMap.get(receipt.count) || 0)) {
					receiptMap.set(receipt.count, receipt.id)
					return true
				} else {
					return false
				}
			})
			if (receipts.length == 0) {
				this.log(`Received ALL OUTDATED bulk read receipts for chat ${chat_id}:`, receipts)
				return
			}
			this._trimReceiptMap(receiptMap)
		}

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
		await this._enterText(await this.page.$("#line_login_email"), this.login_email)
		await this._enterText(await this.page.$("#line_login_pwd"), this.login_password)
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

	_onLoggedOut(message) {
		this.log(`Got logged out!${!message ? "" : " Message: " + message}`)
		this.stopObserving()
		this.page.bringToFront()
		if (this.client) {
			this.client.sendLoggedOut(message).catch(err =>
				this.error("Failed to send logout notice to client:", err))
		} else {
			this.log("No client connected, not sending logout notice")
		}
	}
}
