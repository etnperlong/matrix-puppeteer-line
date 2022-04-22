* [Obtaining the LINE Chrome extension](#obtaining-the-line-chrome-extension)
* [Manual setup](#manual-setup)
    * [systemd](#systemd)
* [Docker](#docker)

---

# Obtaining the LINE Chrome extension
For all modes of deploying the bridge, it is first required to manually download a .crx or .zip file of the [LINE Chrome extension](https://chrome.google.com/webstore/detail/line/ophjlpahpchlmihnnnihgmmeilfjmjjc) (current version: 2.5.0).

The recommended way of doing this is to use the [CRX Extractor/Downloader](https://chrome.google.com/webstore/detail/crx-extractordownloader/ajkhmmldknmfjnmeedkbkkojgobmljda) extension for Chrome/Chromium:

1. Install that extension in a Chrome/Chromium instance of your choice
1. Navigate to the Web Store page for the LINE extension
1. Click the "CRX" button in the browser toolbar
1. Select "Download as CRX" or "Download as ZIP"

The downloaded .crx/.zip can then be extracted with `unzip` or with a GUI tool like GNOME File Roller.

To install updated versions of the LINE extension, simply download the .crx/.zip of the latest version of the extension, and extract it in the same location as for initial setup.

# Manual setup
These instructions describe how to install and run the bridge manually from a clone of this repository.

## Minimum requirements
* Python 3.7
* Node 14
* yarn 1.22.x (from either your distribution or `npm`)
* postgresql 11
* A LINE account on a smartphone (Android or iOS)

## Optional requirements
* `xvfb-run` for easily running the Puppeteer module in a background X server
* `xdotool` for keeping the Puppeteer module responsive when run in a background X server (see [puppet/README.md](puppet/README.md))
* Native dependencies for [end-to-bridge](https://docs.mau.fi/bridges/general/end-to-bridge-encryption.html): https://docs.mau.fi/bridges/python/optional-dependencies.html#all-python-bridges

## Initial setup

### Puppeteer module
1. Extract the downloaded .crx/.zip of the LINE Chrome extension to `puppet/extension_files`
1. `cd` to the `puppet` directory and run `yarn --production`
1. Copy `puppet/example-config.json` to `puppet/config.json`
1. If your system's CPU architecture is not x86\_64/amd64, the version of Chromium bundled with Puppeteer will not work, and the following additional steps are required:
    1. Install Chrome/Chromium from your distribution's package manager
    1. Edit `puppet/package.json` to specify the version of Puppeteer that is compatible with the version of Chrome/Chromium that you just installed, and rerun `yarn --production` (see [Puppeteer documentation](https://github.com/puppeteer/puppeteer/blob/main/docs/api.md) for a map of Puppeteer/Chromium compatibility)
    1. Set `executable_path` in `puppet/config.json` to the path to the installed Chrome/Chromium binary
1. Edit `puppet/config.json` with desired settings (see [puppet/README.md](puppet/README.md) for details)

### Bridge module
1. `cd` to the repository root and create a Python virtual environment with `python3 -m venv .venv`, and enter it with `source .venv/bin/activate`
1. Install Python requirements:
    * `pip install -Ur requirements.txt` for base functionality
    * `pip install -Ur optional-requirements.txt` for [end-to-bridge](https://docs.mau.fi/bridges/general/end-to-bridge-encryption.html) encryption and metrics
        * Note that end-to-bridge encryption requires some native dependencies. For details, see https://docs.mau.fi/bridges/python/optional-dependencies.html#all-python-bridges
1. Copy `matrix_puppeteer_line/example-config.yaml` to `config.yaml`, and update it with the proper settings to connect to your homeserver
    * In particular, be sure to set the `puppeteer.connection` settings to use the socket you chose in `puppet/config.json`
1. Run `python -m matrix_puppeteer_line -g` to generate an appservice registration file, and update your homeserver configuration to accept it

## Running manually
1. In the `puppet` directory, launch the Puppeteer module with `yarn start` or `node src/main.js`
1. In the project root directory, run the bridge module with `python -m matrix_puppeteer_line`
1. Start a chat with the bot, and use one of the `login-email` or `login-qr` commands to sync your LINE account
    * Note that on first use, you must enter a verification code on a smartphone version of LINE in order for the login to complete

### Running the Puppeteer module headless
Puppeteer cannot be run in headless mode when using Chrome/Chromium with extensions (including the LINE extension).

As a workaround, it may be run in a background X server. This allows running the Puppeteer module on a GUI-less server.

An easy way to do so is to install `xvfb` from your distribution, and run the Puppeteer module with `xvfb-run yarn start`.

## systemd
The [systemd](systemd) directory provides sample service unit configuration files for running the bridge & Puppeteer modules:

* `matrix-puppeteer-line.service` for the bridge module
* `matrix-puppeteer-line-chrome.service` for the Puppeteer module

To use them as-is, follow these steps after [initial setup](#initial-setup):

1. Install `xfvb-run`, ideally from your distribution
1. Place/link your clone of this repository in `/opt/matrix-puppeteer-line`
    * If moving your repo directory after having already created a Python virtual environment for the bridge module, re-create the virtual environment after moving to ensure its paths are up-to-date
    * Alternatively, clone it to `/opt/matrix-puppeteer-line` in the first place
1. Install the services as either system or user units
    * To install as system units:
        1. Copy/link the service files to a directory in the system unit search path, such as `/etc/systemd/system/`
        1. Create the services' configuration directory with `sudo mkdir /etc/matrix-puppeteer-line`
        1. RECOMMENDED: Create the `matrix-puppeteer-line` user on your system with `adduser` or an equivalent command, then uncomment the `User` and `Group` lines in the service files
    * To install as user units:
        1. Copy/link the service files to a directory in the user unit search path, such as `~/.config/systemd/user`
        1. Create the services' configuration directory with `mkdir $XDG_CONFIG_HOME/matrix-puppeteer-line`
1. Copy the bridge & Puppeteer module configuration files to the services' configuration directory as `config.yaml` and `puppet-config.json`, respectively
1. Start the services now and on every boot boot with `[sudo] systemd [--user] enable --now matrix-puppeteer-line{,-chrome}`

Note that stopping/restarting the bridge module service `matrix-puppeteer-line.service` does not affect the Puppeteer module service `matrix-puppeteer-line-chrome.service`, but stopping/restarting the latter will also stop/restart the former.

Thus, to shut down the bridge entirely, either stop `matrix-puppeteer-line-chrome.service`, or stop both services at once.

## Upgrading
Simply `git pull` or `git rebase` the latest changes, and rerun any installation commands (`yarn --production`, `pip install -Ur ...`).

# Docker
These instructions describe how to run the bridge with Docker containers.

## Notes
* Any `docker` commands mentioned below need to be run with `sudo` unless you have configured your system otherwise. See [Docker docs](https://docs.docker.com/engine/install/linux-postinstall/) for details.
* All configuration files created by the Docker containers will be `chown`ed to UID/GID 1337. Use `sudo` access on the host to edit them.
* The `docker` commands below mount the working directory as `/data`, so make sure you always run them in the correct directory.

## Limitations
* Images must be built manually for now. It is planned for there to be prebuilt images available to pull.
* amd64/x86\_64 is the only architecture the current Dockerfiles have been tested with. For other architectures, it is necessary to change the base image of `puppet/Dockerfile` to one that provides Chrome/Chromium for your architecture.

## Initial setup
1. `cd` to the directory where you cloned this repository
1. Ensure that the repository root and `puppet` directories are writable by UID/GID 1337. A coarse way to achieve this is with `chmod o+w . puppet`
1. Extract the downloaded .crx/.zip of the LINE Chrome extension to `puppet/extension_files`
1. `cd` to the `puppet` directory, and build the image for the Puppeteer module with `docker build . -t matrix-puppeteer-line-chrome`
1. Run a container for the Puppeteer module for the first time, so it can create a config file for you: `docker run --rm -v $(pwd):/data:z matrix-puppeteer-line-chrome`
1. Update the config to your liking, but leave the `"executable_path"` setting as-is (unless you need to use a version of Chrome/Chromium from the host or another container)
1. Run the Puppeteer module with `docker run --restart unless-stopped -v $(pwd):/data:z matrix-puppeteer-line-chrome`
1. Open a new shell, since the prior `docker run` command runs in the foreground (unless `-d` is used)
1. `cd` to the repository root, and build the image for the bridge module with `docker build . -t matrix-puppeteer-line`
1. Run a container for the bridge module for the first time, so it can create a config file for you: `docker run --rm -v $(pwd):/data:z matrix-puppeteer-line`
1. Update the config to your liking. You'll at least need to change the homeserver settings, appservice address and permissions, as well as the socket connection to the Puppeteer module
    * Note that the Puppeteer module container's `/data/` directory is accessible in the bridge module's container at `/data/puppet/`
    * Thus, if the Puppeteer module is configured to use a unix socket at `/data/<sock_name>`, the bridge module's config must set `puppeteer.connection.path: /data/puppet/<sockname>`
1. Generate the appservice registration by running the container again, and update your homeserver configuration to accept it
1. Run the bridge module with `docker run --restart unless-stopped -v $(pwd):/data:z matrix-puppeteer-line`
    * Additionally, you should either add the bridge to the same Docker network as your homeserver and database with `--network=<name>` (when they are running in Docker), or expose the correct port(s) with `-p <port>:<port>` or `--network=host` (when they are running outside Docker).

## Upgrading
Simply `git pull` or `git rebase` the latest changes, rerun all `docker build` commands, then run new containers for the freshly-built images.
