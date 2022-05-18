declare global {
  namespace NodeJS {
    interface ProcessEnv {
			NODE_ENV: string
			PORT: string
			FETCH_JOB_STATUS_INTERVAL_MS: string
      API_CAPTURE_NO_GPU: string
      API_FEATURES_NO_GPU: string
      AWS_BATCH_GPU_JOB_DEF_ARN: string
      AWS_BATCH_GPU_JOB_QUEUE_ARN: string
      AWS_BATCH_GPU_JOB_QUEUE_PRIORITY_ARN: string
      AWS_BATCH_JOB_NAME: string
      AWS_REGION: string
      AWS_BUCKET_ID: string
      IPFS_GATEWAY_ROOT: string
      CLEAR_GPU_QUEUE: "0"|"1"

      TRACING_ENABLED: "0"|"1"
      OPEN_TELEMETRY_TARGET: string
    }
  }
}

// If this file has no import/export statements (i.e. is a script)
// convert it into a module by adding an empty export statement.
export {}