/** 配件大类目录名的唯一分类词表。Vite API 与资源同步脚本共同使用。 */
export function categoryFromDirName(name) {
  const text = String(name ?? '').toLowerCase()
  if (/挂/.test(text)) return 'hook'
  if (/搁板|层板|置物/.test(text)) return 'shelf'
  if (/支架|托架|角铁|横杆/.test(text)) return 'bracket'
  if (/收纳|容器|盒|杯|桶|篮|托盘/.test(text)) return 'bin'
  // “线缆整理类”同时含“整理”，必须优先于通用整理词。
  if (/线缆|电线|走线|理线/.test(text)) return 'cable'
  if (/整理|钥匙|纸巾|瓶罐/.test(text)) return 'organizer'
  if (/紧固|锁扣|卡扣|螺丝|橡胶/.test(text)) return 'fastener'
  if (/底座|安装|墙面|连接/.test(text)) return 'base'
  return 'custom'
}

export const CATEGORY_DIRECTORY_NAMES = [
  '01-挂钩类', '02-支架托架类', '03-搁板层板类', '04-收纳容器类',
  '05-整理件类', '06-紧固锁扣类', '07-底座安装类', '08-线缆整理类',
]
