// matrix-appservice-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
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

export default class TaskQueue {
	constructor(id) {
		this.id = id
		this._tasks = []
		this.running = false
		this._wakeup = null
	}

	log(...text) {
		console.log(`[TaskQueue/${this.id}]`, ...text)
	}

	error(...text) {
		console.error(`[TaskQueue/${this.id}]`, ...text)
	}

	async _run() {
		this.log("Started processing tasks")
		while (this.running) {
			if (this._tasks.length === 0) {
				this.log("Sleeping until a new task is received")
				await new Promise(resolve => this._wakeup = () => {
					resolve()
					this._wakeup = null
				})
				if (!this.running) {
					break
				}
				this.log("Continuing processing tasks")
			}
			const { task, resolve, reject } = this._tasks.shift()
			await task().then(resolve, reject)
		}
		this.log("Stopped processing tasks")
	}

	/**
	 * @callback Task
	 * @return {Promise<any>}
	 */

	/**
	 * Push a task to the queue.
	 *
	 * @param {Task} task - The task to run
	 * @return {Promise<any>} - A promise that resolves to the return value of the task
	 */
	push(task) {
		if (!this.running) {
			throw Error("task queue is not running")
		}
		if (this._wakeup !== null) {
			this._wakeup()
		}
		return new Promise((resolve, reject) => this._tasks.push({ task, resolve, reject }))
	}

	/**
	 * Start handling tasks
	 */
	start() {
		if (this.running) {
			return
		}
		this.running = true
		this._run().catch(err => this.error("Fatal error processing tasks:", err))
	}

	/**
	 * Stop handling tasks.
	 */
	stop() {
		if (!this.running) {
			return
		}
		this.running = false
		if (this._wakeup !== null) {
			this._wakeup()
		}
	}
}
