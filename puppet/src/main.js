// mautrix-amp - A very hacky Matrix-SMS bridge based on using Android Messages for Web in Puppeteer
// Copyright (C) 2020 Tulir Asokan
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

import PuppetAPI from "./api.js"
import MessagesPuppeteer from "./puppet.js"

let path = process.argv[process.argv.length - 1]
if (!path.endsWith(".json")) {
	path = "config.json"
}
console.log("Reading config from", path)
const config = JSON.parse(fs.readFileSync(path).toString())
MessagesPuppeteer.profileDir = config.profile_dir

const api = new PuppetAPI(config.listen)

function stop() {
	api.stop().then(() => process.exit(0), err => {
		console.error("[Main] Error stopping:", err)
		process.exit(3)
	})
}

api.start().then(() => {
	process.once("SIGINT", stop)
	process.once("SIGTERM", stop)
}, err => {
	console.error("[Main] Error starting:", err)
	process.exit(2)
})
