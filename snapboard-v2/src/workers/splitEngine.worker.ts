/// <reference lib="webworker" />

import { splitOrthogonalPolygon } from '../utils/pegboardSplit'
import type { SplitSourceResult } from '../types/geometry'
import type { SplitWorkerRequest, SplitWorkerResponse } from './splitEngineProtocol'

const send = (message: SplitWorkerResponse) => self.postMessage(message)

self.addEventListener('message', (event: MessageEvent<SplitWorkerRequest>) => {
  const request = event.data
  try {
    const sources: SplitSourceResult[] = []
    for (let index = 0; index < request.targets.length; index++) {
      const target = request.targets[index]
      const result = splitOrthogonalPolygon({
        points: target.points,
        holes: request.holes.length ? request.holes : undefined,
      }, request.config)
      sources.push({
        contourId: target.contourId,
        name: target.name || '未命名轮廓',
        sourceIds: target.sourceIds,
        panels: result.panels,
        warnings: result.warnings,
        coverageRatio: result.coverageRatio,
      })
      send({
        type: 'progress',
        jobId: request.jobId,
        completed: index + 1,
        total: request.targets.length,
      })
    }
    send({ type: 'result', jobId: request.jobId, sources })
  } catch (cause) {
    send({
      type: 'error',
      jobId: request.jobId,
      message: cause instanceof Error ? cause.message : String(cause),
    })
  }
})
