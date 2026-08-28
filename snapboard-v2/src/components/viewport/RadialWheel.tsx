// ============ Alt 长按轮盘 (RPG 武器轮盘式): 快速切换编辑工具 ============
// 操作: 按住 Alt ≥220ms → 轮盘在指针处弹出; 移动鼠标高亮扇区; 松开 Alt 选中; ESC 取消。
// 三大特性:
//   1) 鼠标中键 = 拖动平移视图 (恢复原行为, 左键保持纯绘图/选择)
//   2) 3D 视图关闭轮盘 (装配视图不需要快速切工具, 避免与旋转/平移冲突)
//   3) 轮盘首扇区 = 【返回上一步绘图工具】(如擦除后回矩形/直线), 其余为 选择/擦除/智能尺寸
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import type { ToolId } from '../../types/geometry'

export interface WheelItem {
  id: ToolId
  icon: string
  label: string
}

export interface WheelState {
  x: number
  y: number
  active: number | null
}

/** 工具图标/名称 (轮盘与"返回上一步"扇区共用) */
export const TOOL_META: Record<string, { icon: string; label: string }> = {
  select: { icon: '🖱', label: '选择' },
  line: { icon: '✏️', label: '直线' },
  rect: { icon: '▭', label: '矩形' },
  circle: { icon: '◯', label: '圆' },
  arc: { icon: '◠', label: '弧' },
  polygon: { icon: '⬡', label: '多边形' },
  slot: { icon: '💊', label: '槽口' },
  offset: { icon: '⇉', label: '等距' },
  eraser: { icon: '✂', label: '擦除' },
  smartdim: { icon: '↔', label: '智能尺寸' },
}

/**
 * 轮盘成员: [返回上一步绘图工具, 选择, 擦除, 智能尺寸]。
 * 首扇区动态显示最近一次绘图工具 (上次在矩形就显示"返回矩形")。
 */
export function wheelItems(lastDrawTool: ToolId): WheelItem[] {
  const back = TOOL_META[lastDrawTool] ?? TOOL_META.rect
  return [
    { id: lastDrawTool, icon: back.icon, label: '返回' + back.label },
    { id: 'select', icon: '🖱', label: '选择' },
    { id: 'eraser', icon: '✂', label: '擦除' },
    { id: 'smartdim', icon: '↔', label: '智能尺寸' },
  ]
}

const HOLD_MS = 220

/** 轮盘是否正在显示 (供 2D 画布识别并让位) */
export const wheelBusy = { open: false }

/**
 * 长按 Alt 呼出轮盘 (RPG 武器轮盘式):
 *   - 按住 Alt ≥220ms → 轮盘在鼠标位置弹出; 移动鼠标高亮扇区
 *   - 松开 Alt → 选中当前高亮扇区; Esc / 失焦 → 取消
 * 鼠标中键恢复为"拖动平移视图" (不再负责轮盘), 左键保持纯绘图/选择。
 */
export function useRadialWheel(): WheelState | null {
  const [state, setState] = useState<WheelState | null>(null)
  const openRef = useRef(false)
  const activeRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)
  const lastMouseRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const open = (x: number, y: number) => {
      openRef.current = true
      wheelBusy.open = true // 让画布/其他 UI 让位
      activeRef.current = null
      setState({ x, y, active: null })
    }
    const close = () => {
      openRef.current = false
      wheelBusy.open = false
      activeRef.current = null
      if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null }
      setState(null)
    }

    const items = () => wheelItems(useAppStore.getState().ui.lastDrawTool)

    // 记住鼠标最后位置 (Alt 长按后轮盘在指针处弹出)
    const onMouseMoveTrack = (e: MouseEvent) => {
      lastMouseRef.current = { x: e.clientX, y: e.clientY }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return
      e.preventDefault() // 防止浏览器菜单等默认行为
      if (openRef.current || timerRef.current !== null) return
      const s = useAppStore.getState()
      if (s.ui.viewMode !== '2d') return // 3D 视图关闭轮盘 (装配只需拖动/旋转)
      timerRef.current = window.setTimeout(
        () => open(lastMouseRef.current.x, lastMouseRef.current.y),
        HOLD_MS,
      )
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return
      if (openRef.current) {
        e.preventDefault()
        const idx = activeRef.current
        const list = items()
        if (idx !== null && list[idx]) {
          useAppStore.getState().setUI({ activeTool: list[idx].id })
        }
        close()
      } else if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const onPointerMoveCapture = (e: PointerEvent) => {
      if (openRef.current) e.stopPropagation()
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!openRef.current) return
      const dx = e.clientX - (stateRef.current?.x ?? e.clientX)
      const dy = e.clientY - (stateRef.current?.y ?? e.clientY)
      const ang = Math.atan2(dy, dx) // 屏幕角度: 0=右, -π/2=上
      const list = items()
      const n = list.length
      let best = 0, bestD = Infinity
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (2 * Math.PI / n) * i
        let d = Math.abs(ang - a)
        if (d > Math.PI) d = 2 * Math.PI - d
        if (d < bestD) { bestD = d; best = i }
      }
      const hit = bestD < Math.PI / n
      activeRef.current = hit ? best : null
      setState(s => (s ? { ...s, active: activeRef.current } : s))
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onBlur = () => close()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('pointermove', onPointerMoveCapture, true)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mousemove', onMouseMoveTrack)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointermove', onPointerMoveCapture, true)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mousemove', onMouseMoveTrack)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // 切到 3D 时若轮盘还开着 → 立即关闭
  useEffect(() => {
    const closeOn3d = () => {
      if (useAppStore.getState().ui.viewMode !== '2d' && openRef.current) {
        openRef.current = false
        wheelBusy.open = false
        activeRef.current = null
        setState(null)
      }
    }
    return useAppStore.subscribe(closeOn3d)
  }, [])

  // 供 onMouseMove 读取最新位置 (事件闭包内拿不到 state)
  const stateRef = useRef<WheelState | null>(null)
  stateRef.current = state

  return state
}

/** 轮盘视觉 (纯展示, pointer-events=none; 命中选择由 hook 的角度判定完成) */
export function RadialWheel({ state }: { state: WheelState | null }) {
  const lastDrawTool = useAppStore(s => s.ui.lastDrawTool)
  const items = wheelItems(lastDrawTool)
  if (!state) return null

  const R = 96
  const pad = 12
  const size = (R + pad) * 2
  const cx = size / 2
  const cy = size / 2
  const n = items.length
  const r = Math.PI / n // 半扇区角

  const sectorPath = (i: number) => {
    const a0 = -Math.PI / 2 + (2 * Math.PI / n) * i - r
    const a1 = a0 + (2 * Math.PI / n)
    const x0 = cx + R * Math.cos(a0)
    const y0 = cy + R * Math.sin(a0)
    const x1 = cx + R * Math.cos(a1)
    const y1 = cy + R * Math.sin(a1)
    return `M ${cx} ${cy} L ${x0} ${y0} A ${R} ${R} 0 0 1 ${x1} ${y1} Z`
  }

  return (
    <div
      className="wheel-pop"
      style={{
        position: 'fixed',
        left: state.x, top: state.y,
        transform: 'translate(-50%, -50%)',
        zIndex: 9999,
        pointerEvents: 'none',
        filter: 'drop-shadow(0 10px 26px rgba(0,0,0,0.65))',
      }}
    >
      <svg width={size} height={size} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="wheelRim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#4dd6c0" />
            <stop offset="100%" stopColor="#5ea4ff" />
          </linearGradient>
          <radialGradient id="wheelBase" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(38,45,58,0.97)" />
            <stop offset="100%" stopColor="rgba(22,26,36,0.97)" />
          </radialGradient>
        </defs>

        {/* 底盘 (亮色描边 + 外发光, 与深色背景拉开) */}
        <circle cx={cx} cy={cy} r={R + 6} fill="url(#wheelBase)" />
        <circle cx={cx} cy={cy} r={R + 6} fill="none" stroke="url(#wheelRim)" strokeWidth={2.5} />
        <circle cx={cx} cy={cy} r={R + 11} fill="none" stroke="rgba(94,164,255,0.18)" strokeWidth={6} />

        {/* 扇区 */}
        {items.map((item, i) => {
          const on = state.active === i
          const a = -Math.PI / 2 + (2 * Math.PI / n) * i
          const lx = cx + R * 0.6 * Math.cos(a)
          const ly = cy + R * 0.6 * Math.sin(a)
          const ly2 = ly + 17
          return (
            <g key={item.id}>
              <path
                d={sectorPath(i)}
                fill={on ? 'rgba(94,164,255,0.42)' : i === 0 ? 'rgba(77,214,192,0.14)' : 'rgba(255,255,255,0.06)'}
                stroke={on ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)'}
                strokeWidth={1.2}
                style={{ transition: 'fill 0.1s ease' }}
              />
              <text
                x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
                fontSize={26} fill="#ffffff" style={{ userSelect: 'none' }}
              >{item.icon}</text>
              <text
                x={lx} y={ly2} textAnchor="middle" dominantBaseline="middle"
                fontSize={12.5} fill={on ? '#ffffff' : i === 0 ? '#8ef0dc' : '#d7dde8'} fontWeight={700}
                style={{ userSelect: 'none' }}
              >{item.label}</text>
            </g>
          )
        })}

        {/* 中心圆钮 */}
        <circle cx={cx} cy={cy} r={32} fill="#2c3342" stroke="rgba(120,200,255,0.55)" strokeWidth={1.5} />
        <circle cx={cx} cy={cy} r={26} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
        <text
          x={cx} y={cy} textAnchor="middle" dominantBaseline="middle"
          fontSize={22} fill="#bfeaff"
        >
          {state.active !== null ? items[state.active].icon : '⌖'}
        </text>
      </svg>
    </div>
  )
}
