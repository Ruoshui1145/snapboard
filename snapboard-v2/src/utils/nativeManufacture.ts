import type { createManufacturing3MF } from './export3mf'

type Manufacturing3MFInput = Parameters<typeof createManufacturing3MF>[0]

/** 本地制造进程的产物；字段与浏览器内导出结果对齐，便于两条路径互换。 */
export interface NativeManufactureResult {
  data: Uint8Array
  streamedFile: undefined
  cleanup: () => Promise<void>
  plateCount: number
  panelCount: number
  uniqueObjectCount: number
  markingRequestedCount: number
  markingAppliedCount: number
  numbering?: { requested:number; applied:number; back:number; side:number; pocket:number; missing:string[] }
  sampleCount: number
  samplePlateCount: number
  warnings: string[]
  /** 逐板导出时由制造进程给定的压缩包文件名。 */
  fileName?: string
}

interface NativeManufactureSummary {
  plateCount: number
  panelCount: number
  uniqueObjectCount: number
  markingRequestedCount: number
  markingAppliedCount: number
  numbering?: NativeManufactureResult['numbering']
  sampleCount: number
  samplePlateCount: number
}

const ENDPOINT = '/api/native-manufacture'

/** 只有本地 dev server 提供制造进程；打包后的页面里没有这个接口，调用方据此回退。 */
export async function nativeManufactureAvailable(): Promise<boolean> {
  try {
    const response = await fetch(ENDPOINT, { method: 'GET' })
    if (!response.ok) return false
    return Boolean((await response.json() as { available?: boolean })?.available)
  } catch {
    return false
  }
}

/**
 * 方案 §4：把不可变工程快照交给本地制造进程，浏览器只显示阶段、进度与取消。
 * signal 与 onProgress 不能进 JSON，所以它们走轮询与独立的取消接口。
 */
export async function createManufacturing3MFNative(
  input: Manufacturing3MFInput,
  onProgress?: (message: string, progress?: number) => void,
): Promise<NativeManufactureResult> {
  const { signal, onProgress: _ignored, exportQuotaTicket, ...snapshot } = input
  const started = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(exportQuotaTicket ? { 'X-SnapBoard-Export-Ticket': exportQuotaTicket } : {}) },
    body: JSON.stringify(snapshot),
  })
  if (!started.ok) {
    const detail = await started.json().catch(() => null) as { error?: string } | null
    throw new Error(detail?.error ?? `本地制造进程拒绝了这次导出（HTTP ${started.status}）`)
  }
  const { jobId } = await started.json() as { jobId: string }

  const cancel = () => { void fetch(`${ENDPOINT}?job=${jobId}&cancel=1`, { method: 'POST' }) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError')
      const response = await fetch(`${ENDPOINT}?job=${jobId}`)
      if (!response.ok) throw new Error(`本地制造进程状态读取失败（HTTP ${response.status}）`)
      const status = await response.json() as {
        running: boolean; progress: number; stage: string; error: string | null
        warnings: string[]; summary: NativeManufactureSummary | null; fileName: string | null
      }
      if (status.error) throw new Error(status.error)
      onProgress?.(status.stage, status.progress)
      if (!status.running) {
        const file = await fetch(`${ENDPOINT}?job=${jobId}&result=1`)
        if (!file.ok) {
          const detail = await file.json().catch(() => null) as { error?: string } | null
          throw new Error(detail?.error ?? `本地制造进程没有产出文件（HTTP ${file.status}）`)
        }
        if (!status.summary) throw new Error('本地制造进程没有返回热床信息')
        return {
          data: new Uint8Array(await file.arrayBuffer()),
          streamedFile: undefined,
          cleanup: async () => {},
          plateCount: status.summary.plateCount,
          panelCount: status.summary.panelCount,
          uniqueObjectCount: status.summary.uniqueObjectCount,
          markingRequestedCount: status.summary.markingRequestedCount,
          markingAppliedCount: status.summary.markingAppliedCount,
          numbering: status.summary.numbering,
          sampleCount: status.summary.sampleCount,
          samplePlateCount: status.summary.samplePlateCount,
          warnings: status.warnings ?? [],
          ...(status.fileName ? { fileName: status.fileName } : {}),
        }
      }
      await new Promise(resolve => setTimeout(resolve, 400))
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
