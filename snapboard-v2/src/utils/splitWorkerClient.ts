import { splitOrthogonalPolygon } from './pegboardSplit'
import type { SplitSourceResult } from '../types/geometry'
import type { SplitWorkerRequest, SplitWorkerResponse } from '../workers/splitEngineProtocol'

/** Both planar and spatial splits keep cancellation and one startup retry in the same place. */
export function startSplitWorker(request: SplitWorkerRequest,
  onProgress?: (completed: number, total: number) => void, signal?: AbortSignal) {
  let worker: Worker | undefined, settled = false, started = false, retried = false
  let fail!: (error: Error) => void
  const stop = () => { worker?.terminate(); signal?.removeEventListener('abort', cancel) }
  const cancel = () => { fail(new DOMException('已取消自动分割', 'AbortError')) }
  const promise = new Promise<SplitSourceResult[]>((resolve, reject) => {
    fail = error => { if (settled) return; settled = true; stop(); reject(error) }
    const finish = (sources: SplitSourceResult[]) => { if (settled) return; settled = true; stop(); resolve(sources) }
    if (signal?.aborted) { cancel(); return }
    if (typeof Worker === 'undefined') {
      try {
        finish(request.targets.map((target, index) => {
          const result = splitOrthogonalPolygon({ points: target.points,
            holes: (target.holes ?? request.holes).length ? target.holes ?? request.holes : undefined,
            passiveHoles: request.passiveHoles, cornerPolicy: target.cornerPolicy }, target.config ?? request.config)
          onProgress?.(index + 1, request.targets.length)
          return { contourId: target.contourId, name: target.name || '未命名轮廓', sourceIds: target.sourceIds, ...result }
        }))
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
      return
    }
    signal?.addEventListener('abort', cancel, { once: true })
    const launch = () => {
      if (settled) return
      try {
        const current = new Worker(new URL('../workers/splitEngine.worker.ts', import.meta.url), { type: 'module' })
        worker = current
        current.onmessage = (event: MessageEvent<SplitWorkerResponse>) => {
          if (settled || worker !== current || event.data.jobId !== request.jobId) return
          started = true
          const response = event.data
          if (response.type === 'progress') onProgress?.(response.completed, response.total)
          else if (response.type === 'result') finish(response.sources)
          else fail(new Error(response.message))
        }
        current.onerror = event => {
          if (settled || worker !== current) return
          current.terminate()
          // A new worker has a fresh module graph after a transient dev-server reload.
          if (!started && !retried) { retried = true; launch(); return }
          const location = event.filename ? `（${event.filename}${event.lineno ? ':' + event.lineno : ''}）` : ''
          fail(new Error(event.message ? event.message + location : started
            ? '分割计算线程意外中断，请减少轮廓规模后重试'
            : '分割线程未能加载，自动重试仍失败；请保存当前工程并刷新页面后重试' + location))
        }
        current.onmessageerror = () => { if(worker === current)fail(new Error('分割线程返回的数据无法读取，请重新生成')) }
        current.postMessage(request)
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
    }
    launch()
  })
  return { promise, cancel }
}
