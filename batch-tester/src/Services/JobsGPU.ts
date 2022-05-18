import { JobRequest, JobWaiting } from "../types/Jobs"
import { JobsClass } from "./Jobs"
import { BatchClient, CancelJobCommand, ListJobsCommand, SubmitJobCommand, SubmitJobCommandInput } from "@aws-sdk/client-batch"
import { CaptureMode, CaptureTriggerMode } from "../types/Capture"
import { ExtractError } from "../types/Responses"
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { bufferToBase64, streamToBuffer } from "../utils/files"
import { performance } from "perf_hooks"

const FETCH_JOB_STATUS_INTERVAL_MS = parseInt(process.env.FETCH_JOB_STATUS_INTERVAL_MS)

const queueStatus = [ 
  "SUBMITTED", "PENDING", "RUNNABLE", "STARTING", "RUNNING"
] as const
type TGpuQueueStatus = typeof queueStatus[number]

export class JobsGPU extends JobsClass {
  jobs: JobWaiting[] = []
  client: BatchClient
  s3client: S3Client

  override start(): void {
    this.client = new BatchClient({
      region: process.env.AWS_REGION,
    })
    this.s3client = new S3Client({
      region: process.env.AWS_REGION,
    })
    this.loop()
  }

  override async addJob(request: JobRequest) {
    try {
      console.log("adding a GPU job to aws batch")
      console.log(request)
  
      const settings = request.params.captureSettings
  
      // build a list of optionnal CLI parameters to add to the command
      const command: string[] = [
        "node",
        "index.js",
        "--url",
        settings.url,
        "--mode",
        settings.mode,
      ]
      if (settings.mode === CaptureMode.CANVAS) {
        command.push("--selector")
        command.push(settings.canvasSelector!)
      }
      else {
        command.push("--resX")
        command.push(settings.resolution!.x as any)
        command.push("--resY")
        command.push(settings.resolution!.y as any)
      }
      if (settings.triggerMode) {
        command.push("--trigger")
        command.push(settings.triggerMode)
      }
      if (settings.delay != null && !isNaN(settings.delay)) {
        command.push("--delay")
        command.push(settings.delay as any)
      }

      console.log("--------------")
      console.log("command:")
      console.log(command)
      console.log("--------------")
  
      const jobCommand = new SubmitJobCommand({
        jobDefinition: process.env.AWS_BATCH_GPU_JOB_DEF_ARN,
        jobName: process.env.AWS_BATCH_JOB_NAME,
        jobQueue: request.params.priority ? process.env.AWS_BATCH_GPU_JOB_QUEUE_PRIORITY_ARN : process.env.AWS_BATCH_GPU_JOB_QUEUE_ARN,
        containerOverrides: {
          command,
        },
      })

      console.log(request.params.priority ? process.env.AWS_BATCH_GPU_JOB_QUEUE_PRIORITY_ARN : process.env.AWS_BATCH_GPU_JOB_QUEUE_ARN,)
  
      const response = await this.client.send(jobCommand)

      // ensures that we have a job ID
      if (!response.jobId) {
        throw null
      }
  
      // add the job to the waiting list
      this.jobs.push({
        id: response.jobId,
        resolve: request.resolve,
        started: performance.now(), 
      })
    }
    catch(err) {
      console.log(err)
      request.resolve({
        type: "failure",
        error: ExtractError.JOB_QUEUE_FAILED
      })
    }
  }

  removeJobFromQueue(job: JobWaiting) {
    const index = this.jobs.indexOf(job)
    this.jobs.splice(index, 1)
  }

  async jobSuccess(job: JobWaiting) {
    // remove hte job from the queue
    this.removeJobFromQueue(job)
    // leave a track of the failure
    console.log(`✔️  job ${job.id} succeeded (${(performance.now()-job.started)/1000|0}s)`)
    // fetch the result of the JOB on S3
    try {
      // get the preview stored in preview.png
      const getCommand = new GetObjectCommand({
        Bucket: process.env.AWS_BUCKET_ID,
        Key: `${job.id}/preview.png`
      })
      const response = await this.s3client.send(getCommand)
      
      // get the features stored in the features.json file
      const getFeaturesCommand = new GetObjectCommand({
        Bucket: process.env.AWS_BUCKET_ID,
        Key: `${job.id}/features.json`
      })
      const responseFeatures = await this.s3client.send(getFeaturesCommand)

      // turn the streams into Buffers
      if (responseFeatures.Body && response.Body) {
        const previewBuffer = await streamToBuffer(response.Body)
        const featuresBuffer = await streamToBuffer(responseFeatures.Body)
        job.resolve({
          type: "success",
          data: {
            captureBase64: await bufferToBase64(previewBuffer),
            features: JSON.parse(featuresBuffer.toString()),
          }
        })
      }
      else {
        throw null
      }
    }
    catch {
      // error when fetching the results on S3
      job.resolve({
        type: "failure",
        error: ExtractError.JOB_EXECUTION_FAILED,
      })
    }
  }

  async jobFailed(job: JobWaiting) {
    // remove hte job from the queue
    this.removeJobFromQueue(job)
    // leave a track of the failure
    console.log(`❌  job ${job.id} failed (${(performance.now()-job.started)/1000|0}s)`)
    // resolve with a failure
    job.resolve({
      type: "failure",
      error: ExtractError.JOB_EXECUTION_FAILED,
    })
  }

  loop = async () => {
    console.log("---------------------")
    console.log(`Jobs currently in the queue: ${this.jobs.length}`)

    // count the jobs by status
    const countByStatus: Record<TGpuQueueStatus, number> = Object.fromEntries(
      queueStatus.map(status => [status, 0])
    ) as Record<TGpuQueueStatus, number>

    // we clear jobs who took more than 1 hours
    const now = performance.now()
    for (const job of this.jobs) {
      const duration = now - job.started
      if (duration >= 60 * 60 * 1000) {
        // we also send a request to cancel the job on AWS
        const cmd = new CancelJobCommand({
          jobId: job.id,
          reason: "extract balancer auto timeout",
        })
        await this.client.send(cmd)
        await this.jobFailed(job)
      }
    }

    if (this.jobs.length > 0) {
      // we get the jobs in the last 60 minutes
      const after = "" + (Date.now() - 60 * 60 * 10000)

      let command = new ListJobsCommand({
        filters: [
          {
            name: "AFTER_CREATED_AT",
            values: [ after ],
          },
        ],
        jobQueue: process.env.AWS_BATCH_GPU_JOB_QUEUE_ARN,
      })

      let response = await this.client.send(command)   
      
      console.log("---------------------")

      // find in the list of jobs the jobs currently awaiting for response
      let jobList = response.jobSummaryList

      // add to counter for gauge metrics
      if (jobList) {
        for (const job of jobList) {
          if (queueStatus.includes(job.status as TGpuQueueStatus)) {
            countByStatus[job.status as TGpuQueueStatus] += 1
          }
        }
      }

      for (let i = this.jobs.length-1; i >= 0; i--) {
        const job = this.jobs[i]
        const jobResult = jobList?.find(j => j.jobId === job.id)
        if (jobResult) {
          const status = jobResult.status
          console.log(`${job.id}: ${status}`)

          // if the job succeeded, resolve with success
          if (status === "SUCCEEDED") {
            this.jobSuccess(job)
          }
          // if the job failed, resolve with failure
          else if (status === "FAILED") {
            this.jobFailed(job)
          }
        }
      }

      //
      // SAME FOR PRIORITY QUEUE
      //
      command = new ListJobsCommand({
        filters: [
          {
            name: "AFTER_CREATED_AT",
            values: [ after ],
          },
        ],
        jobQueue: process.env.AWS_BATCH_GPU_JOB_QUEUE_PRIORITY_ARN,
      })

      response = await this.client.send(command)   
      
      console.log("---------------------")

      // find in the list of jobs the jobs currently awaiting for response
      jobList = response.jobSummaryList

      // add to counter for gauge metrics
      if (jobList) {
        for (const job of jobList) {
          if (queueStatus.includes(job.status as TGpuQueueStatus)) {
            countByStatus[job.status as TGpuQueueStatus] += 1
          }
        }
      }

      for (let i = this.jobs.length-1; i >= 0; i--) {
        const job = this.jobs[i]
        const jobResult = jobList?.find(j => j.jobId === job.id)
        if (jobResult) {
          const status = jobResult.status
          console.log(`${job.id}: ${status}`)

          // if the job succeeded, resolve with success
          if (status === "SUCCEEDED") {
            this.jobSuccess(job)
          }
          // if the job failed, resolve with failure
          else if (status === "FAILED") {
            this.jobFailed(job)
          }
        }
      }
    }

    // recall the loop
    setTimeout(this.loop, FETCH_JOB_STATUS_INTERVAL_MS)
  }
}