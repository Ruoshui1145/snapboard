import { parseProjectFile, serializeProjectFile, type ProjectWorkspaceData, type FarmOrderLink } from './projectFile'

export const ORDER_API = '/api/farm-orders'
export interface OrderFile {
  id: string; orderId: string; orderNumber: string; revision: number; kind: 'project' | 'manufacturing'
  filename: string; size: number; sha256: string; createdAt: string
  status: 'available' | 'missing' | 'changed'; downloadPath: string
  downloadUrl: string
  sourceMetadata?: {source:'local-file';originalOrderNumber:string|null;warnings:string[]}
}
export async function orderRequest(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal) {
  const response = await fetch(ORDER_API + route, { method, signal,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '订单服务暂不可用')
  return result
}

export async function uploadOrderFile(link: FarmOrderLink, revision: number, kind: OrderFile['kind'],
  filename: string, data: Blob | Uint8Array, signal?: AbortSignal): Promise<OrderFile> {
  const query = new URLSearchParams({ kind, revision: String(revision), filename })
  const response = await fetch(`${ORDER_API}/orders/${encodeURIComponent(link.id)}/artifacts?${query}`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': crypto.randomUUID() },
    body: data instanceof Blob ? data : new Blob([data as BlobPart]),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '订单文件保存失败')
  return result.artifact as OrderFile
}

export async function deliverOrderProject(workspace: ProjectWorkspaceData, revision: number, signal?: AbortSignal): Promise<OrderFile> {
  if (!workspace.orderLink) throw new Error('工程尚未取得订单号')
  const filename = `${workspace.orderLink.number}-R${String(revision).padStart(2, '0')}-工程.snapboard`
  return uploadOrderFile(workspace.orderLink, revision, 'project', filename,
    new Blob([serializeProjectFile(workspace)], { type: 'application/octet-stream' }), signal)
}

/** Only indexed project files are opened; no filename guesses or filesystem paths from a URL. */
export async function orderProjectFromLocation(search: string, signal?: AbortSignal) {
  const params = new URLSearchParams(search), orderId = params.get('order'), artifactId = params.get('artifact')
  if (!orderId && !artifactId) return null
  if (!orderId || !artifactId || !/^[a-f0-9-]{36}$/.test(orderId) || !/^[a-f0-9-]{36}$/.test(artifactId)) throw new Error('订单图纸打开链接不完整，请从订单控制台重新打开')
  const manifest = await orderRequest(`/orders/${encodeURIComponent(orderId)}/artifacts`, undefined, 'GET', signal)
  const artifact = (manifest.files as OrderFile[]).find(file => file.id === artifactId && file.kind === 'project')
  if (!artifact || artifact.status !== 'available') throw new Error('订单工程文件不存在或已改变，请在控制台查看交付文件状态')
  const response = await fetch(`${ORDER_API}/artifacts/${encodeURIComponent(artifactId)}/file`, { signal })
  if (!response.ok) throw new Error('订单工程文件无法读取，请检查订单控制台中的文件状态')
  const project = parseProjectFile(await response.text())
  if(artifact.sourceMetadata?.source==='local-file') project.workspace.orderLink={id:orderId,number:manifest.orderNumber}
  else if (project.workspace.orderLink?.id !== orderId || project.workspace.orderLink.number !== manifest.orderNumber) throw new Error('工程包与订单号不一致，已停止打开')
  return { project, artifact, currentRevision: manifest.currentRevision as number }
}
