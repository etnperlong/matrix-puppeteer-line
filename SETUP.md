# Minimum Requirements
* Python 3.8
* Node 10.18.1
* xdotool

# Initial setup
## Puppeteer module
1. Download the .crx file of the [LINE Chrome extension](https://chrome.google.com/webstore/detail/line/ophjlpahpchlmihnnnihgmmeilfjmjjc) (current version: 2.4.4)
    * The recommended way of doing this is with the [CRX Extractor/Downloader](https://chrome.google.com/webstore/detail/crx-extractordownloader/ajkhmmldknmfjnmeedkbkkojgobmljda) extension for Chrome/Chromium. Simply install that extension in a Chrome/Chromium instance of your choice, then navigate to the Web Store page for the LINE extension, click the "CRX" button in the toolbar, and select "Download as CRX"
1. Extract the downloaded .crx file to `puppet/extension_files`
    * This can be done with `unzip *.crx -d puppet/extension_files`, or with a GUI tool like GNOME File Roller
1. `cd` to the `puppet` directory and run `yarn --production`
1. Run `node prep_helper.js` to open the version of Chrome downloaded by Puppeteer, and click on the LINE icon next to the URL bar
1. Once the LINE popup appears, press F12 to show DevTools, which will reveal the LINE extension's UUID
1. Copy `puppet/example-config.json` to `puppet/config.json`, and set some important settings:
    * set `"url"` to the UUID found in the previous step
    * set the `"listen"` settings to the socket to use for communication with the bridge (see [puppet/README.md](puppet/README.md) for details)

## Bridge
1. `cd` to the project root directory and create a Python virtual environment with `python -m venv .venv`, and enter it with `source .venv/bin/activate`
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
Puppeteer cannot be run in headless mode when using Chromium with extensions (including the LINE extension).

As a workaround, it may be run in a background X server. This allows running the Puppeteer module on a GUI-less server.

An easy way to do so is to install `xvfb` from your distribution, and run the Puppeteer module with `xvfb-run yarn start`.

# Upgrading
Simply `git pull` or `git rebase` the latest changes, and rerun any installation commands (`yarn --production`, `pip install -Ur ...`).

To upgrade the LINE extension used by Puppeteer, simply download and extract the latest .crx in the same location as for initial setup.
