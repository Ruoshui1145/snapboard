import { useEffect, useState } from 'react'
import { ASSEMBLY_HOST_PRESETS, type HostCatalogEntry } from '../assembly/hostCatalog'

export interface AssemblyHostPackageSummary {
  schemaVersion: number
  kind: 'assembly-host-pack'
  id: string
  name: string
  version: string
  author: string
  license: string
  description?: string
  hostIds: string[]
}

export interface AssemblyLibraryIndex {
  schemaVersion: 1
  generatedAt?: string
  packages: AssemblyHostPackageSummary[]
  hosts: Array<HostCatalogEntry & { packageId?: string; packageVersion?: string }>
  warnings: string[]
}

const fallback: AssemblyLibraryIndex = {
  schemaVersion: 1,
  packages: [],
  hosts: [...ASSEMBLY_HOST_PRESETS],
  warnings: [],
}

let cached = fallback
let loading: Promise<AssemblyLibraryIndex> | null = null

const mergeWithBuiltins = (remote: Partial<AssemblyLibraryIndex>): AssemblyLibraryIndex => {
  const hosts = new Map<string, AssemblyLibraryIndex['hosts'][number]>()
  ASSEMBLY_HOST_PRESETS.forEach(host => hosts.set(host.id, host))
  if (Array.isArray(remote.hosts)) remote.hosts.forEach(host => {
    if (host && typeof host.id === 'string') hosts.set(host.id, host)
  })
  return {
    schemaVersion: 1,
    generatedAt: typeof remote.generatedAt === 'string' ? remote.generatedAt : undefined,
    packages: Array.isArray(remote.packages) ? remote.packages : [],
    hosts: [...hosts.values()],
    warnings: Array.isArray(remote.warnings) ? remote.warnings.filter(item => typeof item === 'string') : [],
  }
}

const loadAssemblyLibrary = (force = false) => {
  if (!force && loading) return loading
  loading = fetch('/assemblyLibrary/index.json', { cache: 'no-store' })
    .then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      cached = mergeWithBuiltins(await response.json() as Partial<AssemblyLibraryIndex>)
      return cached
    })
    .catch(() => cached)
    .finally(() => { loading = null })
  return loading
}

export function useAssemblyLibrary() {
  const [index, setIndex] = useState(cached)
  useEffect(() => {
    let cancelled = false
    const refresh = (force = false) => {
      void loadAssemblyLibrary(force).then(next => { if (!cancelled) setIndex(next) })
    }
    const onUpdated = () => refresh(true)
    refresh()
    window.addEventListener('snapboard:assembly-library-updated', onUpdated)
    return () => {
      cancelled = true
      window.removeEventListener('snapboard:assembly-library-updated', onUpdated)
    }
  }, [])
  return index
}
