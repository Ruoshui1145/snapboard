import * as THREE from 'three'
import type { SplitPanel } from '../types/geometry'

const PALETTE = [0x46f9ed, 0x6295ff, 0xc17aff, 0xff6fab, 0xffc86b].map(c => new THREE.Color(c))
const spectrum = (t: number, color: THREE.Color) => {
  const n = THREE.MathUtils.clamp(t, 0, 1) * (PALETTE.length - 1), i = Math.min(PALETTE.length - 2, Math.floor(n))
  return color.copy(PALETTE[i]).lerp(PALETTE[i + 1], n - i)
}

// Preview only. Geometry, seeds and GPU buffers are prepared once; playback
// changes uniforms only. Three draw calls, capped independently of board count.
export function createLatticeReveal({ scene, previous, current, panels, thickness, camera, reducedMotion = false, onFinish }: {
  scene: THREE.Scene; previous: THREE.Object3D; current: THREE.Object3D; panels: SplitPanel[]
  thickness: number; camera?: THREE.Camera; reducedMotion?: boolean; onFinish: () => void
}) {
  const minX = Math.min(...panels.map(p => p.x)), maxX = Math.max(...panels.map(p => p.x + p.w))
  const minY = Math.min(...panels.map(p => p.y)), maxY = Math.max(...panels.map(p => p.y + p.h))
  const width = Math.max(1, maxX - minX), height = Math.max(1, maxY - minY)
  const uniforms = {
    uReveal: { value: -0.04 }, uTime: { value: 0 }, uTint: { value: PALETTE[0].clone() },
    uBounds: { value: new THREE.Vector4(minX + current.position.x, maxY + current.position.y, width, height) },
  }
  const saved = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  const patched = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  const hiddenSprites: THREE.Object3D[] = []
  previous.traverse(object => { if (((object as THREE.Sprite).isSprite || object.name === 'planned-hole-guide') && object.visible) { object.visible = false; hiddenSprites.push(object) } })
  const temporary = new Set<THREE.Material>()
  const patch = (root: THREE.Object3D, side: number) => root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || patched.get(mesh) === mesh.material) return
    saved.set(mesh, mesh.material)
    const clone = (original: THREE.Material) => {
      const material = original.clone()
      material.clippingPlanes = null
      material.onBeforeCompile = (shader, renderer) => {
        original.onBeforeCompile(shader, renderer)
        Object.assign(shader.uniforms, uniforms)
        shader.vertexShader = 'varying vec2 vRevealWorld;\n' + shader.vertexShader
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>',
          '#include <project_vertex>\nvRevealWorld = (modelMatrix * vec4(transformed, 1.0)).xy;')
        shader.fragmentShader = `varying vec2 vRevealWorld; uniform float uReveal; uniform vec3 uTint; uniform vec4 uBounds;\n` + shader.fragmentShader
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
          vec2 uvReveal = (vRevealWorld - vec2(uBounds.x, uBounds.y)) / uBounds.zw;
          float travel = (uvReveal.x - uvReveal.y) * 0.5;
          float ripple = sin(vRevealWorld.x * 0.31 + vRevealWorld.y * 0.17) *
            sin(vRevealWorld.y * 0.39 - vRevealWorld.x * 0.12) * 0.004;
          float distanceReveal = travel + ripple - uReveal;
          if (distanceReveal * ${side.toFixed(1)} > 0.0) discard;
          float rim = 1.0 - smoothstep(0.001, 0.009, abs(distanceReveal));
          float aura = 1.0 - smoothstep(0.003, 0.035, abs(distanceReveal));
          outgoingLight = mix(outgoingLight, uTint * 1.5, aura * 0.24);
          outgoingLight += uTint * rim * 1.7;
          #include <opaque_fragment>
        `)
      }
      material.customProgramCacheKey = () => `${original.customProgramCacheKey()}|lattice-spectrum-v1|${side}`
      temporary.add(material)
      return material
    }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material)
    patched.set(mesh, mesh.material)
  })
  patch(previous, -1); patch(current, 1)
  const effects = new THREE.Group()
  effects.name = 'lattice-shatter'
  effects.position.copy(current.position)
  effects.userData.previewOnly = true
  scene.add(effects)
  const sign = camera && camera.position.z < current.position.z ? -1 : 1
  const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2)
  const seeds: number[][] = []
  // ponytail: cosmetic grid sampling, not a fracture solver. Cap at 900 shards;
  // exact physical fragments would require expensive triangulation per model.
  const area = panels.reduce((sum, p) => sum + p.w * p.h, 0)
  const spacing = Math.max(12, Math.sqrt(area / 650))
  for (let p = 0; p < panels.length; p++) {
    const panel = panels[p], cols = Math.max(1, Math.ceil(panel.w / spacing)), rows = Math.max(1, Math.ceil(panel.h / spacing))
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      if (seeds.length >= 900) break
      const hash = ((p + 1) * 83492791 ^ (row + 1) * 19349663 ^ (col + 1) * 73856093) >>> 0
      const a = hash % 997 / 997, b = (hash >>> 10) % 991 / 991
      const x = panel.x + (col + 0.2 + a * 0.6) * panel.w / cols
      const y = panel.y + (row + 0.2 + b * 0.6) * panel.h / rows
      if (panel.contour?.length) {
        let inside = false
        for (let i = 0, j = panel.contour.length - 1; i < panel.contour.length; j = i++) {
          const u = panel.contour[i], v = panel.contour[j]
          if ((u.y > y) !== (v.y > y) && x < (v.x - u.x) * (y - u.y) / (v.y - u.y) + u.x) inside = !inside
        }
        if (!inside) continue
      }
      const delay = ((x - minX) / width + (maxY - y) / height) * 0.5
      const size = Math.min(panel.w / cols, panel.h / rows) * (0.35 + b * 0.55)
      seeds.push([x, y, sign > 0 ? thickness + 0.6 : -0.6, delay,
        (a - 0.2) * width * 0.22, (b - 0.55) * height * 0.26, sign * width * (0.08 + b * 0.2),
        size, a * 6.28, b * 6.28, a, b])
    }
    if (seeds.length >= 900) break
  }
  const setAttributes = (geometry: THREE.BufferGeometry, point = false) => {
    const count = seeds.length * (point ? 2 : 1)
    const attr = (name: string, size: number, values: (s: number[], i: number) => number[]) => {
      const buffer = new Float32Array(count * size)
      for (let i = 0; i < count; i++) buffer.set(values(seeds[i % seeds.length], i), i * size)
      geometry.setAttribute(name, point ? new THREE.Float32BufferAttribute(buffer, size) : new THREE.InstancedBufferAttribute(buffer, size))
    }
    attr('aOrigin', 3, s => s.slice(0, 3)); attr('aDelay', 1, (s,i) => [s[3] + (point && i >= seeds.length ? 0.013 : 0)])
    attr('aVelocity', 3, (s,i) => s.slice(4, 7).map(v => v * (point ? 1.2 + (i % 3) * 0.2 : 1)))
    attr('aShape', 3, (s,i) => [point ? 0.9 + s[11] * 1.8 : s[7], s[8] + i * 0.2, s[9]])
    const c = new THREE.Color()
    attr('aTint', 3, s => spectrum(s[3] * 0.8 + s[10] * 0.2, c).toArray())
    return count
  }
  const motion = `
    uniform float uReveal; uniform float uTime;
    attribute vec3 aOrigin; attribute float aDelay; attribute vec3 aVelocity;
    attribute vec3 aShape; attribute vec3 aTint;
    varying vec3 vTint; varying float vLife;
    mat3 turn(float a, float b) {
      float c = cos(a), s = sin(a), d = cos(b), t = sin(b);
      return mat3(c, s*t, -s*d, 0.0, d, t, s, -c*t, c*d);
    }
    void main() {
      float age = (uReveal - aDelay) / 0.28;
      float life = clamp(age, 0.0, 1.0);
      float alive = step(0.0, age) * (1.0 - step(1.0, age));
      vLife = (1.0 - life) * alive;
      vTint = aTint;
      vec3 origin = aOrigin + aVelocity * life * life;
      origin.xy += vec2(sin(life * 5.0 + aShape.z), cos(life * 4.0 + aShape.y)) * sin(life * 3.14159) * aShape.x * 0.7;
      origin.y -= life * life * aShape.x * 1.2;
  `
  const prism = new THREE.CylinderGeometry(0.6, 0.6, 0.13, 3, 1)
  prism.rotateX(Math.PI / 2)
  const shardGeometry = new THREE.InstancedBufferGeometry()
  shardGeometry.index = prism.index
  shardGeometry.attributes = { ...prism.attributes }
  shardGeometry.instanceCount = setAttributes(shardGeometry)
  const shardMaterial = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: motion + `
      mat3 rotation = turn(aShape.y + life * 5.0, aShape.z + life * 4.0);
      vec3 shard = rotation * position * aShape.x * pow(1.0 - life, 0.6) * alive;
      vTint *= 0.6 + 0.6 * abs((rotation * normal).z);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(origin + shard, 1.0);
    }`,
    fragmentShader: `varying vec3 vTint; varying float vLife; void main() {
      gl_FragColor = vec4(vTint * 1.8, vLife * 0.9);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  })
  const shards = new THREE.Mesh(shardGeometry, shardMaterial)
  shards.frustumCulled = false; shards.renderOrder = 30
  const sparkGeometry = new THREE.BufferGeometry()
  const sparksCount = setAttributes(sparkGeometry, true)
  sparkGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(sparksCount * 3), 3))
  const sparkMaterial = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: motion + `
      vec4 mv = modelViewMatrix * vec4(origin, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = clamp(aShape.x * 1500.0 * ${pixelRatio.toFixed(1)} / max(1.0, -mv.z), 1.0, 18.0) * alive;
    }`,
    fragmentShader: `varying vec3 vTint; varying float vLife; void main() {
      vec2 p = gl_PointCoord - 0.5; float r = length(p);
      float glow = exp(-r*r*20.0); float core = exp(-r*r*150.0);
      gl_FragColor = vec4(vTint * glow + vec3(core), glow * vLife * 0.8);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  })
  const sparks = new THREE.Points(sparkGeometry, sparkMaterial)
  sparks.frustumCulled = false; sparks.renderOrder = 32
  const trailBase = new THREE.PlaneGeometry(1, 1)
  const trailGeometry = new THREE.InstancedBufferGeometry()
  trailGeometry.index = trailBase.index; trailGeometry.attributes = { ...trailBase.attributes }
  trailGeometry.instanceCount = setAttributes(trailGeometry)
  const trailMaterial = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vUv;\n' + motion + `
      vUv = uv;
      vec3 tangent = normalize(aVelocity);
      vec3 across = normalize(cross(tangent, vec3(0.0, 0.0, 1.0)));
      vec3 trail = across * position.x * 0.55 + tangent * (position.y - 0.5) * aShape.x * life * 2.0;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(origin + trail * alive, 1.0);
    }`,
    fragmentShader: `varying vec2 vUv; varying vec3 vTint; varying float vLife; void main() {
      float alpha = pow(vUv.y, 2.0) * (1.0 - abs(vUv.x - 0.5)*2.0) * vLife * 0.45;
      gl_FragColor = vec4(vTint * 1.5, alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  })
  const trails = new THREE.Mesh(trailGeometry, trailMaterial)
  trails.frustumCulled = false; trails.renderOrder = 31
  if (!reducedMotion) effects.add(shards, trails, sparks)
  let started = 0, finished = false
  const duration = reducedMotion ? 180 : 2450
  return {
    duration, uniforms, particleCount: seeds.length,
    start(now = performance.now()) { started = now },
    refreshClip() { patch(current, 1) },
    step(now: number) {
      if (finished) return
      const t = Math.max(0, Math.min(1, (now - started) / duration))
      const sweep = Math.min(1, t / 0.77)
      const eased = sweep * sweep * (3 - 2 * sweep)
      uniforms.uReveal.value = -0.04 + 1.08 * eased + Math.max(0, (t - 0.77) / 0.23) * 0.3
      uniforms.uTime.value = t
      spectrum(Math.min(1, eased), uniforms.uTint.value)
      if (t >= 1) this.finish()
    },
    finish() {
      if (finished) return
      finished = true
      for (const [mesh, original] of saved) mesh.material = original
      hiddenSprites.forEach(object => { object.visible = true })
      temporary.forEach(material => material.dispose())
      scene.remove(effects)
      // Dispose buffers/materials even for reduced-motion playback.
      for (const g of [shardGeometry, sparkGeometry, trailGeometry]) g.dispose()
      for (const m of [shardMaterial, sparkMaterial, trailMaterial]) m.dispose()
      onFinish()
    },
  }
}
