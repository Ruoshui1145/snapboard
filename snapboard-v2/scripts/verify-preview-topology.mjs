import assert from 'node:assert/strict'
import * as THREE from 'three'
import {toCreasedNormals} from 'three/addons/utils/BufferGeometryUtils.js'
import {createServer} from 'vite'
const server=await createServer({configFile:false,appType:'custom',server:{middlewareMode:true,hmr:false},logLevel:'error'})
try {
 const [topology,extrusion,side,defaults,native]=await Promise.all(['previewMeshTopology','textureRegionExtrusion','sideLogo','pegboardSplit','spatialSolid'].map(name=>server.ssrLoadModule('/src/utils/'+name+'.ts')))
 const wasm=await native.spatialManifold(),cfg={...defaults.PEGBOARD_DEFAULT_CONFIG,thickness:5}
 const data=extrusion.extrudeTexturePartition([{outer:[[0,0],[80,0],[80,80],[40,80],[40,79.99997],[39.99997,79.99997],[39.99997,80],[0,80]],holes:[]}],0,5)
 const original=new wasm.Mesh({numProp:3,vertProperties:Float32Array.from(data.vertices),triVerts:Uint32Array.from(data.triangles),tolerance:1e-5})
 const valid=new wasm.Manifold(original),originalVolume=valid.volume();valid.delete()
 const panel={id:'precise-shell',x:10000,y:10000,w:80,h:80,contour:[{x:10000,y:10000},{x:10080,y:10000},{x:10080,y:10080},{x:10000,y:10080}],roundIdx:[],slots:[],round_holes:[],edge_holes:[]}
 const globalData={vertices:data.vertices.map((v,i)=>v+(i%3===0?panel.x:i%3===1?panel.y:0)),triangles:data.triangles}
 const source=new THREE.BufferGeometry();source.setAttribute('position',new THREE.Float32BufferAttribute(globalData.vertices,3));source.setIndex(globalData.triangles)
 const geometry=toCreasedNormals(source,Math.PI/6);source.dispose();topology.rememberPreviewMeshTopology(geometry,globalData)
 assert.ok(globalData.vertices.some((v,i)=>Math.abs(Math.fround(v)-v)>1e-5),'Fixture has distinct coordinates lost in the display Float32 roundtrip')
 const object=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial()),root=new THREE.Group();root.add(object)
 assert.equal(await side.engraveSideLogoPreview(root,panel,cfg,'SB',.24,3.5,false),true)
 assert.equal(await side.engraveSideLogoPreview(root,panel,cfg,'P1',.24,3.5,false),true,'A second engraving keeps the replacement topology too')
 const result=topology.previewMeshTopology(object.geometry);assert.ok(result)
 const mesh=new wasm.Mesh({numProp:3,vertProperties:Float32Array.from(result.vertices,(v,i)=>v-(i%3===0?panel.x:i%3===1?panel.y:0)),triVerts:Uint32Array.from(result.triangles),tolerance:1e-5})
 const final=new wasm.Manifold(mesh)
 assert.equal(final.status(),'NoError');assert.ok(final.volume()<originalVolume-.1)
 final.delete();object.geometry.dispose();object.material.dispose()
 console.log('PASS preview topology: precise indexed shells survive lossy global shading and repeated engraving; native topology remains closed and genuine subtractive volume confirmed')
}finally{await server.close()}
