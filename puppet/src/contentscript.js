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
 * @param {string} messages - The ID of the chat receiving messages.
 * @param {MessageData[]} messages - The messages added to a chat.
 * @return {Promise<void>}
 */
window.__mautrixReceiveMessages = function (chatID, messages) {}
/**
 * @param {str} chatID - The ID of the chat whose receipts are being processed.
 * @param {str} receipt_id - The ID of the most recently-read message for the current chat.
 * @return {Promise<void>}
 */
window.__mautrixReceiveReceiptDirectLatest = function (chat_id, receipt_id) {}
/**
 * @param {str} chatID - The ID of the chat whose receipts are being processed.
 * @param {[Receipt]} receipts - All newly-seen receipts for the current chat.
 * @return {Promise<void>}
 */
window.__mautrixReceiveReceiptMulti = function (chat_id, receipts) {}
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
window.__mautrixShowParticipantsList = function() {}

const ChatTypeEnum = Object.freeze({
	DIRECT: 1,
	GROUP: 2,
	ROOM: 3,
})

class MautrixController {
	constructor() {
		this.chatListObserver = null
		this.msgListObserver = null
		this.receiptObserver = null

		this.qrChangeObserver = null
		this.qrAppearObserver = null
		this.emailAppearObserver = null
		this.pinAppearObserver = null
		this.expiryObserver = null
		this.ownID = null

		this.ownMsgPromise = Promise.resolve(-1)
		this._promiseOwnMsgReset()
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

	getCurrentChatID() {
		const chatListElement = document.querySelector("#_chat_list_body > .ExSelected > .chatList")
		return chatListElement ? this.getChatListItemID(chatListElement) : null
	}

	/**
	 * Parse a date string.
	 *
	 * @param {string} text - The string to parse
	 * @param {Date} [ref] - Reference date to parse relative times
	 * @param {{[forwardDate]: boolean}} [option] - Extra options for parser
	 * @return {Promise<?Date>} - The date, or null if parsing failed.
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
	 * @return {?str}           - The user's ID if found.
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
	 * @property {?Participant} sender - Full data of the participant who sent the message, if needed and available.
	 * @property {?string} html        - The HTML format of the message, if necessary.
	 * @property {?string} image_url   - The URL to the image in the message, if it's an image-only message.
	 * @property {?int} receipt_count  - The number of users who have read the message.
	 */

	_isLoadedImageURL(src) {
		return src && (src.startsWith("blob:") || src.startsWith("res/"))
	}

	/**
	 * Parse a message element (mws-message-wrapper)
	 *
	 * @param {Date}    date    - The most recent date indicator.
	 * @param {Element} element - The message element.
	 * @param {int} chatType    - What kind of chat this message is part of.
	 * @return {MessageData}
	 * @private
	 */
	async _parseMessage(date, element, chatType) {
		const is_outgoing = element.classList.contains("mdRGT07Own")
		let sender = {}

		const receipt = element.querySelector(".mdRGT07Own .mdRGT07Read:not(.MdNonDisp)")
		let receipt_count

		// TODO Clean up participantsList access...
		const participantsListSelector = "#_chat_detail_area > .mdRGT02Info ul.mdRGT13Ul"

		// Don't need sender ID for direct chats, since the portal will have it already.
		if (chatType == ChatTypeEnum.DIRECT) {
			sender = null
			receipt_count = is_outgoing ? (receipt ? 1 : 0) : null
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
			receipt_count = null
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

			receipt_count = receipt ? this._getReceiptCount(receipt) : null
		}

		const messageData = {
			id: +element.getAttribute("data-local-id"),
			timestamp: date ? date.getTime() : null,
			is_outgoing: is_outgoing,
			sender: sender,
			receipt_count: receipt_count
		}
		const messageElement = element.querySelector(".mdRGT07Body > .mdRGT07Msg")
		if (messageElement.classList.contains("mdRGT07Text")) {
			messageData.html = messageElement.querySelector(".mdRGT07MsgTextInner")?.innerHTML
		} else if (
			messageElement.classList.contains("mdRGT07Image") ||
			messageElement.classList.contains("mdRGT07Sticker")
		) {
			const img = messageElement.querySelector(".mdRGT07MsgImg > img")
			if (img) {
				let imgResolve
				// TODO Should reject on "#_chat_message_image_failure"
				let observer = new MutationObserver(changes => {
					for (const change of changes) {
						if (this._isLoadedImageURL(change.target.src) && observer) {
							observer.disconnect()
							observer = null
							imgResolve(change.target.src)
							return
						}
					}
				})
				observer.observe(img, { attributes: true, attributeFilter: ["src"] })

				if (this._isLoadedImageURL(img.src)) {
					// Check for this AFTER attaching the observer, in case
					// the image loaded after the img element was found but
					// before the observer was attached.
					messageData.image_url = img.src
					observer.disconnect()
				} else {
					messageData.image_url = await new Promise(resolve => {
						imgResolve = resolve
						setTimeout(() => {
							if (observer) {
								observer.disconnect()
								resolve(img.src)
							}
						}, 10000) // Longer timeout for image downloads
					})
				}
			}
		}
		return messageData
	}

	/**
	 * Find the number in the "Read #" receipt message.
	 * Don't look for "Read" specifically, to support multiple languages.
	 *
	 * @param {Element} receipt - The element containing the receipt message.
	 * @private
	 */
	_getReceiptCount(receipt) {
		const match = receipt.innerText.match(/\d+/)
		return Number.parseInt(match ? match[0] : 0) || null
	}


	/**
	 * Create and store a promise that resolves when a message written
	 * by the user finishes getting sent.
	 * Accepts selectors for elements that become visible once the message
	 * has succeeded or failed to be sent.
	 *
	 * @param {int} timeoutLimitMillis - The maximum amount of time to wait for the message to be sent.
	 * @param {str} successSelector - The selector for the element that indicates the message was sent.
	 * @param {str} failureSelector - The selector for the element that indicates the message failed to be sent.
	 */
	promiseOwnMessage(timeoutLimitMillis, successSelector, failureSelector=null) {
		this.promiseOwnMsgSuccessSelector = successSelector
		this.promiseOwnMsgFailureSelector = failureSelector

		this.ownMsgPromise = new Promise((resolve, reject) => {
			this.promiseOwnMsgResolve = resolve
			this.promiseOwnMsgReject = reject
			setTimeout(() => {
				if (this.promiseOwnMsgReject) {
					console.log("Timeout!")
					this._rejectOwnMessage()
				}
			}, timeoutLimitMillis)
		})
	}

	/**
	 * Wait for a user-sent message to finish getting sent.
	 *
	 * @return {Promise<int>} - The ID of the sent message.
	 */
	async waitForOwnMessage() {
		return await this.ownMsgPromise
	}

	async _tryParseMessages(msgList, chatType) {
		const messages = []
		let refDate = null
		for (const child of msgList) {
			if (child.classList.contains("mdRGT10Date")) {
				refDate = await this._tryParseDayDate(child.firstElementChild.innerText)
			} else if (child.classList.contains("MdRGT07Cont")) {
				// TODO :not(.MdNonDisp) to exclude not-yet-posted messages,
				// 		but that is unlikely to be a problem here.
				// 		Also, offscreen times may have .MdNonDisp on them
				// TODO Explicitly look for the most recent date element,
				//      as it might not have been one of the new items in msgList
				const timeElement = child.querySelector("time")
				if (timeElement) {
					const messageDate = await this._tryParseDate(timeElement.innerText, refDate)
					messages.push(await this._parseMessage(messageDate, child, chatType))
				}
			}
		}
		return messages
	}

	/**
	 * Parse the message list of whatever the currently-viewed chat is.
	 *
	 * @return {[MessageData]} - A list of messages.
	 */
	async parseMessageList() {
		const msgList = Array.from(document.querySelectorAll("#_chat_room_msg_list > div[data-local-id]"))
		msgList.sort((a,b) => a.getAttribute("data-local-id") - b.getAttribute("data-local-id"))
		return await this._tryParseMessages(msgList, this.getChatType(this.getCurrentChatID()))
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

	getParticipantListItemID(element) {
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
			const id = this.getParticipantListItemID(child) || this.getUserIdFromFriendsList(name)
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

	getChatListItemID(element) {
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
	 * @param {?string} knownID - The ID of this element, if it is known.
	 * @return {ChatListInfo}   - The info in the element.
	 */
	parseChatListItem(element, knownID) {
		return !element.classList.contains("chatList") ? null : {
			id: knownID || this.getChatListItemID(element),
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
			} else if (change.target.tagName == "LI") {
				if (change.target.classList.contains("ExSelected")) {
					console.log("Not using chat list mutation response for currently-active chat")
					continue
				}
				for (const node of change.addedNodes) {
					const chat = this.parseChatListItem(node)
					if (chat) {
						console.log("Changed chat list item:", chat)
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
		this.removeChatListObserver()
		this.chatListObserver = new MutationObserver(async (mutations) => {
			// Wait for pending sent messages to be resolved before responding to mutations
			try {
				await this.ownMsgPromise
			} catch (e) {}

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

	/**
	 * @param {[MutationRecord]} mutations - The mutation records that occurred
	 * @param {str} chatID - The ID of the chat being observed.
	 * @private
	 */
	_observeReceiptsDirect(mutations, chatID) {
		let receipt_id
		for (const change of mutations) {
			if ( change.target.classList.contains("mdRGT07Read") &&
				!change.target.classList.contains("MdNonDisp")) {
				const msgElement = change.target.closest(".mdRGT07Own")
				if (msgElement) {
					let id = +msgElement.getAttribute("data-local-id")
					if (!receipt_id || receipt_id < id) {
						receipt_id = id
					}
				}
			}
		}

		if (receipt_id) {
			window.__mautrixReceiveReceiptDirectLatest(chatID, receipt_id).then(
				() => console.debug(`Receipt sent for message ${receipt_id}`),
				err => console.error(`Error sending receipt for message ${receipt_id}:`, err))
		}
	}

	/**
	 * @param {[MutationRecord]} mutations - The mutation records that occurred
	 * @param {str} chatID - The ID of the chat being observed.
	 * @private
	 */
	_observeReceiptsMulti(mutations, chatID) {
		const ids = new Set()
		const receipts = []
		for (const change of mutations) {
			const target = change.type == "characterData" ? change.target.parentElement : change.target
			if ( change.target.classList.contains("mdRGT07Read") &&
				!change.target.classList.contains("MdNonDisp"))
			{
				const msgElement = change.target.closest(".mdRGT07Own")
				if (msgElement) {
					const id = +msgElement.getAttribute("data-local-id")
					if (!ids.has(id)) {
						ids.add(id)
						receipts.push({
							id: id,
							count: this._getReceiptCount(change.target),
						})
					}
				}
			}
		}

		if (receipts.length > 0) {
			window.__mautrixReceiveReceiptMulti(chatID, receipts).then(
				() => console.debug(`Receipts sent for ${receipts.length} messages`),
				err => console.error(`Error sending receipts for ${receipts.length} messages`, err))
		}
	}

	/**
	 * Add a mutation observer to the message list of the current chat.
	 * Used for observing new messages & read receipts.
	 */
	addMsgListObserver() {
		const chat_room_msg_list = document.querySelector("#_chat_room_msg_list")
		if (!chat_room_msg_list) {
			console.debug("Could not start msg list observer: no msg list available!")
			return
		}
		this.removeMsgListObserver()

		const chatID = this.getCurrentChatID()
		const chatType = this.getChatType(chatID)

		let orderedPromises = [Promise.resolve()]
		this.msgListObserver = new MutationObserver(changes => {
			let msgList = []
			for (const change of changes) {
				change.addedNodes.forEach(child => {
					if (child.tagName == "DIV" && child.hasAttribute("data-local-id")) {
						msgList.push(child)
					}
				})
			}
			if (msgList.length == 0) {
				return
			}
			msgList.sort((a,b) => a.getAttribute("data-local-id") - b.getAttribute("data-local-id"))
			if (!this._observeOwnMessage(msgList)) {
				let prevPromise = orderedPromises.shift()
				orderedPromises.push(new Promise(resolve => prevPromise
					.then(() => this._tryParseMessages(msgList, chatType))
					.then(msgs => window.__mautrixReceiveMessages(chatID, msgs))
					.then(() => resolve())
				))
			}
		})
		this.msgListObserver.observe(
			chat_room_msg_list,
			{ childList: true })

		console.debug("Started msg list observer")


		const observeReadReceipts = (
			chatType == ChatTypeEnum.DIRECT ?
			this._observeReceiptsDirect :
			this._observeReceiptsMulti
			).bind(this)

		this.receiptObserver = new MutationObserver(changes => {
			try {
				observeReadReceipts(changes, chatID)
			} catch (err) {
				console.error("Error observing msg list mutations:", err)
			}
		})
		this.receiptObserver.observe(
			chat_room_msg_list, {
				subtree: true,
				attributes: true,
				attributeFilter: ["class"],
				// TODO Consider using the same observer to watch for "ⓘ Decrypting..."
				characterData: chatType != ChatTypeEnum.DIRECT,
			})

		console.debug("Started receipt observer")
	}

	_observeOwnMessage(msgList) {
		if (!this.promiseOwnMsgSuccessSelector) {
			// Not waiting for a pending sent message
			return false
		}
		if (this.visibleSuccessObserver) {
			// Already found a element that we're waiting on becoming visible
			return true
		}

		for (const ownMsg of msgList.filter(msg => msg.classList.contains("mdRGT07Own"))) {
			const successElement =
				ownMsg.querySelector(this.promiseOwnMsgSuccessSelector)
			if (successElement) {
				if (successElement.classList.contains("MdNonDisp")) {
					console.log("Invisible success")
					console.log(successElement)
				} else {
					console.debug("Already visible success, must not be it")
					console.debug(successElement)
					continue
				}
			} else {
				continue
			}

			const failureElement =
				this.promiseOwnMsgFailureSelector &&
				ownMsg.querySelector(this.promiseOwnMsgFailureSelector)
			if (failureElement) {
				if (failureElement.classList.contains("MdNonDisp")) {
					console.log("Invisible failure")
					console.log(failureElement)
				} else {
					console.debug("Already visible failure, must not be it")
					console.log(failureElement)
					continue
				}
			} else if (this.promiseOwnMsgFailureSelector) {
				continue
			}

			console.log("Found invisible element, wait")
			const msgID = +ownMsg.getAttribute("data-local-id")
			this.visibleSuccessObserver = new MutationObserver(
				this._getOwnVisibleCallback(msgID))
			this.visibleSuccessObserver.observe(
				successElement,
				{ attributes: true, attributeFilter: ["class"] })

			if (this.promiseOwnMsgFailureSelector) {
				this.visibleFailureObserver = new MutationObserver(
					this._getOwnVisibleCallback())
				this.visibleFailureObserver.observe(
					failureElement,
					{ attributes: true, attributeFilter: ["class"] })
			}

			return true
		}
		return false
	}

	_getOwnVisibleCallback(msgID=null) {
		const isSuccess = !!msgID
		return changes => {
			for (const change of changes) {
				if (!change.target.classList.contains("MdNonDisp")) {
					console.log(`Waited for visible ${isSuccess ? "success" : "failure"}`)
					console.log(change.target)
					isSuccess ? this._resolveOwnMessage(msgID) : this._rejectOwnMessage(change.target)
					return
				}
			}
		}
	}

	_resolveOwnMessage(msgID) {
		if (!this.promiseOwnMsgResolve) return
		const resolve = this.promiseOwnMsgResolve
		this._promiseOwnMsgReset()

		window.__mautrixReceiveMessageID(msgID).then(
			() => resolve(msgID))
	}

	_rejectOwnMessage(failureElement = null) {
		if (!this.promiseOwnMsgReject) return
		const reject = this.promiseOwnMsgReject
		this._promiseOwnMsgReset()

		reject(failureElement)
	}

	_promiseOwnMsgReset() {
		this.promiseOwnMsgSuccessSelector = null
		this.promiseOwnMsgFailureSelector = null
		this.promiseOwnMsgResolve = null
		this.promiseOwnMsgReject = null

		if (this.visibleSuccessObserver) {
			this.visibleSuccessObserver.disconnect()
		}
		this.visibleSuccessObserver = null
		if (this.visibleFailureObserver) {
			this.visibleFailureObserver.disconnect()
		}
		this.visibleFailureObserver = null
	}

	removeMsgListObserver() {
		let result = false
		if (this.msgListObserver !== null) {
			this.msgListObserver.disconnect()
			this.msgListObserver = null
			console.debug("Disconnected msg list observer")
			result = true
		}
		if (this.receiptObserver !== null) {
			this.receiptObserver.disconnect()
			this.receiptObserver = null
			console.debug("Disconnected receipt observer")
			result = true
		}
		return result
	}

	addQRChangeObserver(element) {
		this.removeQRChangeObserver()
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
		this.removeQRAppearObserver()
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
		this.removeEmailAppearObserver()
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
		this.removePINAppearObserver()
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
		this.removeExpiryObserver()
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
