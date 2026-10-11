import { buildRasterTextureLayer, type RasterLayerInput } from '../utils/textureRasterLayer'

self.onmessage = (event: MessageEvent<RasterLayerInput>) => {
  try { self.postMessage({ result: buildRasterTextureLayer(event.data) }) }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
