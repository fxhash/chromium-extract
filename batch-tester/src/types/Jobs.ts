import { CaptureSettings } from "./Capture";

export interface JobResponse {
  captureBase64: string
  features?: Record<string, any>
}

export interface JobResolution {
  type: "success"|"failure"
  error?: string
  data?: JobResponse
}

export type ResolveFnSignature = (resolutionState: JobResolution) => void

export interface JobWaiting {
  id: string
  resolve: ResolveFnSignature
  started: number
}

export interface JobRequestParams {
  captureSettings: CaptureSettings
  withFeatures: boolean
  priority?: boolean
}

export interface JobRequest {
  resolve: ResolveFnSignature
  params: JobRequestParams
}