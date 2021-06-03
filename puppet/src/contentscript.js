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
 * @param {string} chatID - The ID of the chat whose receipts are being processed.
 * @param {string} receipt_id - The ID of the most recently-read message for the current chat.
 * @return {Promise<void>}
 */
window.__mautrixReceiveReceiptDirectLatest = function (chatID, receipt_id) {}
/**
 * @param {string} chatID - The ID of the chat whose receipts are being processed.
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
 * @return {void}
 */
window.__mautrixLoggedOut = function() {}

/**
 * typedef ChatTypeEnum
 */
const ChatTypeEnum = Object.freeze({
	DIRECT: 1,
	GROUP: 2,
	ROOM: 3,
})

const MSG_DECRYPTING = "ⓘ Decrypting..."
// TODO consts for common selectors

class MautrixController {
	constructor() {
		this.chatListObserver = null
		this.msgListObserver = null
		this.receiptObserver = null

		this.qrChangeObserver = null
		this.qrAppearObserver = null
		this.emailAppearObserver = null
		this.pinAppearObserver = null
		this.ownID = null

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
	 * Parse a date separator.
	 *
	 * @param {string} text - The text in the date saparator.
	 * @return {Promise<?Date>} - The value of the date separator.
	 * @private
	 */
	async _tryParseDateSeparator(text) {
		if (!text) {
			return null
		}
		// Must prefix with midnight to prevent getting noon
		text = "00:00 " + text.replace(/\. /, "/")
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
	 * @param {string} senderName - The display name of the user to find the ID for.
	 * @return {?string}          - The user's ID if found.
	 */
	getUserIdFromFriendsList(senderName) {
		return document.querySelector(`#contact_wrap_friends > ul > li[title='${senderName}']`)?.getAttribute("data-mid")
	}

	/**
	 * @typedef MessageData
	 * @type {object}
	 * @property {number}  id          - The ID of the message. Seems to be sequential.
	 * @property {number}  timestamp   - The unix timestamp of the message. Accurate to the minute.
	 * @property {boolean} is_outgoing - Whether or not this user sent the message.
	 * @property {?Participant} sender - Full data of the participant who sent the message, if needed and available.
	 * @property {?string} html        - The HTML format of the message, if necessary.
	 * @property {?ImageInfo} image    - Information of the image in the message, if it's an image-only message.
	 * @property {?int} receipt_count  - The number of users who have read the message.
	 */

	/**
	 * @typedef ImageInfo
	 * @type {object}
	 * @property {string} url - The URL of the image's location.
	 * @property {boolean} is_sticker - Whether the sent image is a sticker.
	 * @property {boolean} animated   - Whether the sent image is animated. Only used for stickers (for now...?).
	 */

	/**
	 * Return whether a URL points to a loaded image or not.
	 *
	 * @param {string} src
	 * @return boolean
	 * @private
	 */
	_isLoadedImageURL(src) {
		return src && (
			src.startsWith(`blob:`) ||
			src.startsWith(`${document.location.origin}/res/`) && !src.startsWith(`${document.location.origin}/res/img/noimg/`))
	}

	/**
	 * Parse a message element.
	 *
	 * @param {Element} element - The message element.
	 * @param {Number} chatType - What kind of chat this message is part of.
	 * @param {Date} refDate    - The most recent date indicator. If undefined, do not retrieve the timestamp of this message.
	 * @return {Promise<MessageData>}
	 * @private
	 */
	async _parseMessage(element, chatType, refDate) {
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
			let imgElement
			sender.name = element.querySelector(".mdRGT07Body > .mdRGT07Ttl").innerText
			// Room members are always friends (right?),
			// so search the friend list for the sender's name
			// and get their ID from there.
			sender.id = this.getUserIdFromFriendsList(sender.name)
			// Group members aren't necessarily friends,
			// but the participant list includes their ID.
			// ROOMS DO NOT!! Ugh.
			if (!sender.id) {
				const participantsList = document.querySelector(participantsListSelector)
				// Groups use a participant's name as the alt text of their avatar image,
				// but rooms do not...ARGH! But they both use a dedicated element for it.
				const participantNameElement =
					Array.from(participantsList.querySelectorAll(`.mdRGT13Ttl`))
					.find(e => e.innerText == sender.name)
				if (participantNameElement) {
					imgElement = participantNameElement.previousElementSibling.firstElementChild
					sender.id = imgElement?.parentElement.parentElement.getAttribute("data-mid")
				}
			} else {
				imgElement = element.querySelector(".mdRGT07Img > img")
			}
			sender.avatar = this._getPathImage(imgElement)
			receipt_count = null
		} else {
			// TODO Get own ID and store it somewhere appropriate.
			//      Unable to get own ID from a room chat...
			// if (chatType == ChatTypeEnum.GROUP) {
			// 	const participantsList = document.querySelector("#_chat_detail_area > .mdRGT02Info ul.mdRGT13Ul")
			// 	// TODO The first member is always yourself, right?
			// 	// TODO Cache this so own ID can be used later
			// 	sender = participantsList.children[0].getAttribute("data-mid")
			// }
			const participantsList = document.querySelector(participantsListSelector)
			sender.name = this.getParticipantListItemName(participantsList.children[0])
			sender.avatar = this.getParticipantListItemAvatar(participantsList.children[0])
			sender.id = this.ownID

			receipt_count = receipt ? this._getReceiptCount(receipt) : null
		}

		const messageData = {
			id: +element.getAttribute("data-local-id"),
			timestamp:
				refDate !== undefined
				? (await this._tryParseDate(element.querySelector("time")?.innerText, refDate))?.getTime()
				: null,
			is_outgoing: is_outgoing,
			sender: sender,
			receipt_count: receipt_count,
		}

		const messageElement = element.querySelector(".mdRGT07Body > .mdRGT07Msg")
		const is_sticker = messageElement.classList.contains("mdRGT07Sticker")
		if (messageElement.classList.contains("mdRGT07Text")) {
			let msgSpan = messageElement.querySelector(".mdRGT07MsgTextInner")
			try {
				if (msgSpan.innerHTML == MSG_DECRYPTING) {
					msgSpan = await this._waitForDecryptedMessage(element, msgSpan, 5000)
				}
				messageData.html = await this._parseMessageHTML(msgSpan)
			} catch {
				// Throw to reject, but return what was parsed so far
				throw messageData
			}
		} else if (is_sticker || messageElement.classList.contains("mdRGT07Image")) {
			// TODO Animated non-sticker images require clicking its img element, which is just a thumbnail
			// Real image: "#wrap_single_image img"
			// Close button: "#wrap_single_image button"
			// Viewer is open/closed based on "#wrap_single_image.MdNonDisp" / "#wrap_single_image:not(.MdNonDisp)"
			let img = messageElement.querySelector(".mdRGT07MsgImg > img")
			if (!this._isLoadedImageURL(img.src)) {
				try {
					img = await this._waitForLoadedImage(img, 10000)
				} catch {
					// Throw to reject, but return what was parsed so far
					throw messageData
				}
			}
			messageData.image = {
				url: img.src,
				is_sticker: is_sticker,
				is_animated: is_sticker && img.parentElement.classList.contains("animationSticker"),
			}
		}
		return messageData
	}

	/**
	 * @param {Element} msgSpan
	 * @return Promise<DOMString>
	 * @private
	 */
	async _parseMessageHTML(msgSpan) {
		const msgSpanImgs = msgSpan.getElementsByTagName("img")
		if (msgSpanImgs.length == 0) {
			return msgSpan.innerHTML
		} else {
			const unloadedImgs = Array.from(msgSpanImgs).filter(img => !this._isLoadedImageURL(img.src))
			if (unloadedImgs.length > 0) {
				// NOTE Use allSettled to not throw if any images time out
				await Promise.allSettled(
					unloadedImgs.map(img => this._waitForLoadedImage(img, 2000))
				)
			}

			// Hack to put sticon dimensions in HTML (which are excluded by default)
			// in such a way that doesn't alter the elements that are in the DOM
			const msgSpanCopy = msgSpan.cloneNode(true)
			const msgSpanCopyImgs = msgSpanCopy.getElementsByTagName("img")
			for (let i = 0, n = msgSpanImgs.length; i < n; i++) {
				msgSpanCopyImgs[i].height = msgSpanImgs[i].height
				msgSpanCopyImgs[i].width  = msgSpanImgs[i].width
			}
			return msgSpanCopy.innerHTML
		}
	}

	/**
	 * @param {Element} element
	 * @param {Element} msgSpan
	 * @param {Number} timeoutLimitMillis
	 * @return {Promise<Element>}
	 * @private
	 */
	_waitForDecryptedMessage(element, msgSpan, timeoutLimitMillis) {
		console.debug("Wait for message element to finish decrypting")
		console.debug(element)
		return new Promise((resolve, reject) => {
			let observer = new MutationObserver(changes => {
				for (const change of changes) {
					const isTextUpdate = change.type == "characterData"
					const target = isTextUpdate ? msgSpan : element.querySelector(".mdRGT07MsgTextInner")
					if (target && target.innerHTML != MSG_DECRYPTING) {
						if (isTextUpdate) {
							console.debug("UNLIKELY(?) EVENT -- Found decrypted message from text update")
						} else {
							// TODO Looks like it's div.mdRGT07Body that gets always replaced. If so, watch only for that
							console.debug("Found decrypted message from element replacement")
							console.debug(target)
							console.debug("Added:")
							for (const change of changes) {
								console.debug(change.removedNodes)
							}
							console.debug("Removed:")
							for (const change of changes) {
								console.debug(change.addedNodes)
							}
						}
						observer.disconnect()
						observer = null
						resolve(target)
						return
					}
					if (target && target != msgSpan) {
						console.debug("UNLIKELY EVENT -- Somehow added a new \"decrypting\" span, it's the one to watch now")
						console.debug(target)
						msgSpan = target
						observer.observe(msgSpan, { characterData: true })
					}
				}
			})
			// Either the span element or one of its ancestors is replaced,
			// or the span element's content is updated.
			// Not exactly sure which of these happens, or if the same kind
			// of mutation always happens, so just look for them all...
			observer.observe(element, { childList: true, subtree: true })
			observer.observe(msgSpan, { characterData: true })
			setTimeout(() => {
				if (observer) {
					observer.disconnect()
					// Don't print log message, as this may be a safe timeout
					reject()
				}
			}, timeoutLimitMillis)
		})
	}

	/**
	 * @param {Element} img
	 * @param {Number} timeoutLimitMillis
	 * @return {Promise<Element>}
	 * @private
	 */
	_waitForLoadedImage(img, timeoutLimitMillis) {
		console.debug("Wait for image element to finish loading")
		console.debug(img)
		// TODO Should reject on "#_chat_message_image_failure"
		return new Promise((resolve, reject) => {
			let observer = new MutationObserver(changes => {
				for (const change of changes) {
					if (this._isLoadedImageURL(change.target.src)) {
						console.debug("Image element finished loading")
						console.debug(change.target)
						observer.disconnect()
						observer = null
						resolve(change.target)
						return
					}
				}
			})
			observer.observe(img, { attributes: true, attributeFilter: ["src"] })
			setTimeout(() => {
				if (observer) {
					observer.disconnect()
					// Don't print log message, as this may be a safe timeout
					reject()
				}
			}, timeoutLimitMillis)
		})
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
	 * @param {string} successSelector - The selector for the element that indicates the message was sent.
	 * @param {?string} failureSelector - The selector for the element that indicates the message failed to be sent.
	 */
	promiseOwnMessage(timeoutLimitMillis, successSelector, failureSelector=null) {
		this.promiseOwnMsgSuccessSelector = successSelector
		this.promiseOwnMsgFailureSelector = failureSelector

		this.ownMsgPromise = new Promise((resolve, reject) => {
			this.promiseOwnMsgResolve = resolve
			this.promiseOwnMsgReject = reject
		})
		this.promiseOwnMsgTimeoutID = setTimeout(() => {
			if (this.promiseOwnMsgReject) {
				console.error("Timed out waiting for own message to be sent")
				this._rejectOwnMessage()
			}
		}, timeoutLimitMillis)
	}

	/**
	 * Wait for a user-sent message to finish getting sent.
	 *
	 * @return {Promise<int>} - The ID of the sent message.
	 */
	async waitForOwnMessage() {
		return this.ownMsgPromise ? await this.ownMsgPromise : -1
	}

	/**
	 * Parse the message list of whatever the currently-viewed chat is.
	 *
	 * @param {int} minID - The minimum message ID to consider.
	 * @return {Promise<[MessageData]>} - A list of messages.
	 */
	async parseMessageList(minID = 0) {
		console.debug(`minID for full refresh: ${minID}`)
		const msgList =
			Array.from(document.querySelectorAll("#_chat_room_msg_list > div[data-local-id]"))
			.filter(msg =>
				msg.hasAttribute("data-local-id") &&
				(!msg.classList.contains("MdRGT07Cont") || msg.getAttribute("data-local-id") > minID))
		if (msgList.length == 0) {
			return []
		}
		const messagePromises = []
		const chatType = this.getChatType(this.getCurrentChatID())
		let refDate = null
		for (const child of msgList) {
			if (child.classList.contains("mdRGT10Date")) {
				refDate = await this._tryParseDateSeparator(child.firstElementChild.innerText)
			} else if (child.classList.contains("MdRGT07Cont")) {
				messagePromises.push(this._parseMessage(child, chatType, refDate))
			}
		}
		// NOTE No message should ever time out, but use allSettled to not throw if any do
		return (await Promise.allSettled(messagePromises))
		.filter(value => value.status == "fulfilled")
		.map(value => value.value)
	}

	/**
	 * @typedef PathImage
	 * @type object
	 * @property {?string} path - The virtual path of the image (behaves like an ID). Optional.
	 * @property {string} src   - The URL of the image. Mandatory.
	 */

	/**
	 * @param {Element} img - The image element to get the URL and path of.
	 * @return {?PathImage} - The image URL and its path, if found.
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
	 * @property {string} id         - The member ID for the participant
	 * @property {?PathImage} avatar - The path and blob URL of the participant's avatar
	 * @property {string} name       - The contact list name of the participant
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
				id: id,
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
	 *
	 * @return {[ChatListInfo]} - The list of chats.
	 */
	parseChatList() {
		const chatList = document.querySelector("#_chat_list_body")
		return Array.from(chatList.children).map(
			child => this.parseChatListItem(child.firstElementChild))
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
					console.debug("Not using chat list mutation response for currently-active chat")
					continue
				}
				for (const node of change.addedNodes) {
					const chat = this.parseChatListItem(node)
					if (chat) {
						console.log("Added chat list item:", chat)
						changedChatIDs.add(chat.id)
					} else {
						console.debug("Could not parse added node as a chat list item:", node)
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
			if (this.ownMsgPromise) {
				// Wait for pending sent messages to be resolved before responding to mutations
				try {
					await this.ownMsgPromise
				} catch (e) {}
			}

			try {
				this._observeChatListMutations(mutations)
			} catch (err) {
				console.error("Error observing chat list mutations:", err)
			}
		})
		this.chatListObserver.observe(
			document.querySelector("#_chat_list_body"),
			{ childList: true, subtree: true })
		console.log("Started chat list observer")
	}

	/**
	 * Disconnect the most recently added mutation observer.
	 */
	removeChatListObserver() {
		if (this.chatListObserver !== null) {
			this.chatListObserver.disconnect()
			this.chatListObserver = null
			console.log("Disconnected chat list observer")
		}
	}

	/**
	 * @param {[MutationRecord]} mutations - The mutation records that occurred
	 * @param {string} chatID - The ID of the chat being observed.
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
	 * @param {string} chatID - The ID of the chat being observed.
	 * @private
	 */
	_observeReceiptsMulti(mutations, chatID) {
		const ids = new Set()
		const receipts = []
		for (const change of mutations) {
			const target = change.type == "characterData" ? change.target.parentElement : change.target
			if ( target.classList.contains("mdRGT07Read") &&
				!target.classList.contains("MdNonDisp"))
			{
				const msgElement = target.closest(".mdRGT07Own")
				if (msgElement) {
					const id = +msgElement.getAttribute("data-local-id")
					if (!ids.has(id)) {
						ids.add(id)
						receipts.push({
							id: id,
							count: this._getReceiptCount(target),
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
	 * @typedef PendingMessage
	 * @type object
	 *
	 * @property {Promise<MessageData>} promise
	 * @property {Number} id
	 */

	/**
	 * @typedef SameIDMsgs
	 * @type object
	 *
	 * @property {Number} id
	 * @property {PendingMessage[]} msgs
	 * @property {Function} resolve
	 * @property {Number} numRejected
	 */

	/**
	 * Binary search for the array of messages with the provided ID.
	 *
	 * @param {SameIDMsgs[]} sortedSameIDMsgs
	 * @param {Number} id
	 * @param {boolean} returnClosest - If true, return the index of the nearest result on miss instead of -1.
	 * @return {Number} The index of the matched element, or -1 if not found.
	 */
	_findMsgsForID(
		sortedSameIDMsgs, id, returnClosest = false,
		lowerBound = 0, upperBound = sortedSameIDMsgs.length - 1)
	{
		if (lowerBound > upperBound) {
			return -1
		}
		if (returnClosest && lowerBound == upperBound) {
			// Caller must check if the result has a matching ID or not
			return sortedSameIDMsgs[lowerBound].id <= id ? lowerBound : lowerBound-1
		}
		const i = lowerBound + Math.floor((upperBound - lowerBound)/2)
		const val = sortedSameIDMsgs[i]
		if (val.id == id) {
			return i
		} else if (val.id < id) {
			return this._findMsgsForID(
				sortedSameIDMsgs, id, returnClosest,
				i+1, upperBound)
		} else {
			return this._findMsgsForID(
				sortedSameIDMsgs, id, returnClosest,
				lowerBound, i-1)
		}
	}

	/**
	 * Insert the given message to the proper inner array.
	 * In no inner array exists, insert a new one, preserving sort order.
	 * Return the wrapper of which inner array was added to or created.
	 *
	 * @param {SameIDMsgs[]} sortedSameIDMsgs
	 * @param {PendingMessage} msg
	 * @return {SameIDMsgs}
	 */
	_insertMsgByID(sortedSameIDMsgs, msg) {
		let i = this._findMsgsForID(sortedSameIDMsgs, msg.id, true)
		if (i != -1 && sortedSameIDMsgs[i].id == msg.id) {
			sortedSameIDMsgs[i].msgs.push(msg)
			console.debug("UNLIKELY(?) EVENT -- Found two new message elements with the same ID, so tracking both of them")
		} else {
			sortedSameIDMsgs.splice(++i, 0, {
				id: msg.id,
				msgs: [msg],
				numRejected: 0,
				resolve: null,
			})
		}
		return sortedSameIDMsgs[i]
	}

	/**
	 * Add a mutation observer to the message list of the current chat.
	 * Used for observing new messages & read receipts.
	 *
	 * @param {int} minID - The minimum message ID to consider.
	 */
	addMsgListObserver(minID = 0) {
		const chat_room_msg_list = document.querySelector("#_chat_room_msg_list")
		if (!chat_room_msg_list) {
			console.debug("Could not start msg list observer: no msg list available!")
			return
		}
		this.removeMsgListObserver()

		const chatID = this.getCurrentChatID()
		const chatType = this.getChatType(chatID)

		// NEED TO HANDLE:
		// * message elements arriving in any order
		// * messages being potentially pending (i.e. decrypting or loading),
		//   and resolving in a potentially different order than they arrived in
		// * pending messages potentially having multiple elements associated with
		//   them, where only one of them resolves
		// * message elements being added/removed any number of times, which may
		//   or may not ever resolve
		// * outgoing messages (i.e. sent by the bridge)
		// And must send resolved messages to the bridge *in order*!
		// BUT: Assuming that incoming messages will never be younger than a resolved one.

		const sortedSameIDMsgs = []
		const pendingMsgElements = new Set()

		this.msgListObserver = new MutationObserver(changes => {
			console.debug(`MESSAGE LIST CHANGES: check since ${minID}`)
			const remoteMsgs = []
			for (const change of changes) {
				console.debug("---new change set---")
				for (const child of change.addedNodes) {
					if (!pendingMsgElements.has(child) &&
						child.tagName == "DIV" &&
						child.hasAttribute("data-local-id") &&
						// Skip timestamps, as these are always current
						child.classList.contains("MdRGT07Cont"))
					{
						const msgID = child.getAttribute("data-local-id")
						if (msgID > minID) {
							pendingMsgElements.add(child)

							// TODO Maybe handle own messages somewhere else...?
							const ownMsg = this._observeOwnMessage(child)
							if (ownMsg) {
								console.log("Found own bridge-sent message, will wait for it to resolve")
								console.debug(child)
								this.ownMsgPromise
								.then(msgID => {
									console.log("Resolved own bridge-sent message")
									console.debug(ownMsg)
									pendingMsgElements.delete(ownMsg)
									if (minID < msgID) {
										minID = msgID
									}
								})
								.catch(() => {
									console.log("Rejected own bridge-sent message")
									console.debug(ownMsg)
									pendingMsgElements.delete(ownMsg)
								})
							} else {
								console.log("Found remote message")
								console.debug(child)
								remoteMsgs.push({
									id: msgID,
									element: child
								})
							}
						}
					}
				}
				// NOTE Ignoring removedNodes because an element can always be added back.
				//      Will simply let permanently-removed nodes time out.
			}
			if (remoteMsgs.length == 0) {
				console.debug("Found no new remote messages")
				return
			}

			// No need to sort remoteMsgs, because sortedSameIDMsgs is enough
			for (const msg of remoteMsgs) {
				const messageElement = msg.element
				const pendingMessage = {
					id: msg.id,
					promise: this._parseMessage(messageElement, chatType)
				}
				const sameIDMsgs = this._insertMsgByID(sortedSameIDMsgs, pendingMessage)

				const handleMessage = async (messageData) => {
					minID = messageData.id
					sortedSameIDMsgs.shift()
					await window.__mautrixReceiveMessages(chatID, [messageData])
					if (sortedSameIDMsgs.length > 0 && sortedSameIDMsgs[0].resolve) {
						console.debug("Allowing queued resolved message to be sent")
						console.debug(sortedSameIDMsgs[0])
						sortedSameIDMsgs[0].resolve()
					}
				}

				pendingMessage.promise.then(
				async (messageData) => {
					const i = this._findMsgsForID(sortedSameIDMsgs, messageData.id)
					if (i == -1) {
						console.debug(`Got resolved message for already-handled ID ${messageData.id}, ignore it`)
						pendingMsgElements.delete(messageElement)
						return
					}
					if (i != 0) {
						console.debug(`Got resolved message for later ID ${messageData.id}, wait for earlier messages`)
						await new Promise(resolve => sameIDMsgs.resolve = resolve)
						console.debug(`Message before ID ${messageData.id} finished, can now send this one`)
					} else {
						console.debug(`Got resolved message for earliest ID ${messageData.id}, send it`)
					}
					console.debug(messageElement)
					pendingMsgElements.delete(messageElement)
					handleMessage(messageData)
				},
				// error case
				async (messageData) => {
					console.debug("Message element rejected")
					console.debug(messageElement)
					pendingMsgElements.delete(messageElement)
					if (++sameIDMsgs.numRejected == sameIDMsgs.msgs.length) {
						// Note that if another message element with this ID somehow comes later, it'll be ignored.
						console.debug(`All messages for ID ${sameIDMsgs.id} rejected, abandoning this ID and sending dummy message`)
						// Choice of which message to send should be arbitrary
						handleMessage(messageData)
					}
				})
			}
		})
		this.msgListObserver.observe(
			chat_room_msg_list,
			{ childList: true })

		console.debug(`Started msg list observer with minID = ${minID}`)


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
				characterData: chatType != ChatTypeEnum.DIRECT,
			})

		console.debug("Started receipt observer")
	}

	_observeOwnMessage(ownMsg) {
		if (!this.ownMsgPromise) {
			// Not waiting for a pending sent message
			return null
		}

		const successElement =
			ownMsg.querySelector(this.promiseOwnMsgSuccessSelector)
		if (successElement) {
			if (successElement.classList.contains("MdNonDisp")) {
				console.log("Invisible success for own bridge-sent message, will wait for it to resolve")
				console.log(successElement)
			} else {
				console.debug("Already visible success, must not be it")
				console.debug(successElement)
				return null
			}
		} else {
			return null
		}

		const failureElement =
			this.promiseOwnMsgFailureSelector &&
			ownMsg.querySelector(this.promiseOwnMsgFailureSelector)
		if (failureElement) {
			if (failureElement.classList.contains("MdNonDisp")) {
				console.log("Invisible failure for own bridge-sent message, will wait for it (or success) to resolve")
				console.log(failureElement)
			} else {
				console.debug("Already visible failure, must not be it")
				console.log(failureElement)
				return null
			}
		} else if (this.promiseOwnMsgFailureSelector) {
			return null
		}

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

		return ownMsg
	}

	_getOwnVisibleCallback(msgID=null) {
		const isSuccess = !!msgID
		return changes => {
			for (const change of changes) {
				if (!change.target.classList.contains("MdNonDisp")) {
					console.log(`Resolved ${isSuccess ? "success" : "failure"} for own bridge-sent message`)
					console.log(change.target)
					isSuccess ? this._resolveOwnMessage(msgID) : this._rejectOwnMessage(change.target)
					return
				}
			}
		}
	}

	_resolveOwnMessage(msgID) {
		if (!this.promiseOwnMsgResolve) return
		clearTimeout(this.promiseOwnMsgTimeoutID)
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
		this.ownMsgPromise = null
		this.promiseOwnMsgSuccessSelector = null
		this.promiseOwnMsgFailureSelector = null
		this.promiseOwnMsgResolve = null
		this.promiseOwnMsgReject = null
		this.promiseOwnMsgTimeoutID = null

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

}

window.__mautrixController = new MautrixController()

/**
 * Watch for an error dialog / PIN expiry dialog to appear, and click its "OK" button.
 * Must watch for both its parent appearing & it being added to its parent in the first place.
 */
const layer = document.querySelector("#layer_contents")
new MutationObserver(() => {
	if (!layer.classList.contains("MdNonDisp")) {
		const button = layer.querySelector("dialog button")
		if (button) {
			console.log("Something expired, clicking OK button to continue")
			button.click()
		}
	}
}).observe(layer, {
	attributes: true,
	attributeFilter: ["class"],
	childList: true,
})

/**
 * Watch for being logged out.
 */
const mainApp = document.querySelector("#mainApp")
new MutationObserver(() => {
	if (mainApp.classList.contains("MdNonDisp")) {
		window.__mautrixLoggedOut()
	}
}).observe(mainApp, {
	attributes: true,
	attributeFilter: ["class"],
})
