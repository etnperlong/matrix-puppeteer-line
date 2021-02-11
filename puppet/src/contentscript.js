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

// Definitions and docs for methods that the Puppeteer script exposes for the content script
/**
 * @param {string} text - The date string to parse
 * @param {Date} [ref] - Reference date to parse relative times
 * @param {{[forwardDate]: boolean}} [option] - Extra options for parser
 * @return {Promise<Date>}
 */
window.__chronoParseDate = function (text, ref, option) {}
/**
 * @param {string[]} changes - The hrefs of the chats that changed.
 * @return {Promise<void>}
 */
window.__mautrixReceiveChanges = function (changes) {}
/**
 * @param {string} url - The URL for the QR code.
 * @return {Promise<void>}
 */
window.__mautrixReceiveQR = function (url) {}
/**
 * @return {Promise<void>}
 */
window.__mautrixSendEmailCredentials = function () {}
/**
 * @param {string} pin - The login PIN.
 * @return {Promise<void>}
 */
window.__mautrixReceivePIN = function (pin) {}
/**
 * @param {Element} button - The button to click when a QR code or PIN expires.
 * @return {Promise<void>}
 */
window.__mautrixExpiry = function (button) {}
/**
 * @param {number} id - The ID of the message that was sent
 * @return {Promise<void>}
 */
window.__mautrixReceiveMessageID = function(id) {}

class MautrixController {
	constructor() {
		this.chatListObserver = null
		this.qrChangeObserver = null
		this.qrAppearObserver = null
		this.emailAppearObserver = null
		this.pinAppearObserver = null
		this.expiryObserver = null
	}

	/**
	 * Parse a date string.
	 *
	 * @param {string} text - The string to parse
	 * @param {Date} [ref] - Reference date to parse relative times
	 * @param {{[forwardDate]: boolean}} [option] - Extra options for parser
	 * @return {Promise<null|Date>} - The date, or null if parsing failed.
	 * @private
	 */
	async _tryParseDate(text, ref, option) {
		const parsed = await window.__chronoParseDate(text, ref, option)
		if (parsed) {
			return new Date(parsed)
		}
		return null
	}

	/**
	 * Parse a date separator (mws-relative-timestamp)
	 *
	 * @param {string} text - The text in the mws-relative-timestamp element.
	 * @return {?Date} - The value in the date separator.
	 * @private
	 */
	async _parseDate(text) {
		if (!text) {
			return null
		}
		text = text
			.replace(/[^\w\d\s,:.-]/g, "")
			.replace(/\s{2,}/g, " ")
			.trim()
		const now = new Date()
		let newDate = await this._tryParseDate(text)
		if (!newDate || newDate > now) {
			const lastWeek = new Date()
			lastWeek.setDate(lastWeek.getDate() - 7)
			newDate = await this._tryParseDate(text, lastWeek, { forwardDate: true })
		}
		return newDate <= now ? newDate : null
	}

	/**
	 * @typedef MessageData
	 * @type {object}
	 * @property {number}  id          - The ID of the message. Seems to be sequential.
	 * @property {number}  timestamp   - The unix timestamp of the message. Not very accurate.
	 * @property {boolean} is_outgoing - Whether or not this user sent the message.
	 * @property {string}  [text]      - The text in the message.
	 * @property {string}  [image]     - The URL to the image in the message.
	 */

	/**
	 * Parse a message element (mws-message-wrapper)
	 *
	 * @param {Date}    date    - The most recent date indicator.
	 * @param {Element} element - The message element.
	 * @return {MessageData}
	 * @private
	 */
	_parseMessage(date, element) {
		const messageData = {
			id: +element.getAttribute("msg-id"),
			timestamp: date ? date.getTime() : null,
			is_outgoing: element.getAttribute("is-outgoing") === "true",
		}
		messageData.text = element.querySelector("mws-text-message-part .text-msg")?.innerText
		if (element.querySelector("mws-image-message-part .image-msg")) {
			messageData.image = true
		}
		return messageData
	}

	waitForMessage(elem) {
		return new Promise(resolve => {
			let msgID = null
			const observer = new MutationObserver(changes => {
				for (const change of changes) {
					if (change.type === "attributes" && change.attributeName === "msg-id") {
						msgID = +elem.getAttribute("msg-id")
						window.__mautrixReceiveMessageID(msgID)
					} else if (change.type === "childList"
						&& change.target.nodeName.toLowerCase() === "mws-relative-timestamp"
						&& change.addedNodes.length > 0
						&& change.addedNodes[0] instanceof Text) {
						resolve(msgID)
						observer.disconnect()
						return
					}
				}
			})
			observer.observe(elem, { attributes: true, attributeFilter: ["msg-id"] })
			observer.observe(elem.querySelector("mws-message-status"), {
				childList: true,
				subtree: true,
			})
		})
	}

	/**
	 * Parse a message list in the given element. The element should probably be the .content div
	 * inside a mws-message-list element.
	 *
	 * @param {Element} element - The message list element.
	 * @return {[MessageData]} - A list of messages.
	 */
	async parseMessageList(element) {
		const messages = []
		let messageDate = null
		for (const child of element.children) {
			switch (child.tagName.toLowerCase()) {
			case "mws-message-wrapper":
				if (!child.getAttribute("msg-id").startsWith("tmp_")) {
					messages.push(this._parseMessage(messageDate, child))
				}
				break
			case "mws-tombstone-message-wrapper":
				messageDate = await this._parseDate(
					child.querySelector("mws-relative-timestamp")?.innerText,
				) || messageDate
				break
			}
		}
		return messages
	}

	/**
	 * @typedef Participant
	 * @type object
	 * @property {string} id - The unique-ish identifier for the participant
	 * @property {string} name - The contact list name of the participant
	 */

	/**
	 * Parse a mw-conversation-details .participants list.
	 *
	 * @param {Element} element - The participant list element.
	 * @return {[Participant]} - The list of participants.
	 */
	parseParticipantList(element) {
		const participants = []
		for (const participantElem of element.getElementsByClassName("participant")) {
			const nameElem = participantElem.querySelector(".participant-name")
			const name = nameElem.innerText.trim()
			let id = name
			if (nameElem.nextElementSibling && nameElem.nextElementSibling.hasAttribute("data-e2e-details-participant-number")) {
				id = nameElem.nextElementSibling.innerText
			}
			// For phone numbers, remove the + prefix
			// For non-number IDs, prepend name_ and force-lowercase
			id = /^\+\d+$/.test(id) ? id.substr(1) : `name_${id.toLowerCase()}`
			participants.push({ name, id })
		}
		return participants
	}

	/**
	 * @typedef ChatListInfo
	 * @type object
	 * @property {number} id - The ID of the chat.
	 * @property {string} name - The name of the chat.
	 * @property {string} lastMsg - The most recent message in the chat.
	 *                              May be prefixed by sender name.
	 * @property {string} lastMsgDate - An imprecise date for the most recent message
	 *                                  (e.g. "7:16 PM", "Thu" or "Aug 4")
	 */

	/**
	 * Parse a mws-conversation-list-item element.
	 *
	 * @param {Element} element - The element to parse.
	 * @return {ChatListInfo} - The info in the element.
	 */
	parseChatListItem(element) {
		if (element.tagName.toLowerCase() === "mws-conversation-list-item") {
			element = element.querySelector("a.list-item")
		}
		return {
			id: +element.getAttribute("href").split("/").pop(),
			name: element.querySelector("h3.name").innerText,
			lastMsg: element.querySelector("mws-conversation-snippet").innerText,
			lastMsgDate: element.querySelector("mws-relative-timestamp").innerText,
		}
	}

	/**
	 * Parse a mws-conversations-list .conv-container list.
	 * @param {Element} element - The chat list element.
	 * @return {[ChatListInfo]} - The list of chats.
	 */
	parseChatList(element) {
		const chats = []
		for (const child of element.children) {
			if (child.tagName.toLowerCase() !== "mws-conversation-list-item") {
				continue
			}
			chats.push(this.parseChatListItem(child))
		}
		return chats
	}

	/**
	 * Check if an image has been downloaded.
	 *
	 * @param {number} id - The ID of the message whose image to check.
	 * @return {boolean} - Whether or not the image has been downloaded
	 */
	imageExists(id) {
		const imageElement = document.querySelector(
			`mws-message-wrapper[msg-id="${id}"] mws-image-message-part .image-msg`)
		return !imageElement.classList.contains("not-rendered")
			&& imageElement.getAttribute("src") !== ""
	}

	/**
	 * Download an image and return it as a data URL.
	 * Used for downloading the blob: URLs in image messages.
	 *
	 * @param {number} id - The ID of the message whose image to download.
	 * @return {Promise<string>} - The data URL (containing the mime type and base64 data)
	 */
	async readImage(id) {
		const imageElement = document.querySelector(
			`mws-message-wrapper[msg-id="${id}"] mws-image-message-part .image-msg`)
		const resp = await fetch(imageElement.getAttribute("src"))
		const reader = new FileReader()
		const promise = new Promise((resolve, reject) => {
			reader.onload = () => resolve(reader.result)
			reader.onerror = reject
		})
		reader.readAsDataURL(await resp.blob())
		return promise
	}

	/**
	 * @param {[MutationRecord]} mutations - The mutation records that occurred
	 * @private
	 */
	_observeChatListMutations(mutations) {
		const changedChatIDs = new Set()
		for (const change of mutations) {
			console.debug("Chat list mutation:", change)
			if (!(change.target instanceof Element)
				|| change.target.tagName.toLowerCase() === "mws-conversation-list-item-menu") {
				console.debug("Ignoring chat list mutation:", change.target instanceof Element)
				continue
			}
			const chat = this.parseChatListItem(change.target.closest("mws-conversation-list-item"))
			console.debug("Changed chat list item:", chat)
			changedChatIDs.add(chat.id)
		}
		if (changedChatIDs.size > 0) {
			console.debug("Dispatching chat list mutations:", changedChatIDs)
			window.__mautrixReceiveChanges(Array.from(changedChatIDs)).then(
				() => console.debug("Chat list mutations dispatched"),
				err => console.error("Error dispatching chat list mutations:", err))
		}
	}

	/**
	 * Add a mutation observer to the given element.
	 *
	 * @param {Element} element - The DOM element to add the mutation observer to.
	 */
	addChatListObserver(element) {
		if (this.chatListObserver !== null) {
			this.removeChatListObserver()
		}
		/* TODO
		this.chatListObserver = new MutationObserver(mutations => {
			try {
				this._observeChatListMutations(mutations)
			} catch (err) {
				console.error("Error observing chat list mutations:", err)
			}
		})
		this.chatListObserver.observe(element, { childList: true, subtree: true })
		*/
		console.debug("Started chat list observer")
	}

	/**
	 * Disconnect the most recently added mutation observer.
	 */
	removeChatListObserver() {
		if (this.chatListObserver !== null) {
			this.chatListObserver.disconnect()
			this.chatListObserver = null
			console.debug("Disconnected chat list observer")
		}
	}

	addQRChangeObserver(element) {
		if (this.qrChangeObserver !== null) {
			this.removeQRChangeObserver()
		}
		this.qrChangeObserver = new MutationObserver(changes => {
			for (const change of changes) {
				if (change.attributeName === "title" && change.target instanceof Element) {
					window.__mautrixReceiveQR(change.target.getAttribute("title"))
				}
			}
		})
		this.qrChangeObserver.observe(element, {
			attributes: true,
			attributeFilter: ["title"],
		})
	}

	removeQRChangeObserver() {
		if (this.qrChangeObserver !== null) {
			this.qrChangeObserver.disconnect()
			this.qrChangeObserver = null
		}
	}

	addQRAppearObserver(element) {
		if (this.qrAppearObserver !== null) {
			this.removeQRAppearObserver()
		}
		this.qrAppearObserver = new MutationObserver(changes => {
			for (const change of changes) {
				for (const node of change.addedNodes) {
					const qrElement = node.querySelector("#login_qrcode_area div[title]")
					if (qrElement) {
						window.__mautrixReceiveQR(qrElement.title)
						window.__mautrixController.addQRChangeObserver(element)
						return
					}
				}
			}
		})
		this.qrAppearObserver.observe(element, {
			childList: true,
		})
	}

	removeQRAppearObserver() {
		if (this.qrAppearObserver !== null) {
			this.qrAppearObserver.disconnect()
			this.qrAppearObserver = null
		}
	}

	addEmailAppearObserver(element, login_type) {
		if (this.emailAppearObserver !== null) {
			this.removeEmailAppearObserver()
		}
		this.emailAppearObserver = new MutationObserver(changes => {
			for (const change of changes) {
				for (const node of change.addedNodes) {
					const emailArea = node.querySelector("#login_email_area")
					if (emailArea && !emailArea.getAttribute("class").includes("MdNonDisp")) {
						window.__mautrixSendEmailCredentials()
						return
					}
				}
			}
		})
		this.emailAppearObserver.observe(element, {
			childList: true,
		})
	}

	removeEmailAppearObserver() {
		if (this.emailAppearObserver !== null) {
			this.emailAppearObserver.disconnect()
			this.emailAppearObserver = null
		}
	}

	addPINAppearObserver(element, login_type) {
		if (this.pinAppearObserver !== null) {
			this.removePINAppearObserver()
		}
		this.pinAppearObserver = new MutationObserver(changes => {
			for (const change of changes) {
				for (const node of change.addedNodes) {
					const pinElement = node.querySelector("div.mdCMN01Code")
					if (pinElement) {
						window.__mautrixReceivePIN(pinElement.innerText)
						return
					}
				}
			}
		})
		this.pinAppearObserver.observe(element, {
			childList: true,
		})
	}

	removePINAppearObserver() {
		if (this.pinAppearObserver !== null) {
			this.pinAppearObserver.disconnect()
			this.pinAppearObserver = null
		}
	}

	addExpiryObserver(element) {
		if (this.expiryObserver !== null) {
			this.removeExpiryObserver()
		}
		const button = element.querySelector("dialog button")
		this.expiryObserver = new MutationObserver(changes => {
			if (changes.length == 1 && !changes[0].target.getAttribute("class").includes("MdNonDisp")) {
				window.__mautrixExpiry(button)
			}
		})
		this.expiryObserver.observe(element, {
			attributes: true,
			attributeFilter: ["class"],
		})
	}

	removeExpiryObserver() {
		if (this.expiryObserver !== null) {
			this.expiryObserver.disconnect()
			this.expiryObserver = null
		}
	}
}

window.__mautrixController = new MautrixController()
