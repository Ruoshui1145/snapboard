import type { PartDefinition, PartMountAnchor } from '../partLibrary/types'

export interface RecoveredMountState {
  anchors: PartMountAnchor[]
  contactZ: number | null
  recoveredLegacyContact: boolean
}

const round3 = (value: number) => Math.round(value * 1000) / 1000

/**
 * 2026-08 旧版标定器曾把“接触面”误追加为最后一个圆孔锚点。只在最后一项为
 * 圆孔、前序锚点共面且最后一项 Z 明显离面时恢复，避免误改真正的非共面装配。
 */
export function recoverLegacyContactSelection(
  mount: PartDefinition['mount'],
): RecoveredMountState {
  if (typeof mount !== 'object') return { anchors: [], contactZ: null, recoveredLegacyContact: false }
  const anchors = mount.anchors ?? []
  const savedContact = Number.isFinite(mount.contactZ) ? (mount.contactZ ?? null) : null
  if (savedContact !== null || anchors.length < 3) {
    return { anchors, contactZ: savedContact, recoveredLegacyContact: false }
  }
  const last = anchors[anchors.length - 1]
  const earlier = anchors.slice(0, -1)
  if (!last.accepts.includes('round') || earlier.length < 2) {
    return { anchors, contactZ: null, recoveredLegacyContact: false }
  }
  const earlierZ = earlier.map(anchor => anchor.position[2]).sort((a, b) => a - b)
  const medianZ = earlierZ[Math.floor(earlierZ.length / 2)]
  const coplanar = earlierZ.every(value => Math.abs(value - medianZ) <= 0.35)
  if (!coplanar || Math.abs(last.position[2] - medianZ) < 1) {
    return { anchors, contactZ: null, recoveredLegacyContact: false }
  }
  return {
    anchors: earlier,
    contactZ: round3(last.position[2]),
    recoveredLegacyContact: true,
  }
}
