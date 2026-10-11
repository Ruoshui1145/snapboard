/** Same effective design gets the same identity before/after JSON parsing or editor loading. */
export function legacyManufacturingIdentityJson(workspace) {
  return JSON.stringify({ ...workspace, orderLink: undefined, lastTextureSampling: undefined,
    splitResult: workspace.splitResult ? { ...workspace.splitResult, ts: undefined } : null })
}
export function manufacturingIdentityJson(workspace) {
  const snapshot = { ...workspace, orderLink: undefined, lastTextureSampling: undefined,
    splitResult: workspace.splitResult ? { ...workspace.splitResult, ts: undefined } : null }
  if (snapshot.assemblyMarking) snapshot.assemblyMarking={...snapshot.assemblyMarking,orderSideNumber:undefined,orderSideSourceId:undefined}
  if (snapshot.boardTexture) {
    const texture = snapshot.boardTexture
    snapshot.boardTexture = { ...texture,
      woodGrain: !texture.enabled || texture.surfaceMode !== 'woodgrain' ? undefined : texture.woodGrain,
      pattern: !texture.enabled || texture.source !== 'pattern' ? undefined : {
        ...texture.pattern, truchetOrientationBias: texture.pattern?.truchetOrientationBias ?? .5,
        maxPrimitives: texture.pattern?.maxPrimitives ?? 50_000,
      } }
  }
  return JSON.stringify(snapshot, function (key, value) {
    if (key === 'arcs' && Array.isArray(value) && value.length === 0) return undefined
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]]))
    }
    return value
  })
}
