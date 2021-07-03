# Minimum Requirements
* Python 3.8
* Node 10.18.1
* yarn 1.22.x

# Optional Requirements
* `xdotool` - required for reliably running the Puppeteer module headless in a background X server. See [puppet/README.md](puppet/README.md)

# Initial setup
## Puppeteer module
1. Download a .crx or .zip file of the [LINE Chrome extension](https://chrome.google.com/webstore/detail/line/ophjlpahpchlmihnnnihgmmeilfjmjjc) (current version: 2.4.5)
    * The recommended way of doing this is with the [CRX Extractor/Downloader](https://chrome.google.com/webstore/detail/crx-extractordownloader/ajkhmmldknmfjnmeedkbkkojgobmljda) extension for Chrome/Chromium:
        1. Install that extension in a Chrome/Chromium instance of your choice
        2. Navigate to the Web Store page for the LINE extension
        3. Click the "CRX" button in the browser toolbar
        4. Select "Download as CRX" or "Download as ZIP"
1. Extract the downloaded .crx/.zip file to `puppet/extension_files`
    * This can be done with `unzip <*.crx|*.zip> -d puppet/extension_files`, or with a GUI tool like GNOME File Roller
1. `cd` to the `puppet` directory and run `yarn --production`
1. Copy `puppet/example-config.json` to `puppet/config.json`
1. If your system's CPU architecture is not x86\_64, the version of Chromium bundled with Puppeteer will not work, and the following steps are required:
    1. Install Chrome/Chromium from your distribution's package manager
    1. Set `executable_path` in `puppet/config.json` to the path to the installed Chrome/Chromium binary
1. Run `node prep_helper.js` to open Chrome/Chromium with the downloaded LINE extension enabled, and click on the LINE icon next to the URL bar
1. Once the LINE popup appears, press F12 to show DevTools, which will reveal the LINE extension's UUID
1. Edit `puppet/config.json` with some important settings:
    * set `"url"` to the UUID found in the previous step
    * set the `"listen"` settings to the socket to use for communication with the bridge (see [puppet/README.md](puppet/README.md) for details)

## Bridge
1. `cd` to the project root directory and create a Python virtual environment with `python3 -m venv .venv`, and enter it with `source .venv/bin/activate`
1. Install Python requirements:
    * `pip install -Ur requirements.txt` for base functionality
    * `pip install -Ur optional_requirements.txt` for [end-to-bridge](https://docs.mau.fi/bridges/general/end-to-bridge-encryption.html) encryption and metrics
1. Copy `matrix_puppeteer_line/example-config.yaml` to `config.yaml`, and update it with the proper settings to connect to your homeserver
    * In particular, be sure to set the `puppeteer.connection` settings to use the socket you chose in `puppet/config.json`
1. Run `python -m matrix_puppeteer_line -g` to generate an appservice registration file, and update your homeserver configuration to accept it

# Running
1. In the `puppet` directory, launch the Puppeteer module with `yarn start` or `node src/main.js`
1. In the project root directory, run the bridge with `python -m matrix_puppeteer_line`
1. Start a chat with the bot and follow the instructions

# Running the Puppeteer module headless
Puppeteer cannot be run in headless mode when using Chrome/Chromium with extensions (including the LINE extension).

As a workaround, it may be run in a background X server. This allows running the Puppeteer module on a GUI-less server.

An easy way to do so is to install `xvfb` from your distribution, and run the Puppeteer module with `xvfb-run yarn start`.

# Upgrading
Simply `git pull` or `git rebase` the latest changes, and rerun any installation commands (`yarn --production`, `pip install -Ur ...`).

To upgrade the LINE extension used by Puppeteer, simply download a .crx/.zip of the latest version of the extension, and extract it in the same location as for initial setup.
