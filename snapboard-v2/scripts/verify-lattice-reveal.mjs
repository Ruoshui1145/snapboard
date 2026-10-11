import assert from 'node:assert/strict'
import * as THREE from 'three'
import { createServer } from 'vite'
const vite = await createServer({ appType:'custom', logLevel:'error', server:{middlewareMode:true,hmr:false} })
try {
  const {createLatticeReveal} = await vite.ssrLoadModule('/src/utils/latticeReveal.ts')
  const scene=new THREE.Scene(), previous=new THREE.Group(), current=new THREE.Group()
  const original=new THREE.MeshStandardMaterial({color:0x77c9b6}), geometry=new THREE.BoxGeometry(200,200,5)
  previous.add(new THREE.Mesh(geometry, original));current.add(new THREE.Mesh(geometry, original))
  current.position.set(-200,0,0);previous.position.copy(current.position)
  scene.add(previous,current)
  const panels=[{x:0,y:0,w:200,h:200},{x:200,y:0,w:200,h:200}]
  let completed=0
  const run = (reducedMotion=false) => createLatticeReveal({scene,previous,current,panels,thickness:5,reducedMotion,onFinish:()=>completed++})
  const effect=run();effect.start(0)
  const effectGroup=scene.getObjectByName('lattice-shatter')
  assert.equal(effectGroup.children.length,3)
  assert.ok(effect.particleCount>100 && effect.particleCount<=900)
  const buffers=effectGroup.children.map(o=>o.geometry)
  const shader={uniforms:{},vertexShader:'#include <project_vertex>',fragmentShader:'#include <opaque_fragment>'}
  current.children[0].material.onBeforeCompile(shader,{})
  assert.ok(shader.vertexShader.includes('vRevealWorld'))
  assert.ok(shader.fragmentShader.includes('discard'))
  let last=-Infinity
  for(let i=0;i<120;i++){
    effect.step(i*effect.duration/120)
    assert.ok(effect.uniforms.uReveal.value>=last)
    last=effect.uniforms.uReveal.value
    assert.deepEqual(effectGroup.children.map(o=>o.geometry),buffers,'no new geometry during playback')
  }
  assert.equal(completed,0)
  effect.step(effect.duration)
  effect.finish()
  assert.equal(completed,1,'finish is idempotent')
  assert.equal(scene.getObjectByName('lattice-shatter'),undefined)
  assert.equal(current.children[0].material,original,'restore original material/color/map')
  assert.equal(previous.children[0].material,original)
  const replay=run(true);replay.start(0);replay.step(replay.duration)
  assert.equal(completed,2)
  const changed=run()
  const texture=new THREE.Texture(), replacement=new THREE.MeshStandardMaterial({map:texture})
  current.children[0].material=replacement
  changed.refreshClip()
  assert.notEqual(current.children[0].material,replacement,'replacement maps keep the reveal shader')
  const replacementShader={uniforms:{},vertexShader:'#include <project_vertex>',fragmentShader:'#include <opaque_fragment>'}
  current.children[0].material.onBeforeCompile(replacementShader,{})
  assert.ok(replacementShader.fragmentShader.includes('discard'))
  changed.finish()
  assert.equal(current.children[0].material,replacement,'finish retains the latest mapped material')
  assert.equal(current.children[0].material.map,texture)
  const many=Array.from({length:100},(_,i)=>({x:i*200,y:0,w:200,h:200}))
  const capped=createLatticeReveal({scene,previous,current,panels:many,thickness:5,onFinish:()=>{}})
  assert.ok(capped.particleCount<=900)
  capped.finish()
  geometry.dispose();original.dispose();replacement.dispose();texture.dispose()
  console.log('Lattice reveal passed: bounded GPU particles, monotonic diagonal sweep, material restore, cancellation, replay and reduced motion.')
} finally {await vite.close()}
