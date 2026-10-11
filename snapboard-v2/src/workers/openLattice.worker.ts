/// <reference lib="webworker" />

import type { Point2D, SplitConfig, SplitPanel, SvgLatticeOptions } from '../types/geometry'
import type { SplitWorkerTarget } from './splitEngineProtocol'
import { splitOrthogonalPolygon } from '../utils/pegboardSplit'
import { generateOpenLattice, type OpenLatticeResult, type OpenLatticeStyle } from '../utils/openLattice'
import { applyLatticeFrontLayer, estimateLatticeVolume, generateSvgLattice, type SvgLatticeArtwork } from '../utils/svgLattice'
import { estimateLatticeMass } from '../utils/latticeMass'

export interface OpenLatticeRequest {
  panels?: SplitPanel[]
  targets?: SplitWorkerTarget[]
  holes: Point2D[][]
  config: SplitConfig
  ribMm: number
  style: OpenLatticeStyle
  artwork?: SvgLatticeArtwork
  svgOptions?: SvgLatticeOptions
  surfaceMm?: number
  latticeOptions?: SplitPanel['latticeOptions']
  massProfile?: { baselineGrams?:number; infillPercent:number; frontDenseMm:number }
  manualHoleStates?: Array<{ x: number; y: number; knocked: boolean }>
}

export type OpenLatticeResponse =
  | { type: 'progress'; phase: 'preparing' | 'generating'; completed: number; total: number }
  | { type: 'result'; sections: Array<{ panel: SplitPanel; lattice: OpenLatticeResult }> }
  | { type: 'error'; message: string }

const send = (response: OpenLatticeResponse) => self.postMessage(response)

self.addEventListener('message', (event: MessageEvent<OpenLatticeRequest>) => {
  const request = event.data
  try {
    const panels = request.panels ?? []
    if (request.targets) {
      for (let i = 0; i < request.targets.length; i++) {
        const target = request.targets[i]
        const result = splitOrthogonalPolygon({
          points: target.points,
          holes: target.holes ?? request.holes,
          cornerPolicy: target.cornerPolicy,
        }, target.config ?? request.config)
        panels.push(...result.panels)
        send({ type: 'progress', phase: 'preparing', completed: i + 1, total: request.targets.length })
      }
    }
    if (!panels.length) throw new Error('没有可生成镂空的板件，请先更新板件')
    if ((request.style === 'svg' || request.style === 'flower') && !request.artwork)
      throw new Error('SVG 轮廓未识别，请重新上传线稿')
    for (const panel of panels) for (const hole of panel.edge_holes) {
      const saved = request.manualHoleStates?.find(candidate =>
        Math.abs(candidate.x - hole.x) < 0.001 && Math.abs(candidate.y - hole.y) < 0.001)
      if (saved) hole.knocked = saved.knocked
    }
    const sections: Array<{ panel: SplitPanel; lattice: OpenLatticeResult }> = []
    const baselineMasses=request.massProfile?panels.map(p=>estimateLatticeMass({...p,latticeCutouts:undefined,latticeFace:undefined,latticeOptions:undefined},request.config,request.massProfile!).grams):[]
    const rawBaseline=baselineMasses.reduce((s,g)=>s+g,0)
    const factor=request.massProfile?.baselineGrams&&rawBaseline?request.massProfile.baselineGrams/rawBaseline:1
    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i]
      panel.latticeOptions=request.latticeOptions
      try {
        let lattice = request.style === 'svg' || request.style === 'flower'
        ? generateSvgLattice(panel, request.config, request.artwork!, request.ribMm, request.style, request.svgOptions)
        : generateOpenLattice(panel, request.config, request.ribMm, request.style)
        if (!lattice.face) lattice = applyLatticeFrontLayer(panel, request.config, lattice, request.surfaceMm)
        lattice=estimateLatticeVolume(panel, request.config, lattice)
        if(request.massProfile){
          const mass=estimateLatticeMass({...panel,latticeCutouts:lattice.holes,latticeFace:lattice.face},request.config,request.massProfile)
          lattice.massEstimate={grams:mass.grams*factor,savingPercent:(1-mass.grams/baselineMasses[i])*100,calibrated:factor!==1,baselineGrams:baselineMasses[i]*factor}
        }
        sections.push({ panel, lattice })
      }
      catch (error) { throw new Error(`${panel.id.toUpperCase()}：${error instanceof Error ? error.message : String(error)}`) }
      send({ type: 'progress', phase: 'generating', completed: i + 1, total: panels.length })
    }
    send({ type: 'result', sections })
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
})
