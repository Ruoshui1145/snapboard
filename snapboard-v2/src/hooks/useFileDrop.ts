import { useEffect, useRef, useState, type DragEvent } from 'react'
import { captureFileDrop, isImportDrag, resolveFileDrop, type FileDropOptions } from '../utils/fileDrop'
import './useFileDrop.css'

/** File drops reuse the picker importer; internal part drags keep bubbling. */
export function useFileDrop(onFiles: (files: File[]) => void | Promise<void>, disabled = false, options: FileDropOptions = {}) {
  const [active, setActive] = useState(false)
  const [loading, setLoading] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const unavailable = disabled || loading
  const dragOver = (event: DragEvent<HTMLElement>) => {
    if (!isImportDrag(event.dataTransfer)) return
    event.preventDefault(); event.stopPropagation()
    event.dataTransfer.dropEffect = unavailable ? 'none' : 'copy'
    setActive(!unavailable)
  }
  return {
    dragging: active && !unavailable,
    loading,
    dropProps: {
      'data-file-drop': unavailable ? 'disabled' : active ? 'active' : 'ready',
      'aria-busy': loading || undefined,
      onDragEnter: dragOver,
      onDragOver: dragOver,
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(false)
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!isImportDrag(event.dataTransfer)) return
        event.preventDefault(); event.stopPropagation(); setActive(false)
        if (disabled || pending.current) return
        const drop = captureFileDrop(event.dataTransfer)
        if (drop.files.length) { void onFiles(drop.files); return }
        if (!drop.url) return
        pending.current = true; setLoading(true)
        void resolveFileDrop(drop, options).then(files => { if (mounted.current && files.length) return onFiles(files) })
          .catch(error => { if (mounted.current) options.onError?.(error instanceof Error ? error.message : String(error)) })
          .finally(() => { pending.current = false; if (mounted.current) setLoading(false) })
      },
    },
  }
}
