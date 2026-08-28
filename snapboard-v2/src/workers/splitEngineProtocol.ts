import type { Point2D, SplitConfig, SplitSourceResult } from '../types/geometry'

export interface SplitWorkerTarget {
  contourId: string
  name: string
  sourceIds: string[]
  points: Point2D[]
}

export interface SplitWorkerRequest {
  jobId: number
  targets: SplitWorkerTarget[]
  holes: Point2D[][]
  config: SplitConfig
}

export type SplitWorkerResponse =
  | { type: 'progress'; jobId: number; completed: number; total: number }
  | { type: 'result'; jobId: number; sources: SplitSourceResult[] }
  | { type: 'error'; jobId: number; message: string }
