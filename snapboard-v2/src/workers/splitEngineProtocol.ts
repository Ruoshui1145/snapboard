import type { Point2D, SplitConfig, SplitSourceResult } from '../types/geometry'

export interface SplitWorkerTarget {
  contourId: string
  name: string
  sourceIds: string[]
  points: Point2D[]
  cornerPolicy: 'auto' | 'preserve-source'
  /** Face-local lattice phase for multi-plane boards; absent for ordinary sketches. */
  config?: SplitConfig
  holes?: Point2D[][]
}

export interface SplitWorkerRequest {
  jobId: number
  targets: SplitWorkerTarget[]
  holes: Point2D[][]
  passiveHoles?: Point2D[][]
  config: SplitConfig
}

export type SplitWorkerResponse =
  | { type: 'progress'; jobId: number; completed: number; total: number }
  | { type: 'result'; jobId: number; sources: SplitSourceResult[] }
  | { type: 'error'; jobId: number; message: string }
