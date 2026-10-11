import {lazy,Suspense,useEffect,useState} from 'react'
import type {SiteRoute} from './components/site/SiteApp'
const designerOnly=import.meta.env.VITE_DESIGNER_ONLY==='1'||import.meta.env.VITE_SNAPBOARD_EDITION==='diy'
const publicOnly=import.meta.env.VITE_PUBLIC_SITE_ONLY==='1'
const Designer=publicOnly?null:lazy(()=>import('./components/designer/DesignerApp'))
const Site=designerOnly?null:lazy(()=>import('./components/site/SiteApp').then(m=>({default:m.SiteApp})))
const base=(import.meta.env.BASE_URL||'/').replace(/\/+$/,'')
const readRoute=():SiteRoute=>{const p=window.location.pathname.replace(base,'').replace(/\/+$/,'')||'/';return ['/community','/guide','/print','/project','/design'].includes(p)?p as SiteRoute:'/'}
export default function App(){
 const[route,setRoute]=useState(readRoute)
 useEffect(()=>{const f=()=>setRoute(readRoute());window.addEventListener('popstate',f);return()=>window.removeEventListener('popstate',f)},[])
 const navigate=(next:SiteRoute)=>{history.pushState({},'',base+(next==='/'?'/':next));setRoute(next)}
 return <Suspense fallback={<div className="designer-loading">正在打开 SnapBoard…</div>}>{Designer&&(designerOnly||route==='/design')?<Designer websiteUrl="https://snapboard.cn/"/>:Site?<Site route={route} navigate={navigate}/>:null}</Suspense>
}
