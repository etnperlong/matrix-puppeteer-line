# Features & roadmap

* Matrix → LINE
  * [ ] Message content
    * [x] Text
    * [ ] Media
    * [ ] Stickers
    * [ ] Read receipts (currently eagerly-sent since message sync requires "reading" a chat)
* LINE → Matrix
  * [ ] Message content
    * [x] Text
    * [ ] Media
    * [ ] Stickers & special emoji
    * [ ] Read receipts
  * [ ] Notification for message send failure
  * [x] Message history
    * [x] When creating portal
    * [x] Missed messages
    * [x] Message timestamps
  * [x] Chat types
    * [x] Direct chats
    * [x] Groups (named chats)
    * [x] Rooms (unnamed chats / "multi-user direct chats")
* Misc
  * [x] Automatic portal creation
    * [x] At startup
    * [x] When receiving invite or message
    * [ ] When sending message in new chat from LINE app
  * [ ] Provisioning API for logging in
  * [x] Use bridge bot for messages sent from LINE app (when double-puppeting is disabled and `bridge.invite_own_puppet_to_pm` is enabled)
  * [x] Use own Matrix account for messages sent from LINE app (when double-puppeting is enabled)
  * [x] E2EE in Matrix rooms
  * [ ] No display required for Puppeteer-controlled browser
  * [ ] Multiple bridge users

## Missing features
### Missing from LINE
* Typing notifications
* Message edits
* Formatted messages

### Missing from LINE on Chrome:
* Message redaction (delete/unsend)
* Replies
* Voice messages
* Voice/video calls
* Unlimited message history

### Missing from matrix-puppeteer-line
* TODO
