import { JobRequestParams, JobResolution, JobResponse, ResolveFnSignature } from "../types/Jobs"
import { JobsClass } from "./Jobs"
import { JobsGPU } from "./JobsGPU"
import { JobsNoGPU } from "./JobsNoGPU"

/**
 * A singleton manager Factory to interract with the different Job services
 */
class JobsFactoryClass {
  jobsGPU: JobsGPU
  jobsNoGPU: JobsNoGPU

  init() {
    this.jobsGPU = new JobsGPU()
    this.jobsNoGPU = new JobsNoGPU()
    // start services
    this.jobsGPU.start()
    this.jobsNoGPU.start()
  }

  async runJob(params: JobRequestParams): Promise<JobResponse> {
    return new Promise(async (resolve, reject) => {
      // proxy function to get the response from the jobsGPU
      const resolveJob: ResolveFnSignature = (resolution) => {
        // register job resolution
        if (resolution.type === "success" && resolution.data) {
          resolve(resolution.data)
        }
        else {
          reject(resolution.error)
        }
      }

      // depending on the GPU support, we send the job to a different service
      const jobs: JobsClass = params.captureSettings.gpu ? this.jobsGPU : this.jobsNoGPU

      // push the job to correct service, which will resolve with error or failure to the resolveJob
      // method, which will in turn either resolve with the data or reject
      await jobs.addJob({
        params,
        resolve: resolveJob
      })
    })
  }
}

export const JobsFactory = new JobsFactoryClass()