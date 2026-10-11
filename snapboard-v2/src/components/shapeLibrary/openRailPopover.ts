export function openRailPopover(button: HTMLElement, panel: HTMLElement | null): void {
  if (!panel) return
  if (panel.matches(':popover-open')) { panel.hidePopover(); return }
  const anchor = button.getBoundingClientRect()
  panel.style.left = `${Math.min(anchor.right + 8, window.innerWidth - Math.min(300, window.innerWidth - 24) - 12)}px`
  panel.style.top = `${Math.max(56, Math.min(anchor.top, window.innerHeight - Math.min(520, window.innerHeight * .66) - 12))}px`
  panel.showPopover()
}
