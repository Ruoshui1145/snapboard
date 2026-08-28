export interface ProjectStorageStatus {
  mode: 'project-library' | 'local-folder' | 'browser-download' | 'cloud'
  label: string
  projectCount: number
  recentProjects: string[]
  needsPermission?: boolean
}

let snapshot: ProjectStorageStatus = {
  mode: 'project-library',
  label: '项目内“已保存项目”',
  projectCount: 0,
  recentProjects: [],
}

const listeners = new Set<() => void>()

export function getProjectStorageStatus(): ProjectStorageStatus {
  return snapshot
}

export function publishProjectStorageStatus(next: ProjectStorageStatus): void {
  snapshot = {
    ...next,
    recentProjects: [...next.recentProjects],
  }
  listeners.forEach(listener => listener())
}

export function subscribeProjectStorageStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
