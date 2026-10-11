import type { BufferGeometry } from 'three'

export interface PreviewMeshTopology { vertices: number[]; triangles: number[] }
const topology = new WeakMap<BufferGeometry, PreviewMeshTopology>()

// Creased normals duplicate vertices for WebGL shading. Booleans still need
// the original indexed topology, including separate fans at touching points.
export const rememberPreviewMeshTopology = (geometry: BufferGeometry, data: PreviewMeshTopology) => { topology.set(geometry, data) }
export const previewMeshTopology = (geometry: BufferGeometry) => topology.get(geometry)
