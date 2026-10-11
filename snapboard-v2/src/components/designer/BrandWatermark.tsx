import { SNAPBOARD_ORIGIN_URL, SNAPBOARD_PUBLICATION_NOTICE } from '../../utils/snapboardAttribution'
import './BrandWatermark.css'

/** Static DOM only: never changes printable geometry, texture colours or WebGL frames. */
export function BrandWatermark() {
  return <div className="snapboard-watermark" aria-hidden="true" data-i18n-ignore="true">
    <div className="snapboard-watermark-pattern" />
    <div className="snapboard-watermark-badge"><b>{SNAPBOARD_PUBLICATION_NOTICE}</b><span>{new URL(SNAPBOARD_ORIGIN_URL).hostname}</span></div>
  </div>
}
