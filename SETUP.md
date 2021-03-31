# Setup
1. Download the .crx file of the [LINE Chrome extension](https://chrome.google.com/webstore/detail/line/ophjlpahpchlmihnnnihgmmeilfjmjjc) (version 2.4.3), and extract it to `puppet/extension_files`
2. `cd` to the `puppet` directory and run `yarn --production`
3. Run `node prep_helper.js` to open the version of Chrome downloaded by Puppeteer, and click on the LINE icon next to the URL bar
4. Once the LINE popup appears, press F12 to show DevTools, which will reveal the LINE extension's UUID
5. Copy `puppet/example-config.json` to `puppet/config.json`, and update it with the UUID found in the previous step
6. Launch the Puppeteer module with `yarn start` or `node src/main.js`
7. `cd` to the main directory and create a Python virtual environment with `virtualenv -p /usr/bin/python3 .venv`, and enter it with `source .venv/bin/activate`
8. Install Python requirements with `pip install -r requirements.txt`
9. Copy `matrix_puppeteer_line/example-config.yaml` to `config.yaml`, and update it with the proper settings to connect to your homeserver
10. Run `python -m matrix_puppeteer_line -g` to generate an appservice registration file, and update your homeserver configuration to accept it
11. Run the bridge with `python -m matrix_puppeteer_line`
12. Start a chat with the bot and follow the instructions
