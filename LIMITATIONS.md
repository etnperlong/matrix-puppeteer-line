# Limitations & missing features
Not all features of LINE are supported by the LINE Chrome extension on which this bridge relies, and not all Matrix features are available in LINE. This section documents all known features missing from LINE that this bridge cannot provide.

## Missing from LINE
* Typing notifications
* Message edits
* Formatted messages
* Presence
* Timestamped read receipts
* Read receipts between users other than yourself
* Identity of who read a message in a multi-user chat

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
