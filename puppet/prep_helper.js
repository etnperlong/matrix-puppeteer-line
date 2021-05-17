import puppeteer from "puppeteer"

(async () =>
{
    const pathToExtension = "extension_files"
    const browser = await puppeteer.launch({
        headless: false,
        args: [
            `--disable-extensions-except=${pathToExtension}`,
            `--load-extension=${pathToExtension}`
        ],
		timeout: 0,
    })
})()
