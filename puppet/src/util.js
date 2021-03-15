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

export function promisify(func) {
	return new Promise((resolve, reject) => {
		try {
			func(err => err ? reject(err) : resolve())
		} catch (err) {
			reject(err)
		}
	})
}

export function sleep(timeout) {
	return new Promise(resolve => setTimeout(resolve, timeout))
}

export function emitLines(stream) {
	let buffer = ""
	stream.on("data", data => {
		buffer += data
		let n = buffer.indexOf("\n")
		while (~n) {
			stream.emit("line", buffer.substring(0, n))
			buffer = buffer.substring(n + 1)
			n = buffer.indexOf("\n")
		}
	})
	stream.on("end", () => buffer && stream.emit("line", buffer))
}
