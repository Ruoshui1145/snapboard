import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const vite = await createServer({
  root,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
})

try {
  const shapeImport = await vite.ssrLoadModule('/src/features/shapeLibrary/import/index.ts')

  const maliciousScript = shapeImport.importSvgString(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <script>alert('xss')</script><rect x="0" y="0" width="100" height="100"/>
    </svg>
  `)
  assert.equal(maliciousScript.draft, null)
  assert.ok(maliciousScript.errors.some(issue => issue.code === 'SVG_DANGEROUS_ELEMENT'))

  const maliciousReference = shapeImport.importSvgString(`
    <svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/a.svg#shape"/></svg>
  `)
  assert.equal(maliciousReference.draft, null)
  assert.ok(maliciousReference.errors.some(issue =>
    issue.code === 'SVG_DANGEROUS_ELEMENT' || issue.code === 'SVG_DANGEROUS_ATTRIBUTE'))

  const curved = shapeImport.importSvgString(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100">
      <path transform="translate(5 3)" d="M 0 50 C 0 5 45 0 55 25 Q 85 0 105 45 A 30 25 0 0 1 80 78 L 25 78 Z"/>
    </svg>
  `, { curveTolerance: 0.15 })
  assert.deepEqual(curved.errors, [])
  assert.ok(curved.draft)
  assert.ok(curved.draft.outer.length > 20, 'Bezier and elliptical arcs must be adaptively tessellated')
  assert.equal(curved.draft.holes.length, 0)

  const roleAware = shapeImport.importSvgString(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">
      <rect x="0" y="0" width="100" height="80"/>
      <circle cx="50" cy="40" r="12"/>
    </svg>
  `)
  assert.deepEqual(roleAware.errors, [])
  assert.ok(roleAware.draft)
  assert.equal(roleAware.draft.holes.length, 1, 'contained SVG loops must retain the inner role')
  const adapted = shapeImport.adaptImportedShapeDraft(roleAware.draft, { targetWidth: 200 })
  assert.equal(adapted[0].type, 'outer')
  assert.equal(adapted[1].type, 'inner')

  const multiOuterWithHole = shapeImport.importSvgString(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 110 50">
      <rect x="0" y="0" width="40" height="40"/>
      <rect x="60" y="0" width="40" height="40"/>
      <circle cx="80" cy="20" r="8"/>
    </svg>
  `)
  assert.deepEqual(multiOuterWithHole.errors, [])
  assert.ok(multiOuterWithHole.draft)
  assert.equal(multiOuterWithHole.draft.fragments.length, 1)
  assert.equal(multiOuterWithHole.draft.holes.length, 1,
    'a hole inside a disconnected sign component must remain an inner contour')
  const multiAdapted = shapeImport.adaptImportedShapeDraft(multiOuterWithHole.draft)
  assert.equal(multiAdapted.filter(contour => contour.type === 'outer').length, 2)
  assert.equal(multiAdapted.filter(contour => contour.type === 'inner').length, 1)
  assert.equal(adapted[0].closed, true)

  const width = 12
  const height = 10
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 2; y < 8; y++) {
    for (let x = 2; x < 10; x++) {
      const offset = (y * width + x) * 4
      pixels[offset] = 255
      pixels[offset + 1] = 255
      pixels[offset + 2] = 255
      pixels[offset + 3] = 255
    }
  }
  const bitmap = shapeImport.importBitmapImageData({ width, height, data: pixels }, {
    thresholdMode: 'auto',
    simplifyTolerance: 0.25,
  })
  assert.deepEqual(bitmap.errors, [])
  assert.ok(bitmap.draft)
  assert.equal(bitmap.draft.bounds.width, 8)
  assert.equal(bitmap.draft.bounds.height, 6)
  assert.equal(bitmap.draft.outer.length, 4, 'transparent rectangular silhouette should reduce to four corners')

  const separatedWidth = 24
  const separatedHeight = 12
  const separatedPixels = new Uint8ClampedArray(separatedWidth * separatedHeight * 4)
  for (let pixel = 0; pixel < separatedWidth * separatedHeight; pixel++) {
    separatedPixels[pixel * 4] = 255
    separatedPixels[pixel * 4 + 1] = 255
    separatedPixels[pixel * 4 + 2] = 255
    separatedPixels[pixel * 4 + 3] = 255
  }
  const paintDarkRect = (x1, y1, x2, y2) => {
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
      const offset = (y * separatedWidth + x) * 4
      separatedPixels[offset] = 40
      separatedPixels[offset + 1] = 110
      separatedPixels[offset + 2] = 190
    }
  }
  paintDarkRect(1, 2, 7, 10)
  paintDarkRect(10, 3, 15, 9)
  paintDarkRect(18, 1, 23, 11)
  const separated = shapeImport.importBitmapImageData({
    width: separatedWidth,
    height: separatedHeight,
    data: separatedPixels,
  }, {
    thresholdMode: 'luminance',
    luminanceThreshold: 255,
    simplifyTolerance: 0,
    minComponentPixels: 4,
  })
  assert.deepEqual(separated.errors, [])
  assert.ok(separated.draft)
  assert.equal(separated.draft.fragments.length, 2,
    'white background must stay excluded at threshold 255 and disconnected marks must be retained')
  const separatedContours = shapeImport.adaptImportedShapeDraft(separated.draft)
  assert.equal(separatedContours.filter(contour => contour.type === 'outer').length, 3,
    'each disconnected sign/logo component must become its own outer contour')
  assert.ok(separated.warnings.some(issue => issue.code === 'BITMAP_COMPONENTS_RETAINED'))

  const donutWidth = 20
  const donutHeight = 20
  const donutPixels = new Uint8ClampedArray(donutWidth * donutHeight * 4)
  for (let y = 2; y < 18; y++) {
    for (let x = 2; x < 18; x++) {
      if (x >= 7 && x < 13 && y >= 7 && y < 13) continue
      const offset = (y * donutWidth + x) * 4
      donutPixels[offset + 3] = 255
    }
  }
  const bitmapWithHole = shapeImport.importBitmapImageData({
    width: donutWidth,
    height: donutHeight,
    data: donutPixels,
  }, { simplifyTolerance: 0.25 })
  assert.deepEqual(bitmapWithHole.errors, [])
  assert.ok(bitmapWithHole.draft)
  assert.equal(bitmapWithHole.draft.holes.length, 1, 'bitmap boundary tracing must retain transparent inner holes')

  const strokeSize = 24
  const strokePixels = new Uint8ClampedArray(strokeSize * strokeSize * 4)
  for (let y = 2; y < 22; y++) for (let x = 2; x < 22; x++) {
    if (x >= 4 && x < 20 && y >= 4 && y < 20) continue
    strokePixels[(y * strokeSize + x) * 4 + 3] = 255
  }
  const closedStroke = shapeImport.importBitmapImageData({
    width: strokeSize,
    height: strokeSize,
    data: strokePixels,
  }, { simplifyTolerance: 0, outlineInterpretation: 'auto' })
  assert.deepEqual(closedStroke.errors, [])
  assert.ok(closedStroke.draft)
  assert.equal(closedStroke.draft.holes.length, 0,
    'a thin closed marker band must become a solid board instead of a giant cutout')
  assert.ok(closedStroke.warnings.some(issue => issue.code === 'BITMAP_STROKE_INTERIOR_FILLED'))
  const rawStroke = shapeImport.importBitmapImageData({
    width: strokeSize,
    height: strokeSize,
    data: strokePixels,
  }, { simplifyTolerance: 0, outlineInterpretation: 'silhouette' })
  assert.ok(rawStroke.draft)
  assert.equal(rawStroke.draft.holes.length, 0,
    'solid silhouette mode must fill every enclosed cavity and keep only the outside silhouette')
  assert.ok(rawStroke.warnings.some(issue => issue.code === 'BITMAP_SOLID_SILHOUETTE'))
  const forcedClosedStroke = shapeImport.importBitmapImageData({
    width: strokeSize,
    height: strokeSize,
    data: strokePixels,
  }, { simplifyTolerance: 0, outlineInterpretation: 'closed-stroke' })
  assert.ok(forcedClosedStroke.draft)
  assert.equal(forcedClosedStroke.draft.holes.length, 0,
    'closed stroke mode must use the relaxed line-band detector and fill its enclosed area')

  const noisyLoop = Array.from({ length: 120 }, (_, index) => {
    const angle = index * Math.PI * 2 / 120
    const radius = 50 + Math.sin(index * 1.7) * 1.8
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
  })
  const beforeSmoothArea = Math.abs(shapeImport.signedArea(noisyLoop))
  const smoothedLoop = shapeImport.taubinSmooth(noisyLoop, 2)
  const afterSmoothArea = Math.abs(shapeImport.signedArea(smoothedLoop))
  assert.ok(Math.abs(afterSmoothArea - beforeSmoothArea) / beforeSmoothArea < 1e-8,
    'Taubin smoothing must preserve closed-loop area instead of shrinking the board')

  const denseCircle = Array.from({ length: 2400 }, (_, index) => ({
    x: 100 + 90 * Math.cos(index * Math.PI * 2 / 2400),
    y: 100 + 90 * Math.sin(index * Math.PI * 2 / 2400),
  }))
  const denseDraft = {
    version: 1,
    source: 'svg',
    name: 'dense',
    outer: denseCircle,
    holes: [],
    fragments: [],
    bounds: shapeImport.boundsOfRings([denseCircle]),
  }
  const simplified = shapeImport.normalizeAndValidateShape(denseDraft, { maxVertices: 64 })
  assert.equal(simplified.valid, true)
  assert.ok(simplified.draft.outer.length <= 64)
  assert.ok(simplified.warnings.some(issue => issue.code === 'VERTEX_LIMIT_SIMPLIFIED'))

  const bowTie = [
    { x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 },
  ]
  const invalid = shapeImport.normalizeAndValidateShape({
    version: 1,
    source: 'svg',
    name: 'self-intersection',
    outer: bowTie,
    holes: [],
    fragments: [],
    bounds: shapeImport.boundsOfRings([bowTie]),
  })
  assert.equal(invalid.valid, false)
  assert.equal(invalid.draft, null)
  assert.ok(invalid.errors.some(issue => issue.code === 'SELF_INTERSECTION'))

  console.log('shape import regression: secure SVG, closed-stroke fill, non-shrinking smoothing, role-aware holes, disconnected components, simplification and self-intersection passed')
} finally {
  await vite.close()
}
