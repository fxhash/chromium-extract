export enum ExtractError {
  UNKNOWN                       = "UNKNOWN",
  TIMEOUT                       = "TIMEOUT",
  EXTRACT_SERVICE_UNREACHABLE   = "EXTRACT_SERVICE_UNREACHABLE",
  INVALID_INPUT_PARAMETERS      = "INVALID_INPUT_PARAMETERS",
  JOB_QUEUE_FAILED              = "JOB_QUEUE_FAILED",
  JOB_EXECUTION_FAILED          = "JOB_EXECUTION_FAILED",
}

export const ExtractErrors = Object.keys(ExtractError)