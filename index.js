const { Command } = require("commander")
const fs = require("fs")
const puppeteer = require("puppeteer-core")
const sharp = require("sharp")
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3")


//
// DEFINITIONS
//

const DELAY_MIN = 0
const DELAY_MAX = 300000

// the different capture modes
const CAPTURE_MODES = [
  "CANVAS",
  "VIEWPORT",
]
// the different trigger modes
const TRIGGER_MODES = [
  "DELAY",
  "FN_TRIGGER",
]
// possible output errors
const ERRORS = {
  UNKNOWN: "UNKNOWN",
  HTTP_ERROR: "HTTP_ERROR",
  MISSING_PARAMETERS: "MISSING_PARAMETERS",
  INVALID_TRIGGER_PARAMETERS: "INVALID_TRIGGER_PARAMETERS",
  INVALID_PARAMETERS: "INVALID_PARAMETERS",
  UNSUPPORTED_URL: "UNSUPPORTED_URL",
  CANVAS_CAPTURE_FAILED: "CANVAS_CAPTURE_FAILED",
  TIMEOUT: "TIMEOUT",
  EXTRACT_FEATURES_FAILED: "EXTRACT_FEATURES_FAILED",
}

//
// UTILITY FUNCTIONS
//

// sleep X milliseconds
const sleep = (time) => new Promise(resolve => {
  setTimeout(resolve, time)
})

// generic function which resolves once the waiting conditions to take a preview
// are met (delay, programmatic trigger)
const waitPreview = (triggerMode, page, delay) => new Promise(async (resolve) => {
  let resolved = false
  if (triggerMode === "DELAY") {
    console.log("waiting for delay:", delay)
    await sleep(delay)
    resolve()
  }
  else if (triggerMode === "FN_TRIGGER") {
    console.log("waiting for function trigger...")
    Promise.race([
      // add event listener and wait for event to fire before returning
      page.evaluate(function () {
        return new Promise(function (resolve, reject) {
          window.addEventListener("fxhash-preview", function () {
            resolve() // resolves when the event fires
          })
        })
      }),
      sleep(DELAY_MAX)
    ]).then(resolve)
  }
})

// given a trigger mode and an optionnal delay, returns true of false depending on the
// validity of the trigger input settings
function isTriggerValid(triggerMode, delay) {
  if (!TRIGGER_MODES.includes(triggerMode)) {
    return false
  }
  if (triggerMode === "DELAY") {
    // delay must be defined if trigger mode is delay
    return typeof delay !== undefined && !isNaN(delay) && delay >= DELAY_MIN && delay <= DELAY_MAX
  }
  else if (triggerMode === "FN_TRIGGER") {
    // fn trigger doesn't need any param
    return true
  }
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
  .requiredOption('--url <url>', 'The URL of the resource to fetch')
  .requiredOption('--mode <mode>', 'The mode of the capture')
  .option('--trigger <trigger>', 'The trigger mode of the capture (DELAY, FN_TRIGGER)')
  .option('--delay <delay>', 'The delay before the capture is taken')
  .option('--resX <resX>', 'The width of the viewport, in case of mode VIEWPORT')
  .option('--resY <resY>', 'The height of the viewport, in case of mode VIEWPORT')
  .option('--selector <selector>', 'The CSS selector to target the CANVAS, in case of a capture')

program.parse(process.argv)

const main = async () => {
  // global definitions
  let capture,
    captureName,
    features = []

  try {
    let { url, mode, trigger: triggerMode, delay, resX, resY, selector, features } = program.opts()

    console.log("running capture with params:", {
      url,
      mode,
      resX,
      resY,
      triggerMode,
      delay,
      selector,
    })

    // default parameter for triggerMode
    if (typeof triggerMode === "undefined") {
      triggerMode = "DELAY"
    }

    //
    // Checking parameters validity
    //

    // general parameters
    if (!url || !mode) {
      throw ERRORS.MISSING_PARAMETERS
    }
    if (!CAPTURE_MODES.includes(mode)) {
      throw ERRORS.INVALID_PARAMETERS
    }

    // parameters based on selected mode
    if (mode === "VIEWPORT") {
      if (!resX || !resY) {
        throw ERRORS.MISSING_PARAMETERS
      }
      resX = Math.round(resX)
      resY = Math.round(resY)
      if (isNaN(resX) || isNaN(resY) || resX < 256 || resX > 2048 || resY < 256 || resY > 2048) {
        throw ERRORS.INVALID_PARAMETERS
      }
      if (delay < DELAY_MIN || delay > DELAY_MAX) {
        throw ERRORS.INVALID_PARAMETERS
      }
    }
    else if (mode === "CANVAS") {
      if (!selector) {
        throw ERRORS.INVALID_PARAMETERS
      }
    }

    console.log("bootstrapping chromium...")

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--use-gl=egl',
        '--enable-logging'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    })

    console.log("configuring page...")
    
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

    page.on('console', msg => console.log('PAGE LOG:', msg.text()))

    // try to reach the page
    let response
    try {
      console.log("navigating to: ", url)
      response = await page.goto(url, {
        timeout: 200000,
        waitUntil: "domcontentloaded"
      })
      console.log(`navigated to URL with response status: ${response.status()}`);
    }
    catch (err) {
      console.log(err)
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

    try {
      // based on the capture mode use different capture strategies
      if (mode === "VIEWPORT") {
        await waitPreview(triggerMode, page, delay)
        // we simply take a capture of the viewport
        capture = await page.screenshot()
      }
      else if (mode === "CANVAS") {
        await waitPreview(triggerMode, page, delay)
        console.log("converting canvas to PNG with selector:", selector)
        // get the base64 image from the CANVAS targetted
        const base64 = await page.$eval(selector, (el) => {
          if (!el || el.tagName !== "CANVAS") return null
          return el.toDataURL()
        })
        if (!base64) throw null
        const pureBase64 = base64.replace(/^data:image\/png;base64,/, "")
        capture = Buffer.from(pureBase64, "base64")
      }

      // if the capture is too big, we want to reduce its size
      // ! we don't need to reduce the size anymore since S3 is used to store the images
      // if (capture.byteLength > 10*1024*1024) {
      //   capture = await sharp(capture)
      //     .resize(1024, 1024, { fit: "inside" })
      //     .jpeg({ quality: 100 })
      //     .toBuffer()
      // }
    }
    catch (err) {
      console.log(err)
      throw ERRORS.CANVAS_CAPTURE_FAILED
    }


    // EXTRACT FEATURES
    console.log("extracting features...")
    // find $fxhashFeatures in the window object
    let rawFeatures = null
    try {
      const extractedFeatures = await page.evaluate(
        () => {
          // v3 syntax
          if (window.$fx?._features) return JSON.stringify(window.$fx._features)
          // deprecated syntax
          return JSON.stringify(window.$fxhashFeatures)
        }
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
    catch { }

    // if features are still undefined, we assume that there are none
    features = features || []

    // call for the close of the browser, but don't wait for it
    browser.close()

    // create the S3 client
    const client = new S3Client({
      region: process.env.AWS_S3_REGION,
    })

    // the base key path
    const baseKey = process.env.AWS_BATCH_JOB_ID

    console.log("uploading capture to S3...");

    // upload the preview PNG
    await client.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: `${baseKey}/preview.png`,
      Body: capture,
      ContentType: "image/png",
    }))

    // upload the features object to a JSON file
    await client.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: `${baseKey}/features.json`,
      Body: JSON.stringify(features),
      ContentType: "application/json",
    }))

    console.log("successfully uploaded capture to S3");

    // it's a success, we write success to cloud watch
    console.log(`Successfully processed ${url}`)
    process.exit(0)
  }
  catch (error) {
    console.error(error)
    process.exit(1)
  }
}

main()