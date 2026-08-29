// ============ 命令模式 — 可撤销操作的基础 ============

export interface Command {
  /** 执行 (记录 undo 所需状态) */
  execute(): void
  /** 撤销 */
  undo(): void
  /** 重做 */
  redo(): void
  /** 命令描述 (用于 UI 显示) */
  label: string
  /** 是否修改草图/轮廓，从而需要同步自动分割；配件和旧演示板命令为 false。 */
  affectsSketch?: boolean
}

/** 把一次用户手势涉及的多个几何修改作为一个可撤销操作提交。 */
export class CompositeCommand implements Command {
  label: string
  private commands: Command[]

  constructor(label: string, commands: Command[]) {
    this.label = label
    this.commands = commands
  }

  get affectsSketch(): boolean {
    return this.commands.some(command => command.affectsSketch !== false)
  }

  execute(): void {
    for (const command of this.commands) command.execute()
  }

  undo(): void {
    for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i].undo()
  }

  redo(): void {
    for (const command of this.commands) command.redo()
  }
}
