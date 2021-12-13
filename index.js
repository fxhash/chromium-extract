const { Command } = require("commander")
const fs = require("fs")
const puppeteer = require("puppeteer-core")


// DEFINITIONS
// sleep X milliseconds
const sleep = (time) => new Promise(resolve => {
  setTimeout(resolve, time)
})
// possible output errors
const ERRORS = {
  UNKNOWN:                "UNKNOWN",
  HTTP_ERROR:             "HTTP_ERROR",
  INVALID_MODE:           "INVALID_MODE",
  MISSING_PARAMETERS:     "MISSING_PARAMETERS",
  INVALID_PARAMETERS:     "INVALID_PARAMETERS",
  UNSUPPORTED_URL:        "UNSUPPORTED_URL",
  CANVAS_CAPTURE_FAILED:  "CANVAS_CAPTURE_FAILED",
  TIMEOUT:                "TIMEOUT",
}

const program = new Command()

program
  .requiredOption('--cid <cid>', 'The CID of the resource to fetch')
  .requiredOption('--mode <mode>', 'The mode of the capture')
  .requiredOption('--delay <delay>', 'The delay before the capture is taken')
  .option('--resX <resX>', 'The width of the viewport, in case of mode VIEWPORT')
  .option('--resY <resY>', 'The height of the viewport, in case of mode VIEWPORT')
  .option('--selector <selector>', 'The CSS selector to target the CANVAS, in case of a capture')
  .option('--features', 'Should features be extracted as well ?')

program.parse(process.argv);

(async () => {
  try {

    let { cid, mode, delay, resX, resY, selector, features } = program.opts()
  
    // change delay type from string to int
    delay = parseInt(delay)
  
    // parameters check
    // check if mode is allowed
    if (!["CANVAS", "VIEWPORT", "CUSTOM".includes(mode)]) {
      throw ERRORS.INVALID_MODE
    }
    // check parameters correct based on mode
    if (mode === "VIEWPORT") {
      if (!resX || !resY) {
        throw ERRORS.MISSING_PARAMETERS
      }
      resX = Math.round(resX)
      resY = Math.round(resY)
      if (isNaN(resX) || isNaN(resY) || resX < 256 || resX > 2048 || resY < 256 || resY > 2048) {
        throw ERRORS.INVALID_PARAMETERS
      }
      if (delay < 0 || delay > 40000) {
        throw ERRORS.INVALID_PARAMETERS
      }
    }
    else if (mode === "CANVAS") {
      if (!selector || isNaN(delay) || delay < 0 || delay > 40000) {
        throw ERRORS.INVALID_PARAMETERS
      }
    }
  
    console.log(process.env.PUPPETEER_EXECUTABLE_PATH)

    console.log("test")
    console.log({ cid, mode, delay, resX, resY, selector, features })
  
    console.log("hey browser")
    const browser = await puppeteer.launch({
      args: [ '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage' ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    })
    console.log("hey page")
    const page = await browser.newPage()
    console.log("hey google")
    await page.goto("https://google.com")
    console.log("hey title")
    const title = await page.title()
  
    console.log(title)
  
    await browser.close()
    fs.writeFileSync("./output.txt", JSON.stringify({ cid, mode, delay, resX, resY, selector, features }))
  }
  catch (error) {
    throw error
  }
})()