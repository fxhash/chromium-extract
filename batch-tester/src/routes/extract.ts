import { Express } from "express"
import { JobsFactory } from "../Services/JobsFactory"
import { CaptureSettings } from "../types/Capture"
import { JobResponse } from "../types/Jobs"
import { ExtractError, ExtractErrors } from "../types/Responses"
import { buildCaptureUrlFromCid } from "../utils/ipfs"
import { validateCaptureSettings } from "../utils/validation"

export function routeExtract(app: Express) {
  /**
   * This endpoint expects: 
   *  - capture settings: all the general capture settings
   *  - withFeatures: a boolean which indicates whether or not we should extract features as well
   * It returns a JSON response with:
   *  - base64 encoded image
   *  - features (if any)
   */
  app.post("/extract", async (req, res) => {
    // consume example
    try {
      let { url, mode, triggerMode, resX, resY, delay, canvasSelector, gpu, withFeatures, priority } = req.body

      if (!url) {
        throw ExtractError.INVALID_INPUT_PARAMETERS
      }

      // create capture settings object based on the input
      const settings: CaptureSettings = {
        url: url,
        mode: mode,
        triggerMode: triggerMode,
        resolution: {
          x: parseInt(resX),
          y: parseInt(resY),
        },
        delay: parseInt(delay),
        canvasSelector: canvasSelector,
        gpu: true,
      }

      // validate the capture settings at once
      if (!validateCaptureSettings(settings)) {
        throw ExtractError.INVALID_INPUT_PARAMETERS
      }

      const jobResponse: JobResponse = await JobsFactory.runJob({
        captureSettings: settings,
        withFeatures: !!withFeatures,
        priority: priority === "high"
      })
      
      // send the response back to the client
      return res
        .contentType("application/json")
        .send(jobResponse)
    }
    catch(err) {
      console.log(err)
      const returnError = ExtractErrors.includes(err as any) ? err : ExtractError.UNKNOWN
      return res.status(500).send({
        error: returnError
      })
    }
  })
}