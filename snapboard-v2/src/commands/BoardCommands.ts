// ============ 洞洞板 & 配件命令 ============
import { useAppStore } from '../store/useAppStore'
import type { Command } from './Command'
import type { Board } from '../types/geometry'
import type { PlacedPart } from '../partLibrary/types'

/** 添加洞洞板 */
export class AddBoardCommand implements Command {
  label = '添加洞洞板'
  affectsSketch = false
  private board: Board

  constructor(board: Board) {
    this.board = board
  }

  execute(): void {
    const s = useAppStore.getState()
    if (!s.boards.find(b => b.id === this.board.id)) {
      useAppStore.setState({ boards: [...s.boards, this.board] })
    }
  }

  undo(): void {
    const s = useAppStore.getState()
    useAppStore.setState({ boards: s.boards.filter(b => b.id !== this.board.id) })
  }

  redo(): void {
    this.execute()
  }
}

/** 放置配件 (自动吸附到孔位) */
export class PlacePartCommand implements Command {
  label = '放置配件'
  affectsSketch = false
  private placed: PlacedPart

  constructor(placed: PlacedPart) {
    this.placed = placed
  }

  execute(): void {
    const s = useAppStore.getState()
    if (!s.placedParts.find(p => p.id === this.placed.id)) {
      useAppStore.setState({ placedParts: [...s.placedParts, this.placed] })
    }
  }

  undo(): void {
    const s = useAppStore.getState()
    useAppStore.setState({ placedParts: s.placedParts.filter(p => p.id !== this.placed.id) })
  }

  redo(): void {
    this.execute()
  }
}

/** 移动已装配配件到另一组孔位（可撤销/重做）。 */
export class MovePartCommand implements Command {
  label = '移动配件'
  affectsSketch = false
  private before: PlacedPart | null = null
  private partId: string
  private after: PlacedPart

  constructor(partId: string, after: PlacedPart) {
    this.partId = partId
    this.after = after
  }

  execute(): void {
    const state = useAppStore.getState()
    this.before ??= state.placedParts.find(part => part.id === this.partId) ?? null
    useAppStore.setState({
      placedParts: state.placedParts.map(part => part.id === this.partId ? this.after : part),
    })
  }

  undo(): void {
    if (!this.before) return
    const state = useAppStore.getState()
    useAppStore.setState({
      placedParts: state.placedParts.map(part => part.id === this.partId ? this.before! : part),
    })
  }

  redo(): void {
    const state = useAppStore.getState()
    useAppStore.setState({
      placedParts: state.placedParts.map(part => part.id === this.partId ? this.after : part),
    })
  }
}

/** 移除配件 */
export class RemovePartCommand implements Command {
  label = '移除配件'
  affectsSketch = false
  private part: PlacedPart | null = null
  private partId: string

  constructor(partId: string) {
    this.partId = partId
  }

  execute(): void {
    const s = useAppStore.getState()
    this.part = s.placedParts.find(p => p.id === this.partId) ?? null
    useAppStore.setState({ placedParts: s.placedParts.filter(p => p.id !== this.partId) })
  }

  undo(): void {
    if (this.part) {
      const s = useAppStore.getState()
      useAppStore.setState({ placedParts: [...s.placedParts, this.part] })
    }
  }

  redo(): void {
    this.execute()
  }
}
