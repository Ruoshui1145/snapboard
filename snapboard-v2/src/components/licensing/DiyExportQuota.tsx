import {useEffect,useRef,useState} from 'react'
import {readCommercialLicense,useCommercialLicense} from './commercialLicense'
import './diy-export-quota.css'
export const DIY_QUOTA_NOTICE='个人玩家版每天可完成 10 次制造导出，按北京时间零点更新。保存工程、编辑和预览不扣次数。'
export function DiyExportQuota(){const status=useCommercialLicense(),q=status?.quota;const[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');const dialog=useRef<HTMLDialogElement>(null)
 const refresh=async(force=false)=>{setBusy(true);setError('');try{await readCommercialLicense(force)}catch(e){setError(e instanceof Error?e.message:'导出额度读取失败')}finally{setBusy(false)}}
 useEffect(()=>{const focus=()=>{void refresh()},show=()=>setOpen(true);void refresh();window.addEventListener('focus',focus);window.addEventListener('snapboard:open-export-quota',show);return()=>{window.removeEventListener('focus',focus);window.removeEventListener('snapboard:open-export-quota',show)}},[])
 useEffect(()=>{if(open&&!dialog.current?.open)dialog.current?.showModal()},[open])
 return <div className="diy-export-quota"><button type="button" onClick={()=>setOpen(true)} title="查看每日导出次数"><span>个人玩家版</span> <b>{q?`${q.remaining??0}/10`:'检查中'}</b></button>{open&&<dialog ref={dialog} className="diy-quota-dialog" aria-label="导出额度" onCancel={e=>{e.preventDefault();setOpen(false)}} onKeyDown={e=>e.stopPropagation()}><header><h2>每日导出额度</h2><button type="button" aria-label="关闭" onClick={()=>setOpen(false)}>×</button></header><p>{DIY_QUOTA_NOTICE}</p><p>一次完整导出算一次；同一任务中的分板、分盘文件合计一次。取消或未完成保存会释放预留次数。</p><p>首次使用及每日取得新额度需要联网。服务只接收设备签名和导出凭据，不上传图纸、图片或制造文件。</p><p role="status">{error||status?.message||'正在读取导出额度…'}</p><footer><button type="button" disabled={busy} onClick={()=>void refresh(true)}>{busy?'正在刷新…':'刷新额度'}</button></footer></dialog>}</div>
}
