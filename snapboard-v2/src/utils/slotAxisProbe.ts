// 长圆孔锚点长轴探测: 从模型几何采样端面边界, 找边界半径最大的方向 = 长轴。
// 等价于"槽孔两个半圆弧圆心连线的方向"。圆孔(近似各向同性)返回 undefined。
import * as THREE from 'three'
import type { PartMountAnchor } from '../partLibrary/types'
import { stabilizeSlotAxis } from './mountAxis.js'

const round3 = (value: number) => Math.round(value * 1000) / 1000

/**
 * 沿锚点端面法向, 在端面平面内环形采样射线:
 *  - 自带安装柱模型: 柱心命中端面 (柱端面内 = 端面深度), 端面外为更深/无命中
 *  - 板面开孔模型: 孔心无命中/深层, 孔外命中端面深度
 * 通过中心探针判定极性, 再对每个方向找边界半径, 最大的方向即长轴。
 * 返回零件局部安装面内单位向量 [x, y]; 长宽比不足(≈圆)时返回 undefined。
 */
export function deriveSlotAxis(model: THREE.Object3D, anchor: PartMountAnchor): [number, number] | undefined {
  const ROOM = 20
  const FACE_EPS = 1.4
  model.updateMatrixWorld(true)
  const center = new THREE.Vector3(...anchor.position).applyMatrix4(model.matrixWorld)
  const n = new THREE.Vector3(...(anchor.normal ?? [0, 0, 1]))
    .transformDirection(model.matrixWorld)
    .normalize()
  const u = Math.abs(n.z) < 0.9
    ? new THREE.Vector3(0, 0, 1).cross(n).normalize()
    : new THREE.Vector3(0, 1, 0).cross(n).normalize()
  const v = n.clone().cross(u).normalize()
  const raycaster = new THREE.Raycaster()
  const depth = (dir: THREE.Vector3, radius: number): number | null => {
    const origin = center.clone().addScaledVector(dir, radius).addScaledVector(n, ROOM)
    raycaster.set(origin, n.clone().negate())
    const hit = raycaster.intersectObject(model, true).find(item => (item.object as THREE.Mesh).isMesh)
    return hit ? hit.distance : null
  }
  const centerDistance = depth(u, 0.3)
  const isPost = centerDistance !== null && centerDistance <= ROOM + FACE_EPS
  const isInside = (distance: number | null) => isPost
    ? distance !== null && distance <= ROOM + FACE_EPS
    : distance === null || distance > ROOM + FACE_EPS
  const steps = 24
  const runs: number[] = []
  for (let s = 0; s < steps; s++) {
    const theta = (s / steps) * Math.PI
    const dir = u.clone().multiplyScalar(Math.cos(theta)).addScaledVector(v, Math.sin(theta))
    let run = 0
    for (let r = 0.75; r <= 14; r += 0.5) {
      if (isInside(depth(dir, r))) run = r
      else break
    }
    runs.push(run)
  }
  let best = 0
  for (let s = 1; s < steps; s++) if (runs[s] > runs[best]) best = s
  const perpendicular = runs[(best + steps / 2) % steps]
  const ratio = runs[best] / Math.max(perpendicular, 1e-3)
  // 长宽比不足 ≈ 圆孔/圆形柱; 半径过小视为无效
  if (!(ratio >= 1.35) || runs[best] <= 1.2) return undefined
  const theta = (best / steps) * Math.PI
  const worldAxis = u.clone().multiplyScalar(Math.cos(theta)).addScaledVector(v, Math.sin(theta)).normalize()
  const localAxis = worldAxis.transformDirection(model.matrixWorld.clone().invert()).normalize()
  const planarLength = Math.hypot(localAxis.x, localAxis.y)
  if (planarLength < 0.35 || !Number.isFinite(planarLength)) return undefined
  const stable = stabilizeSlotAxis([localAxis.x / planarLength, localAxis.y / planarLength])
  return [round3(stable[0]), round3(stable[1])]
}
