// ============ 零件库 Hook — 加载索引 + 分类浏览 ============
import { useEffect, useState, useCallback } from 'react'
import type { PartDefinition, PartLibraryIndex } from '../partLibrary/types'

const INDEX_URL = '/partLibrary/index.json'

export function usePartLibrary() {
  const [index, setIndex] = useState<PartLibraryIndex | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<string>('hook')

  useEffect(() => {
    const load = () => {
      setError(null)
      fetch(`${INDEX_URL}?t=${Date.now()}`, { cache: 'no-store' })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
        .then((data: PartLibraryIndex) => setIndex(data))
        .catch(e => setError(e.message))
        .finally(() => setLoading(false))
    }
    load()
    window.addEventListener('snapboard:part-library-updated', load)
    return () => window.removeEventListener('snapboard:part-library-updated', load)
  }, [])

  const parts = useCallback(
    (category?: string): PartDefinition[] => {
      if (!index) return []
      return index.parts.filter(p => p.category === (category ?? activeCategory))
    },
    [index, activeCategory],
  )

  return { index, loading, error, activeCategory, setActiveCategory, parts }
}
