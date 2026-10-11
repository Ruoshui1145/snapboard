import assert from 'node:assert/strict'
import {createServer} from 'vite'
const server=await createServer({appType:'custom',server:{middlewareMode:true}})
try {
 const {currentWorkspace,isWorkspaceAvailable,workspaceSelection}=await server.ssrLoadModule('/src/utils/workbenchNavigation.ts')
 const {useAppStore}=await server.ssrLoadModule('/src/store/useAppStore.ts')
 const states=['board','appearance','parts','structure','inspect']
 const project=Object.freeze({id:'unchanged'}),panels=Object.freeze([{id:'P01'}])
 for(const from of states)for(const to of states){
  const state={project,splitResult:panels,ui:workspaceSelection(from)}
  const patch=workspaceSelection(to)
  assert.equal(Object.values(patch).filter(v=>v===true).length,1,'only one task workspace is open')
  assert.deepEqual(Object.keys(patch).sort(),['activeTool','occlusionAnalysisOpen','partsOpen','splitOptionsOpen','structureOpen','textureStudioOpen'].sort(),'navigation cannot overwrite project/view data')
  assert.equal(currentWorkspace({...state.ui,...patch}),to)
  assert.equal(state.project,project);assert.equal(state.splitResult,panels)
 }
 for(const workspace of states){
  assert.equal(isWorkspaceAvailable(workspace,false),true)
  assert.equal(isWorkspaceAvailable(workspace,true),workspace==='board'||workspace==='inspect')
  assert.equal(currentWorkspace(workspaceSelection(workspace),true),workspace==='inspect'?'inspect':'board')
 }
 const store=useAppStore.getState()
 store.setBoardTexture({enabled:true,imageDataUrl:'retained-planar-artwork'})
 store.setUI(workspaceSelection('appearance'))
 const retained=useAppStore.getState()
 retained.setSpatialLayout({enabled:true})
 assert.equal(currentWorkspace(useAppStore.getState().ui),'board','进入立体时退出未支持的流程')
 assert.equal(useAppStore.getState().ui.viewMode,'3d')
 for(const workspace of ['appearance','parts','structure']){
  useAppStore.getState().setUI(workspaceSelection(workspace))
  assert.equal(currentWorkspace(useAppStore.getState().ui),'board','旧入口或快捷操作不能绕过立体流程限制')
 }
 useAppStore.getState().setUI(workspaceSelection('inspect'))
 useAppStore.getState().setUI({textureStudioOpen:true,viewMode:'2d'})
 assert.equal(currentWorkspace(useAppStore.getState().ui),'inspect')
 assert.equal(useAppStore.getState().ui.textureStudioOpen,false)
 assert.equal(useAppStore.getState().ui.viewMode,'3d')
 useAppStore.getState().undo()
 assert.equal(useAppStore.getState().spatialLayout.enabled,false)
 useAppStore.getState().setUI(workspaceSelection('appearance'))
 assert.equal(currentWorkspace(useAppStore.getState().ui),'appearance','回到平面后恢复完整流程')
 useAppStore.getState().redo()
 assert.equal(currentWorkspace(useAppStore.getState().ui),'board','重做进入立体同样限制流程')
 const after=useAppStore.getState()
 assert.equal(after.project,retained.project);assert.equal(after.splitResult,retained.splitResult)
 assert.equal(after.placedParts,retained.placedParts);assert.equal(after.boardTexture,retained.boardTexture,'模式切换只影响 UI，不删除平面图片或材料配置')
 console.log('Workbench navigation: planar workflows, spatial restrictions, undo/redo and retained project data passed')
}finally{await server.close()}
