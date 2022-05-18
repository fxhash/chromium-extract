import axios from "axios"
import { JobRequest } from "../types/Jobs"
import { bufferToBase64 } from "../utils/files"
import { JobsClass } from "./Jobs"


/**
 * This is a temporary service which offers an access to the cloud functions running without a
 * GPU, because for now no-GPU rendering is done with another service than with GPUs
 */
export class JobsNoGPU extends JobsClass {
  async addJob(request: JobRequest): Promise<void> {
    try {
      const settings = request.params.captureSettings

      console.log(`received job, settings:`)
      console.log(request.params)

      // call the NO_GPU capture instance to get a Buffer of the capture
      const responseCapture = await axios.post<any>(process.env.API_CAPTURE_NO_GPU!, {
        url: settings.url,
        mode: settings.mode,
        triggerMode: settings.triggerMode,
        resX: settings.resolution!.x,
        resY: settings.resolution!.y,
        delay: settings.delay,
        canvasSelector: settings.canvasSelector,
      }, {
        responseType: "arraybuffer"
      })

      console.log("capture OK")

      // if the request requires features too, we call the API to extract features
      let features = undefined
      if (request.params.withFeatures) {
        const responseFeatures = await axios.post<any>(process.env.API_FEATURES_NO_GPU!, {
          url: settings.url,
        }, {
          responseType: "json"
        })
        features = responseFeatures.data
      }

      // turn the capture into a base64 string
      const captureBase64 = await bufferToBase64(responseCapture.data)

      // resolve with data
      request.resolve({
        type: "success",
        data: {
          captureBase64,
          features
        }
      })
    }
    catch(err) {
      console.log(err)
      // we respond with an error
      request.resolve({
        type: "failure",
        error: "ERROR"
      })
    }
  }
}