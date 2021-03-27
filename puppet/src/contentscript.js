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
/**
 * @return {Promise<Element>}
 */
window.__mautrixGetParticipantsList = function() {}

const ChatTypeEnum = Object.freeze({
	DIRECT: 1,
	GROUP: 2,
	ROOM: 3,
})

class MautrixController {
	constructor(ownID) {
		this.chatListObserver = null
		this.qrChangeObserver = null
		this.qrAppearObserver = null
		this.emailAppearObserver = null
		this.pinAppearObserver = null
		this.expiryObserver = null
		this.ownID = null
	}

	setOwnID(ownID) {
		// Remove characters that will conflict with mxid grammar
		const suffix = ownID.slice(1).replace(":", "_ON_")
		this.ownID = `_OWN_${suffix}`
	}

	// TODO Commonize with Node context
	getChatType(id) {
		switch (id.charAt(0)) {
		case "u":
			return ChatTypeEnum.DIRECT
		case "c":
			return ChatTypeEnum.GROUP
		case "r":
			return ChatTypeEnum.ROOM
		default:
			throw `Invalid chat ID: ${id}`
		}
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
		return parsed ? new Date(parsed) : null
	}

	/**
	 * Parse a date separator (mws-relative-timestamp)
	 *
	 * @param {string} text - The text in the mws-relative-timestamp element.
	 * @return {?Date} - The value in the date separator.
	 * @private
	 */
	async _tryParseDayDate(text) {
		if (!text) {
			return null
		}
		text = text.replace(/\. /, "/")
		const now = new Date()
		let newDate = await this._tryParseDate(text)
		if (!newDate || newDate > now) {
			const lastWeek = new Date()
			lastWeek.setDate(lastWeek.getDate() - 7)
			newDate = await this._tryParseDate(text, lastWeek, { forwardDate: true })
		}
		return newDate && newDate <= now ? newDate : null
	}

	/**
	 * Try to match a user against an entry in the friends list to get their ID.
	 *
	 * @param {Element} element - The display name of the user to find the ID for.
	 * @return {null|str}       - The user's ID if found.
	 */
	getUserIdFromFriendsList(senderName) {
		return document.querySelector(`#contact_wrap_friends > ul > li[title='${senderName}']`)?.getAttribute("data-mid")
	}

	/**
	 * @typedef MessageData
	 * @type {object}
	 * @property {number}  id          - The ID of the message. Seems to be sequential.
	 * @property {number}  timestamp   - The unix timestamp of the message. Not very accurate.
	 * @property {boolean} is_outgoing - Whether or not this user sent the message.
	 * @property {null|Participant} sender - Full data of the participant who sent the message, if needed and available.
	 * @property {string}  [text]      - The text in the message.
	 * @property {string}  [image]     - The URL to the image in the message.
	 */

	/**
	 * Parse a message element (mws-message-wrapper)
	 *
	 * @param {Date}    date    - The most recent date indicator.
	 * @param {Element} element - The message element.
	 * @param {int} chatType    - What kind of chat this message is part of.
	 * @return {MessageData}
	 * @private
	 */
	async _tryParseMessage(date, element, chatType) {
		const is_outgoing = element.classList.contains("mdRGT07Own")
		let sender = {}

		// TODO Clean up participantsList access...
		const participantsListSelector = "#_chat_detail_area > .mdRGT02Info ul.mdRGT13Ul"

		// Don't need sender ID for direct chats, since the portal will have it already.
		if (chatType == ChatTypeEnum.DIRECT) {
			sender = null
		} else if (!is_outgoing) {
			sender.name = element.querySelector(".mdRGT07Body > .mdRGT07Ttl").innerText
			// Room members are always friends (right?),
			// so search the friend list for the sender's name
			// and get their ID from there.
			sender.id = this.getUserIdFromFriendsList(sender.name)
			// Group members aren't necessarily friends,
			// but the participant list includes their ID.
			if (!sender.id) {
				await window.__mautrixShowParticipantsList()
				const participantsList = document.querySelector(participantsListSelector)
				sender.id = participantsList.querySelector(`img[alt='${senderName}'`).parentElement.parentElement.getAttribute("data-mid")
			}
			sender.avatar = this.getParticipantListItemAvatar(element)
		} else {
			// TODO Get own ID and store it somewhere appropriate.
			//      Unable to get own ID from a room chat...
			// if (chatType == ChatTypeEnum.GROUP) {
			// 	await window.__mautrixShowParticipantsList()
			// 	const participantsList = document.querySelector("#_chat_detail_area > .mdRGT02Info ul.mdRGT13Ul")
			// 	// TODO The first member is always yourself, right?
			// 	// TODO Cache this so own ID can be used later
			// 	sender = participantsList.children[0].getAttribute("data-mid")
			// }
			await window.__mautrixShowParticipantsList()
			const participantsList = document.querySelector(participantsListSelector)
			sender.name = this.getParticipantListItemName(participantsList.children[0])
			sender.avatar = this.getParticipantListItemAvatar(participantsList.children[0])
			sender.id = this.ownID
		}

		const messageData = {
			id: +element.getAttribute("data-local-id"),
			timestamp: date ? date.getTime() : null,
			is_outgoing: is_outgoing,
			sender: sender,
		}
		const messageElement = element.querySelector(".mdRGT07Body > .mdRGT07Msg")
		if (messageElement.classList.contains("mdRGT07Text")) {
			// TODO Use "Inner" or not?
			messageData.text = messageElement.querySelector(".mdRGT07MsgTextInner")?.innerText
		} else if (messageElement.classList.contains("mdRGT07Image")) {
			// TODO Probably need a MutationObserver to wait for image to load.
			// 		Should also catch "#_chat_message_image_failure"
			messageData.image_url = messageElement.querySelector(".mdRGT07MsgImg > img")?.src
		}
		return messageData
	}


	promiseOwnMessage() {
		let observer
		let msgID = -1
		let resolve
		let reject

		const invisibleTimeCallback = (changes) => {
			for (const change of changes) {
				for (const addedNode of change.addedNodes) {
					if (addedNode.classList.contains("mdRGT07Own")) {
						const timeElement = addedNode.querySelector("time.MdNonDisp")
						if (timeElement) {
							msgID = +addedNode.getAttribute("data-local-id")
							observer.disconnect()
							observer = new MutationObserver(visibleTimeCallback)
							observer.observe(timeElement, { attributes: true, attributeFilter: ["class"] })
							return
						}
					}
				}
			}
		}

		const visibleTimeCallback = (changes) => {
			for (const change of changes) {
				if (!change.target.classList.contains("MdNonDisp")) {
					window.__mautrixReceiveMessageID(msgID)
					observer.disconnect()
					resolve(msgID)
					return
				}
			}
		}

		observer = new MutationObserver(invisibleTimeCallback)
		observer.observe(
			document.querySelector("#_chat_room_msg_list"),
			{ childList: true })

		return new Promise((realResolve, realReject) => {
			resolve = realResolve
			reject = realReject
			// TODO Handle a timeout better than this
			setTimeout(() => { observer.disconnect(); reject() }, 10000)
		})
	}

	/**
	 * Parse the message list of whatever the currently-viewed chat is.
	 *
	 * @param {null|string} chatId - The ID of the currently-viewed chat, if known.
	 * @return {[MessageData]} - A list of messages.
	 */
	async parseMessageList(chatId) {
		if (!chatId) {
			chatId = this.getChatListItemId(document.querySelector("#_chat_list_body > .ExSelected > div"))
		}
		const chatType = this.getChatType(chatId);
		const msgList = document.querySelector("#_chat_room_msg_list")
		const messages = []
		let refDate = null
		for (const child of msgList.children) {
			if (child.tagName == "DIV") {
				if (child.classList.contains("mdRGT10Date")) {
					refDate = await this._tryParseDayDate(child.firstElementChild.innerText)
				}
				else if (child.classList.contains("MdRGT07Cont")) {
					// TODO :not(.MdNonDisp) to exclude not-yet-posted messages,
					// 		but that is unlikely to be a problem here.
					// 		Also, offscreen times may have .MdNonDisp on them
					const timeElement = child.querySelector("time")
					if (timeElement) {
						const messageDate = await this._tryParseDate(timeElement.innerText, refDate)
						messages.push(await this._tryParseMessage(messageDate, child, chatType))
					}
				}
			}
		}
		return messages
	}

	/**
	 * @typedef PathImage
	 * @type object
	 * @property {string} path - The virtual path of the image (behaves like an ID)
	 * @property {string} src  - The URL of the image
	 */

	_getPathImage(img) {
		if (img && img.src.startsWith("blob:")) {
			// NOTE Having a blob but no path means the image exists,
			// 		but in a form that cannot be uniquely identified.
			// 		If instead there is no blob, the image is blank.
			return {
				path: img.getAttribute("data-picture-path"),
				url: img.src,
			}
		} else {
			return null
		}
	}

	/**
	 * @typedef Participant
	 * @type object
	 * @property {string} id        - The member ID for the participant
	 * @property {PathImage} avatar - The path and blob URL of the participant's avatar
	 * @property {string} name      - The contact list name of the participant
	 */

	getParticipantListItemName(element) {
		return element.querySelector(".mdRGT13Ttl").innerText
	}

	getParticipantListItemAvatar(element) {
		return this._getPathImage(element.querySelector(".mdRGT13Img img[src]"))
	}

	getParticipantListItemId(element) {
		// TODO Cache own ID
		return element.getAttribute("data-mid")
	}

	/**
	 * Parse a group participants list.
	 * TODO Find what works for a *room* participants list...!
	 *
	 * @param {Element} element - The participant list element.
	 * @return {[Participant]} - The list of participants.
	 */
	parseParticipantList(element) {
		// TODO Might need to explicitly exclude own user if double-puppeting is enabled.
		// TODO The first member is always yourself, right?
		const ownParticipant = {
			// TODO Find way to make this work with multiple mxids using the bridge.
			//      One idea is to add real ID as suffix if we're in a group, and
			//      put in the puppet DB table somehow.
			id: this.ownID,
			avatar: this.getParticipantListItemAvatar(element.children[0]),
			name: this.getParticipantListItemName(element.children[0]),
		}

		return [ownParticipant].concat(Array.from(element.children).slice(1).map(child => {
			const name = this.getParticipantListItemName(child)
			const id = this.getParticipantListItemId(child) || this.getUserIdFromFriendsList(name)
			return {
				id: id, // NOTE Don't want non-own user's ID to ever be null.
				avatar: this.getParticipantListItemAvatar(child),
				name: name,
			}
		}))
	}

	/**
	 * @typedef ChatListInfo
	 * @type object
	 * @property {number} id      - The ID of the chat.
	 * @property {string} name    - The name of the chat.
	 * @property {PathImage} icon - The path and blob URL of the chat icon.
	 * @property {string} lastMsg - The most recent message in the chat.
	 *                              May be prefixed by sender name.
	 * @property {string} lastMsgDate - An imprecise date for the most recent message
	 *                                  (e.g. "7:16 PM", "Thu" or "Aug 4")
	 */

	getChatListItemId(element) {
		return element.getAttribute("data-chatid")
	}

	getChatListItemName(element) {
		return element.querySelector(".mdCMN04Ttl").innerText
	}

	getChatListItemIcon(element) {
		return this._getPathImage(element.querySelector(".mdCMN04Img > :not(.mdCMN04ImgInner) > img[src]"))
	}

	getChatListItemLastMsg(element) {
		return element.querySelector(".mdCMN04Desc").innerText
	}

	getChatListItemLastMsgDate(element) {
		return element.querySelector("time").innerText
	}

	/**
	 * Parse a conversation list item element.
	 *
	 * @param {Element} element - The element to parse.
	 * @param {null|string} knownId - The ID of this element, if it is known.
	 * @return {ChatListInfo} - The info in the element.
	 */
	parseChatListItem(element, knownId) {
		return !element.classList.contains("chatList") ? null : {
			id: knownId || this.getChatListItemId(element),
			name: this.getChatListItemName(element),
			icon: this.getChatListItemIcon(element),
			lastMsg: this.getChatListItemLastMsg(element),
			lastMsgDate: this.getChatListItemLastMsgDate(element),
		}
	}

	/**
	 * Parse the list of recent/saved chats.
	 * @return {[ChatListInfo]} - The list of chats.
	 */
	parseChatList() {
		const chatList = document.querySelector("#_chat_list_body")
		return Array.from(chatList.children).map(
			child => this.parseChatListItem(child.firstElementChild))
	}

	/**
	 * TODO
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
	 * Download an image at a given URL and return it as a data URL.
	 *
	 * @param {string} url - The URL of the image to download.
	 * @return {Promise<string>} - The data URL (containing the mime type and base64 data)
	 */
	async readImage(url) {
		const resp = await fetch(url)
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
		// TODO Observe *added/removed* chats, not just new messages
		const changedChatIDs = new Set()
		for (const change of mutations) {
			console.debug("Chat list mutation:", change)
			if (change.target.id == "_chat_list_body") {
				// TODO
				// These could be new chats, or they're
				// existing ones that just moved around.
				/*
				for (const node of change.addedNodes) {
				}
				*/
			}
			else if (change.target.tagName == "LI")
			{
				for (const node of change.addedNodes) {
					const chat = this.parseChatListItem(node)
					if (chat) {
						console.debug("Changed chat list item:", chat)
						changedChatIDs.add(chat.id)
					} else {
						console.debug("Could not parse node as a chat list item:", node)
					}
				}
			}
			// change.removedNodes tells you which chats that had notifications are now read.
		}
		if (changedChatIDs.size > 0) {
			console.debug("Dispatching chat list mutations:", changedChatIDs)
			window.__mautrixReceiveChanges(Array.from(changedChatIDs)).then(
				() => console.debug("Chat list mutations dispatched"),
				err => console.error("Error dispatching chat list mutations:", err))
		}
	}

	/**
	 * Add a mutation observer to the chat list.
	 */
	addChatListObserver() {
		if (this.chatListObserver !== null) {
			this.removeChatListObserver()
		}
		this.chatListObserver = new MutationObserver(mutations => {
			try {
				this._observeChatListMutations(mutations)
			} catch (err) {
				console.error("Error observing chat list mutations:", err)
			}
		})
		this.chatListObserver.observe(
			document.querySelector("#_chat_list_body"),
			{ childList: true, subtree: true })
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

	addEmailAppearObserver(element) {
		if (this.emailAppearObserver !== null) {
			this.removeEmailAppearObserver()
		}
		this.emailAppearObserver = new MutationObserver(changes => {
			for (const change of changes) {
				for (const node of change.addedNodes) {
					const emailArea = node.querySelector("#login_email_area")
					if (emailArea && !emailArea.classList.contains("MdNonDisp")) {
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

	addPINAppearObserver(element) {
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
			if (changes.length == 1 && !changes[0].target.classList.contains("MdNonDisp")) {
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
