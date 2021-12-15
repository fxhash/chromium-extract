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
  // global definitions
  let capture

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

    // compose the URL from the CID
    // const url = `chrome://gpu`
    const url = `https://ipfs.io/ipfs/${cid}`
  
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--use-angle=gl-egl'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    })
  
    // browse to the page
    const viewportSettings = {
      deviceScaleFactor: 1,
    }
    if (mode === "VIEWPORT") {
      viewportSettings.width = resX
      viewportSettings.height = resY
    }
    else {
      viewportSettings.width = 800
      viewportSettings.height = 800
    }
    let page = await browser.newPage()
    await page.setViewport(viewportSettings)

    // try to reach the page
    let response
    try {
      response = await page.goto(url, {
        timeout: 90000,
        waitUntil: "domcontentloaded"
      })
    }
    catch (err) {
      if (err && err.name && err.name === "TimeoutError") {
        throw ERRORS.TIMEOUT
      }
      else {
        throw ERRORS.UNKNOWN
      }
    }

    // if the response is not 200 (success), we want to throw
    if (response.status() !== 200) {
      throw ERRORS.HTTP_ERROR
    }

    // wait for the time provided by the user
    await sleep(delay)

    try {
      // based on the capture mode use different capture strategies
      if (mode === "VIEWPORT") {
        // we simply take a capture of the viewport
        capture = await page.screenshot()
      }
      else if (mode === "CANVAS") {
        const base64 = await page.$eval(selector, (el) => {
          if (!el || el.tagName !== "CANVAS") return null
          return el.toDataURL()
        })
        if (!base64) throw null
        const pureBase64 = base64.replace(/^data:image\/png;base64,/, "")
        capture = Buffer.from(pureBase64, "base64")
      }
    }
    catch(err) {
      throw ERRORS.CANVAS_CAPTURE_FAILED
    }

    browser.close()


    fs.writeFileSync("/parent/test.png", capture)
  }
  catch (error) {
    throw error
  }
})()