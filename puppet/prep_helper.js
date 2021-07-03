// matrix-puppeteer-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
// Copyright (C) 2020-2021 Tulir Asokan, Andrew Ferrazzutti
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
import puppeteer from "puppeteer"
import fs from "fs"

import arg from "arg"

const args = arg({
	"--config": String,
	"--browser": String,
	"-c": "--config",
	"-b": "--browser",
})

const configPath = args["--config"] || "config.json"

console.log("[Main] Reading config from", configPath)
const config = JSON.parse(fs.readFileSync(configPath).toString())
const extensionDir = config.extension_dir || "extension_files"
const executablePath = args["--browser"] || config.executable_path;

(async () =>
{
	await puppeteer.launch({
		executablePath: executablePath,
		headless: false,
		args: [
				`--disable-extensions-except=${extensionDir}`,
			`--load-extension=${extensionDir}`
		],
		timeout: 0,
    })
})()
