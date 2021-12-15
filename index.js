const { Command } = require("commander")
const fs = require("fs")
const puppeteer = require("puppeteer-core")
const sharp = require("sharp")


// DEFINITIONS
// sleep X milliseconds
const sleep = (time) => new Promise(resolve => {
  setTimeout(resolve, time)
})
// possible output errors
const ERRORS = {
  UNKNOWN:                    "UNKNOWN",
  HTTP_ERROR:                 "HTTP_ERROR",
  INVALID_MODE:               "INVALID_MODE",
  MISSING_PARAMETERS:         "MISSING_PARAMETERS",
  INVALID_PARAMETERS:         "INVALID_PARAMETERS",
  UNSUPPORTED_URL:            "UNSUPPORTED_URL",
  CANVAS_CAPTURE_FAILED:      "CANVAS_CAPTURE_FAILED",
  TIMEOUT:                    "TIMEOUT",
  EXTRACT_FEATURES_FAILED:    "EXTRACT_FEATURES_FAILED"
}

// process the raw features extracted into attributes
function processRawTokenFeatures(rawFeatures) {
  const features = []
  // first check if features are an object
  if (typeof rawFeatures !== "object" || Array.isArray(rawFeatures) || !rawFeatures) {
    throw null
  }
  // go through each property and process it
  for (const name in rawFeatures) {
    // chack if propery is accepted type
    if (!(typeof rawFeatures[name] === "boolean" || typeof rawFeatures[name] === "string" || typeof rawFeatures[name] === "number")) {
      continue
    }
    // all good, the feature can be added safely
    features.push({
      name,
      value: rawFeatures[name]
    })
  }
  return features
}

// process the command line arguments
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
  let capture,
      features = []

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

      // if the capture is too big, we want to reduce its size
      if (capture.byteLength > 10*1024*1024) {
        capture = await sharp(capture)
          .resize(1024, 1024, { fit: "inside" })
          .jpeg({ quality: 100 })
          .toBuffer()
      }
    }
    catch(err) {
      throw ERRORS.CANVAS_CAPTURE_FAILED
    }


    // EXTRACT FEATURES
    // find $fxhashFeatures in the window object
    let rawFeatures = null
    try {
      const extractedFeatures = await page.evaluate(
        () => JSON.stringify(window.$fxhashFeatures)
      )
      rawFeatures = (extractedFeatures && JSON.parse(extractedFeatures)) || null
    }
    catch {
      throw ERRORS.EXTRACT_FEATURES_FAILED
    }
    
    // turn raw features into attributed
    try {
      features = processRawTokenFeatures(rawFeatures)
    }
    catch {}

    // if features are still undefined, we assume that there are none
    features = features || []

    // call for the close of the browser, but don't wait for it
    browser.close()

    // todo: save the settings to AWS, under a defined directory where CID is the key
    fs.writeFileSync("/parent/test.png", capture)
    fs.writeFileSync("/parent/features.txt", JSON.stringify(features))
  }
  catch (error) {
    throw error
  }
})()