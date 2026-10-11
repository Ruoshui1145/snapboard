import { useRef, useState } from 'react'
import './PartResourcePackImport.css'
import { useFileDrop } from '../../hooks/useFileDrop'

/** 安装包与资源内容分离；复用在空库引导和设置面板中。 */
export function PartResourcePackImport({ onImported }: { onImported?: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const [importing, setImporting] = useState(false)
  const [status, setStatus] = useState('')
  const importFiles = async (files: File[]) => {
    if (!files.length || busy.current) return
    busy.current = true
    setImporting(true)
    const results: string[] = []
    try {
      // 逐包处理，限制内存峰值；一个包失败不影响其他包的安装。
      for (const [i, file] of files.entries()) {
        setStatus(`正在导入 ${i + 1}/${files.length}：${file.name}`)
        try {
          if (!file.name.toLowerCase().endsWith('.sbpack')) throw new Error('请选择 .sbpack 资源包，不要选择普通模型或合集 ZIP')
          if (file.size > 100 * 1024 * 1024) throw new Error('单个资源包不能超过 100 MB')
          const response = await fetch('/api/part-library/import-pack', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
          if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('当前服务不支持资源包导入，请升级安装版')
          const result = await response.json() as { name?: string; version?: string; error?: string }
          if (!response.ok) throw new Error(result.error || '导入失败')
          results.push(`已安装 ${result.name} v${result.version}`)
          window.dispatchEvent(new Event('snapboard:part-library-updated'))
          onImported?.()
        } catch (error) {
          results.push(`${file.name}：${error instanceof Error ? error.message : '导入失败'}`)
        }
      }
      setStatus(results.join('\n'))
    } finally {
      busy.current = false
      setImporting(false)
      if (input.current) input.current.value = ''
    }
  }
  const fileDrop = useFileDrop(importFiles, importing, { accept: '.sbpack', maxBytes: 100 * 1024 * 1024, onError: setStatus })
  return <section className="part-pack-import" aria-label="独立配件资源包" {...fileDrop.dropProps}>
    <strong>独立配件资源包</strong>
    <p>选择或拖入 .sbpack 文件，即可导入模型、分类和安装标定；支持多选。</p>
    <input ref={input} hidden type="file" multiple accept=".sbpack" onChange={event => void importFiles(Array.from(event.target.files ?? []))} />
    <button type="button" className="file-drop-prompt" disabled={importing} onClick={() => input.current?.click()}><span className="file-drop-plus" aria-hidden="true">＋</span>{importing ? '正在安装资源包…' : '点击或拖入资源包（.sbpack）'}</button>
    <small>仅导入可信来源的资源包；重复包不会覆盖已有内容。导入后立即生效，重启仍保留。</small>
    <p role="status" aria-live="polite">{status}</p>
  </section>
}
