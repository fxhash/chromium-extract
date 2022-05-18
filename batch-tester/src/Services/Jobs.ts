import { JobRequest, JobWaiting } from "../types/Jobs";

/**
 * The abstract JobsClass describes how should Jobs dedicated to extract informations
 * from a project instance be implemented 
 */
export abstract class JobsClass {
  jobs: JobWaiting[] = []

  /**
   * Add a Job to the queue with a JobRequest signature.
   * The JobRequest contains a method which can be called when the job resolves, and
   * callers are agnostic of the internal resolution of such jobs.
   */
  abstract addJob(request: JobRequest): Promise<void>

  /**
   * start the service, optional implementation
   */
  start(): void {}
}