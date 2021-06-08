# Features & roadmap

* Matrix → LINE
  * [ ] Message content
    * [x] Text
    * [x] Images
    * [ ] Files
    * [x] Stickers
  * [ ] Read receipts (currently eagerly-sent since message sync requires "reading" a chat)
  * [ ] Room metadata changes
    * [ ] Name
    * [ ] Avatar
  * [ ] Member events
    * [ ] Invite
    * [ ] Kick
* LINE → Matrix
  * [ ] Message content
    * [x] Text
    * [x] Images
    * [ ] Files
    * [ ] Audio
    * [ ] Location
    * [ ] Videos
    * [x] Stickers
    * [x] Emoji
  * [ ] Message unsend
  * [ ] Read receipts
    * [x] For most recently active chat
    * [ ] For any chat
  * [x] User metadata
    * [ ] Name
      * [x] On sync
      * [ ] On change
    * [ ] Avatar
      * [x] On sync
      * [ ] On change
  * [ ] Chat metadata
    * [ ] Name
      * [x] On sync
      * [ ] On change
    * [ ] Icon
      * [x] On sync
      * [ ] On change
  * [ ] Message history
    * [x] When creating portal
    * [x] Missed messages
    * [x] Message timestamps
    * [ ] As many messages that are visible in LINE extension
  * [x] Chat types
    * [x] Direct chats
    * [x] Groups (named chats)
    * [x] Rooms (unnamed chats / "multi-user direct chats")
  * [ ] Membership actions
    * [ ] Join
      * [x] When message is sent by new participant
      * [x] On sync
      * [ ] At join time
    * [ ] Leave
      * [x] On sync
      * [ ] At leave time
    * [ ] Invite
    * [ ] Remove
  * [ ] Friend actions
    * [ ] Add friend
    * [ ] Block user
    * [ ] Unblock user
* Misc
  * [x] Automatic portal creation
    * [x] At startup
    * [x] When receiving invite or message
    * [ ] When sending message in new chat from LINE app
  * [x] Notification for message send failure
  * [ ] Provisioning API for logging in
  * [x] Use bridge bot for messages sent from LINE app (when double-puppeting is disabled and `bridge.invite_own_puppet_to_pm` is enabled)
  * [x] Use own Matrix account for messages sent from LINE app (when double-puppeting is enabled)
  * [x] E2EE in Matrix rooms
  * [ ] Multiple bridge users
  * [ ] Relay bridging

# Missing features
## Missing from LINE
* Typing notifications
* Message edits
* Formatted messages
* Presence
* Timestamped read receipts
* Read receipts between users other than yourself

## Missing from LINE on Chrome
* Unlimited message history
    * Messages that are very old may not be available in LINE on Chrome at all, even after a full sync
* Voice/video calls
    * No notification is sent when a call begins
    * When a call ends, an automated message of "Your OS version doesn't support this feature" is sent as an ordinary text message from the user who began the call
* Message redaction (delete/unsend)
    * But messages unsent from other LINE clients do disappear from LINE on Chrome
* Replies
    * Appear as ordinary messages
* Mentions
    * Appear as ordinary text
* Audio message sending
    * But audio messages can be received
* Location sending
    * But locations can be received

## Missing from matrix-puppeteer-line
* TODO
