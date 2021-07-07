# Features & roadmap

* Matrix → LINE
  * [ ] Message content
    * [x] Text
    * [x] Images
    * [ ] Files
    * [x] Stickers
  * [x] Read receipts<sup>[1]</sup>
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
  * [x] Read receipts<sup>[2]</sup>
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
    * [x] Join
      * [x] When message is sent by new participant
      * [x] On sync
      * [x] At join time
    * [x] Leave
      * [x] On sync
      * [x] At leave time
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

<sup>[1]</sup> Requires [MSC2409](https://github.com/matrix-org/matrix-doc/pull/2409). Without it, the bridge will always view incoming LINE messages on your behalf.
<sup>[2]</sup> LINE read receipts may be bridged later than they actually occur. The more unread chats there are, the longer this delay will be.
