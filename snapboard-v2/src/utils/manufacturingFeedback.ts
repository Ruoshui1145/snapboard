export interface OrderExportRequest {
  requestId: string
  orderId: string
  orderNumber: string
  accepted?: boolean
}
export const SIDE_PREVIEW_REQUEST_EVENT = 'snapboard:side-order-preview-request'

export interface ManufacturingFeedback {
  requestId: string
  phase: 'running' | 'success' | 'error' | 'cancelled'
  message: string
  progress?: number
  orderId?: string
  orderNumber?: string
  panelCount?: number
  fileName?: string
  savedLocation?: string
  downloadUrl?: string
}

export const MANUFACTURING_FEEDBACK_EVENT = 'snapboard:manufacturing-feedback'
let latest: ManufacturingFeedback | null = null
export const latestManufacturingFeedback = () => latest
export function manufacturingFailureMessage(message: string) {
  if (message.includes('当前设计与冻结订单不一致') || message.includes('原始工程附件可鉴证'))
    return '当前图纸还不是这个订单已确认的生产版本。请先把当前设计交付到对应订单并确认规格，再侧刻订单号。'
  return message
}
export function publishManufacturingFeedback(value: ManufacturingFeedback) {
  latest = value
  window.dispatchEvent(new CustomEvent(MANUFACTURING_FEEDBACK_EVENT, { detail: value }))
}
