### Listen config
If `type` is `unix`, `path` is the path where to create the socket.

If `type` is `tcp`, `port` and `host` are the host/port where to listen.

### Executable path
The `executable_path` specifies the path to the Chromium binary for Puppeteer to use. Leaving this setting blank will use the x86_64 Chromium installation bundled with Puppeteer. For other architectures, it is necessary to install a compatible version of Chromium (ideally via your distribution's package manager), and to set `executable_path` to the path of its binary (typically `/usr/bin/chromium`).

### Profile directory
The `profile_dir` specifies which directory to put Chromium user data directories.

### Extension directory
The `extension_dir` specifies which directory contains the files for the LINE extension, which you must download yourself.

### Cycle delay
`cycle_delay` specifies the period (in milliseconds) at which Puppeteer should view chats to check on their read receipts. Only chats with messages that haven't been fully read need to be checked. Set to a negative value to disable this checking.

### `xdotool`
Set `use_xdotool` to `true` to allow the Node process to manipulate the mouse cursor of the X server it runs in. Requires the `xdotool` utility to be installed. Highly recommended, especially when running in a background X server. Its default value is `false` so that running in a non-background X server won't interfere with a real mouse cursor.

`jiggle_delay` specifies the period (in milliseconds) for "jiggling" the mouse cursor (necessary to keep the LINE extension active). Only relevant when `use_xdotool` is `true`.

### DevTools
Set `devtools` to `true` to launch Chromium with DevTools enabled by default.
