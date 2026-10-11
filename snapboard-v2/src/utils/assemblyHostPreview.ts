import * as THREE from 'three'
import type { HostCatalogEntry } from '../assembly/hostCatalog'

export interface AssemblyHostPreview {
  object: THREE.Group
  centerY: number
  size: number
}

const metal = (color: number, roughness = 0.34) => new THREE.MeshStandardMaterial({
  color,
  metalness: 0.76,
  roughness,
})

const matte = (color: number) => new THREE.MeshStandardMaterial({
  color,
  metalness: 0.04,
  roughness: 0.82,
})

const addBox = (
  group: THREE.Group,
  name: string,
  size: [number, number, number],
  position: [number, number, number],
  material: THREE.Material,
) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material)
  mesh.name = name
  mesh.position.set(...position)
  group.add(mesh)
  return mesh
}

const addWall = (group: THREE.Group) => {
  addBox(group, 'mount-host-wall', [620, 420, 6], [0, 210, -6], matte(0x263449))
  const gridMaterial = new THREE.LineBasicMaterial({ color: 0x5f7696, transparent: true, opacity: 0.15 })
  const points: THREE.Vector3[] = []
  for (let x = -280; x <= 280; x += 40) points.push(new THREE.Vector3(x, 20, -2.8), new THREE.Vector3(x, 400, -2.8))
  for (let y = 20; y <= 400; y += 40) points.push(new THREE.Vector3(-280, y, -2.8), new THREE.Vector3(280, y, -2.8))
  const grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), gridMaterial)
  grid.name = 'mount-host-wall-grid'
  group.add(grid)
}

const addDinRail = (group: THREE.Group, depth: number) => {
  const rail = new THREE.Group()
  rail.name = 'mount-host-din-rail'
  rail.position.set(0, 210, 0)
  const steel = metal(0xb7c1cd, 0.28)
  addBox(rail, 'din-web', [500, 24, 1.8], [0, 0, depth * 0.2], steel)
  addBox(rail, 'din-upper-bridge', [500, 5, depth], [0, 14, depth / 2], steel)
  addBox(rail, 'din-lower-bridge', [500, 5, depth], [0, -14, depth / 2], steel)
  addBox(rail, 'din-upper-lip', [500, 5, 1.8], [0, 17.5, depth], steel)
  addBox(rail, 'din-lower-lip', [500, 5, 1.8], [0, -17.5, depth], steel)
  group.add(rail)
}

const addTSlotProfile = (group: THREE.Group, system: 'item' | 'bosch') => {
  const body = metal(system === 'item' ? 0xaeb9c5 : 0x9eaab7, 0.3)
  const dark = matte(0x1b2533)
  addBox(group, 'mount-host-profile-body', [500, 40, 40], [0, 210, 18], body)
  // 正面和上下表面的槽口只做参考显示；精确兼容由 grooveSignature 校验。
  addBox(group, 'mount-host-profile-front-slot', [500, 8, 1.8], [0, 210, 38.9], dark)
  addBox(group, 'mount-host-profile-top-slot', [500, 1.8, 8], [0, 230.9, 18], dark)
  addBox(group, 'mount-host-profile-bottom-slot', [500, 1.8, 8], [0, 189.1, 18], dark)
  const cap = matte(system === 'item' ? 0x6ca49b : 0x6b89a7)
  addBox(group, 'mount-host-profile-system-mark', [12, 26, 2], [-235, 210, 40.5], cap)
}

/** 创建非洞洞板场景的轻量参考宿主；制造导出不会包含这些上下文网格。 */
export function createAssemblyHostPreview(preset: Pick<HostCatalogEntry, 'id' | 'family' | 'systemKey' | 'nominalGeometryMm'>): AssemblyHostPreview {
  const object = new THREE.Group()
  object.name = 'mount-host-preview'
  addWall(object)

  if (preset.family === 'din-rail') addDinRail(object, Number(preset.nominalGeometryMm.railDepth ?? preset.nominalGeometryMm.depth ?? 7.5))
  else if (preset.family === 'aluminium-profile') addTSlotProfile(object, preset.systemKey.includes('item') ? 'item' : 'bosch')
  else if (preset.family === 'wall') {
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 84),
      new THREE.MeshBasicMaterial({ color: 0x62d9c5, transparent: true, opacity: 0.16, side: THREE.DoubleSide }),
    )
    pad.name = 'mount-host-surface-target'
    pad.position.set(0, 210, -2.7)
    object.add(pad)
  }

  return { object, centerY: 210, size: 620 }
}
