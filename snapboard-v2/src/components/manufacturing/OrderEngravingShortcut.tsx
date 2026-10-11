import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { orderRequest } from '../../utils/orderDelivery'
import { MANUFACTURING_FEEDBACK_EVENT, SIDE_PREVIEW_REQUEST_EVENT, latestManufacturingFeedback, type ManufacturingFeedback, type OrderExportRequest } from '../../utils/manufacturingFeedback'

type OrderChoice = { id: string; number: string; status: string }

/** Apply a model-side number and preview it; existing export controls save files separately. */
export function OrderEngravingShortcut({ disabled = false }: { disabled?: boolean }) {
  const productionLink = useAppStore(state => state.orderLink)
  const marking = useAppStore(state => state.assemblyMarking)
  const link = marking.orderSideSourceId && marking.orderSideNumber ? {id:marking.orderSideSourceId,number:marking.orderSideNumber} : productionLink
  const [orders, setOrders] = useState<OrderChoice[]>([])
  const [selected, setSelected] = useState(link?.id ?? '')
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const activeId = useRef<string | null>(null), busyRef = useRef(false)
  const [feedback, setFeedback] = useState<ManufacturingFeedback | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setSelected(link?.id ?? '')
    orderRequest('/bootstrap', undefined, 'GET', controller.signal).then(result => {
      if (!controller.signal.aborted) setOrders(result.orders)
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [link?.id])
  useEffect(() => {
    const receive = (value: ManufacturingFeedback) => {
      if (value.requestId !== activeId.current) return
      setFeedback(value); busyRef.current = value.phase === 'running'; setBusy(busyRef.current)
    }
    const previous = latestManufacturingFeedback()
    if (!activeId.current && previous && previous.orderId === link?.id) { activeId.current = previous.requestId; receive(previous) }
    const listener = (event: Event) => receive((event as CustomEvent<ManufacturingFeedback>).detail)
    window.addEventListener(MANUFACTURING_FEEDBACK_EVENT, listener)
    return () => window.removeEventListener(MANUFACTURING_FEEDBACK_EVENT, listener)
  }, [link?.id])
  useEffect(() => () => request.current?.abort(), [])
  const engrave = async () => {
    if (disabled || loading || busyRef.current || !selected) return
    const before = useAppStore.getState(), controller = new AbortController()
    request.current = controller; busyRef.current = true; setBusy(true); setError('')
    activeId.current = crypto.randomUUID()
    setFeedback({ requestId: activeId.current, phase: 'running', message: '正在读取所选订单…', progress: 0 })
    try {
      const order = await orderRequest(`/orders/${encodeURIComponent(selected)}`, undefined, 'GET', controller.signal)
      if (controller.signal.aborted) return
      const current = useAppStore.getState()
      if (current.project !== before.project || current.splitResult !== before.splitResult || current.orderLink !== before.orderLink || current.splitJob)
        throw new Error('当前设计或订单关联已变化，请重新选择订单')
      if (order.status === 'cancelled') throw new Error('已取消订单不能用于侧刻订单号')
      const previewRequest: OrderExportRequest = { requestId: activeId.current!, orderId: order.id, orderNumber: order.number }
      window.dispatchEvent(new CustomEvent(SIDE_PREVIEW_REQUEST_EVENT, { detail: previewRequest }))
      if (!previewRequest.accepted) throw new Error('板件预览尚未就绪，请切换到 3D 后重试')
      current.setAssemblyMarking({orderSideNumber:order.number,orderSideSourceId:order.id})
      current.setUI({viewMode:'3d'})
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = cause instanceof Error ? cause.message : '订单读取失败'
        setError(message); setFeedback({ requestId: activeId.current!, phase: 'error', message })
        busyRef.current = false; setBusy(false)
      }
    }
  }
  return <section className="export-order-engraving" aria-label="侧刻订单号">
    <strong>侧刻订单号</strong>
    <div className="export-order-actions"><label>选择订单<select aria-label="选择侧刻订单" value={selected} disabled={loading || busy || disabled} onChange={event => { setSelected(event.target.value); setError(''); setFeedback(null); activeId.current = null }}>
      <option value="">{loading ? '正在读取订单…' : '请选择订单'}</option>
      {link && !orders.some(order => order.id === link.id) && <option value={link.id} data-i18n-ignore="true">{link.number}</option>}
      {orders.filter(order => order.status !== 'cancelled').map(order => <option key={order.id} value={order.id} data-i18n-ignore="true">{order.number}</option>)}
    </select></label><button type="button" className="export-primary-action" disabled={disabled || loading || busy || !selected} onClick={() => void engrave()}>{busy ? '正在应用侧刻…' : '侧刻订单号'}</button></div>
    {feedback && <div className={`export-order-feedback is-${feedback.phase}`} aria-live="polite" role={feedback.phase === 'error' ? 'alert' : 'status'}>
      <strong>{feedback.message}</strong>
      {feedback.phase === 'running' && <progress max={1} value={feedback.progress} aria-label="侧刻预览进度" />}
      {feedback.phase === 'success' && <><small>{feedback.panelCount} 块板件</small></>}
      {(feedback.phase === 'error' || feedback.phase === 'cancelled') && <small>本次侧刻预览未完成，请按提示处理后重试。</small>}
    </div>}
    {error && !feedback && <p role="alert">{error}</p>}
    <small>侧刻只改模型；生成文件用下方导出。</small>
  </section>
}
