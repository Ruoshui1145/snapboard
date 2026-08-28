export interface PartDragPayload {
  defId: string
  params: Record<string, number | string>
}

type Listener = (payload: PartDragPayload | null) => void

let active: PartDragPayload | null = null
const listeners = new Set<Listener>()

export function beginPartDrag(payload: PartDragPayload): void {
  active = payload
  listeners.forEach(listener => listener(active))
}

export function endPartDrag(): void {
  active = null
  listeners.forEach(listener => listener(null))
}

export function subscribePartDrag(listener: Listener): () => void {
  listeners.add(listener)
  listener(active)
  return () => listeners.delete(listener)
}

