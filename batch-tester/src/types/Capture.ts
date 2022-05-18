import { Vec2 } from "./math"

export enum CaptureTriggerMode {
  DELAY             = "DELAY",
  FN_TRIGGER        = "FN_TRIGGER",
}
export const CaptureTriggerModeList = Object.values(CaptureTriggerMode)

export enum CaptureMode {
  CANVAS          = "CANVAS",
  CUSTOM          = "CUSTOM",
  VIEWPORT        = "VIEWPORT",
}
export const CaptureModeList = Object.values(CaptureMode)

export interface CaptureSettings {
  url: string
  mode: CaptureMode
  triggerMode?: CaptureTriggerMode
  resolution?: Vec2
  delay?: number
  canvasSelector?: string
  gpu?: boolean
}