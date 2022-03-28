// matrix-puppeteer-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
// Copyright (C) 2020-2022 Tulir Asokan, Andrew Ferrazzutti
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
import process from "process"
import fs from "fs"
import sd from "systemd-daemon"

import arg from "arg"

import PuppetAPI from "./api.js"
import MessagesPuppeteer from "./puppet.js"

const args = arg({
	"--config": String,
	"--browser": String,
	"--no-sandbox": Boolean,
	"-c": "--config",
	"-b": "--browser",
})

const configPath = args["--config"] || "config.json"

console.log("[Main] Reading config from", configPath)
const config = JSON.parse(fs.readFileSync(configPath).toString())
MessagesPuppeteer.executablePath = args["--browser"] || config.executable_path || MessagesPuppeteer.executablePath
MessagesPuppeteer.noSandbox = args["--no-sandbox"] || MessagesPuppeteer.noSandbox
MessagesPuppeteer.profileDir = config.profile_dir || MessagesPuppeteer.profileDir
MessagesPuppeteer.devtools = config.devtools || false
MessagesPuppeteer.extensionDir = config.extension_dir || MessagesPuppeteer.extensionDir
MessagesPuppeteer.cycleDelay = config.cycle_delay || MessagesPuppeteer.cycleDelay
MessagesPuppeteer.useXdotool = config.use_xdotool || MessagesPuppeteer.useXdotool
MessagesPuppeteer.jiggleDelay = config.jiggle_delay || MessagesPuppeteer.jiggleDelay

const api = new PuppetAPI(config.listen)

function stop() {
	api.stop().then(() => {
		console.log("[Main] Everything stopped")
		process.exit(0)
	}, err => {
		console.error("[Main] Error stopping:", err)
		process.exit(3)
	})
}

api.start().then(() => {
	process.once("SIGINT", stop)
	process.once("SIGTERM", stop)
	sd.notify("READY=1")
}, err => {
	console.error("[Main] Error starting:", err)
	process.exit(2)
})
