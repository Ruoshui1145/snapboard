export const MAX_PACK_BYTES: number
export function importPartResourcePack(root: string, compressed: Uint8Array, sync: () => Promise<void>): Promise<{ id: string; name: string; version: string }>
