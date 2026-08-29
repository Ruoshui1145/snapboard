import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import './site.css'

const DESIGNER_URL = (import.meta.env.VITE_DESIGNER_URL as string | undefined)?.trim() || '/design'

export type SiteRoute = '/' | '/community' | '/guide' | '/print' | '/project' | '/design'

interface SiteAppProps {
  route: SiteRoute
  navigate: (route: SiteRoute) => void
}

type IconName = 'arrow' | 'check' | 'chevron' | 'clock' | 'community' | 'copy' | 'cube' | 'download' | 'heart' | 'home' | 'layers' | 'map' | 'menu' | 'printer' | 'search' | 'shield' | 'spark' | 'star' | 'user' | 'verified' | 'x'

const Icon = ({ name, size = 18 }: { name: IconName; size?: number }) => {
  const paths: Record<IconName, ReactNode> = {
    arrow: <><path d="M5 12h14"/><path d="m14 7 5 5-5 5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    community: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    cube: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"/><path d="m4.5 7.8 7.5 4.3 7.5-4.3M12 12v9"/></>,
    download: <><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></>,
    heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>,
    home: <><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></>,
    layers: <><path d="m12 2 9 5-9 5-9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/></>,
    map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15M15 6v15"/></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
    printer: <><path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></>,
    spark: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/></>,
    star: <path d="m12 2 3 6 6.5 1-4.7 4.6 1.1 6.4-5.9-3.1L6.1 20l1.1-6.4L2.5 9 9 8Z"/>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
    verified: <><path d="m12 2 2.2 2.1 3-.4.5 3 2.7 1.4-1.4 2.7.4 3-3 .5-2.1 2.2-2.2-2.2-3-.5.4-3-1.4-2.7 2.7-1.4.5-3 3 .4Z"/><path d="m9 12 2 2 4-4"/></>,
    x: <><path d="M6 6l12 12M18 6 6 18"/></>,
  }
  return <svg className="site-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function DesignerLink({ className, children }: { className: string; children: ReactNode }) {
  return <a className={className} href={DESIGNER_URL} target="_blank" rel="noreferrer">{children}</a>
}

const openDesigner = () => {
  window.open(DESIGNER_URL, '_blank', 'noopener,noreferrer')
}

interface TemplateCardData {
  id: number
  title: string
  school: string
  building: string
  bed: string
  scene: string
  verified: '已试装' | '已复核' | '高可信'
  copies: number
  likes: number
  panels: number
  bedSize: string
  author: string
  accent: string
  shape: 'arch' | 'step' | 'wide' | 'corner' | 'compact' | 'dual'
}

const templates: TemplateCardData[] = [
  { id: 1, title: '上床下桌 · 全功能学习墙', school: '江城大学', building: '松园 3 号楼', bed: '右侧床位', scene: '学习效率', verified: '高可信', copies: 286, likes: 94, panels: 6, bedSize: '220 × 180 cm', author: '林同学', accent: '#ff6b4a', shape: 'step' },
  { id: 2, title: '桌角避让 · 电竞收纳布局', school: '华南理工学院', building: '西区 7 栋', bed: '左侧床位', scene: '电竞桌面', verified: '已试装', copies: 174, likes: 67, panels: 5, bedSize: '200 × 165 cm', author: '阿哲', accent: '#7357e8', shape: 'corner' },
  { id: 3, title: '护肤与首饰轻收纳方案', school: '滨海师范大学', building: '海棠 2 栋', bed: '靠窗床位', scene: '生活收纳', verified: '已试装', copies: 139, likes: 82, panels: 4, bedSize: '180 × 160 cm', author: '小麦', accent: '#e95b91', shape: 'arch' },
  { id: 4, title: '双人共享桌面工具墙', school: '北岭科技大学', building: '知行 5 栋', bed: '双人连桌', scene: '创客工具', verified: '已复核', copies: 88, likes: 41, panels: 8, bedSize: '360 × 150 cm', author: 'Maker Liu', accent: '#159f7b', shape: 'dual' },
  { id: 5, title: '小桌面最小占用收纳板', school: '江城大学', building: '桂园 1 号楼', bed: '标准床位', scene: '小空间', verified: '已试装', copies: 211, likes: 76, panels: 3, bedSize: '140 × 120 cm', author: '严同学', accent: '#e58e27', shape: 'compact' },
  { id: 6, title: '摄影与数码配件展示墙', school: '东湖大学', building: '梅园 8 栋', bed: '独立书桌', scene: '数码装备', verified: '高可信', copies: 321, likes: 118, panels: 7, bedSize: '240 × 170 cm', author: 'Roll 36', accent: '#2878d2', shape: 'wide' },
]

const navItems: { label: string; route: SiteRoute }[] = [
  { label: '首页', route: '/' },
  { label: '校园方案', route: '/community' },
  { label: '使用指南', route: '/guide' },
  { label: '项目资料', route: '/project' },
  { label: '打印服务', route: '/print' },
]

const routeMeta: Record<Exclude<SiteRoute, '/design'>, { title: string; description: string }> = {
  '/': { title: 'SnapBoard — 宿舍异形洞洞板设计与打印', description: '围绕床架、侧柜与插座设计 L 型、阶梯型和凹口型洞洞板，并自动分割为可打印板件。' },
  '/community': { title: '校园方案库 — SnapBoard', description: '按学校、宿舍楼和床位类型发现经过真实试装验证的洞洞板方案。' },
  '/guide': { title: '使用指南 — SnapBoard', description: '从测量、复制母版、自动分割到打印安装的完整指南。' },
  '/project': { title: '项目资料与开源 — SnapBoard', description: '在一个入口了解 SnapBoard 的产品、公开文档、开发日志与第一版开源仓库。' },
  '/print': { title: '打印服务 — SnapBoard', description: '选择校园打印服务、查看报价流程并申请成为合作打印农场。' },
}

export function SiteApp({ route, navigate }: SiteAppProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const page = route === '/design' ? '/' : route
    document.title = routeMeta[page].title
    document.querySelector('meta[name="description"]')?.setAttribute('content', routeMeta[page].description)
    document.querySelector('.site-main')?.scrollTo({ top: 0 })
    setMenuOpen(false)
  }, [route])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3200)
    return () => window.clearTimeout(timer)
  }, [notice])

  const go = (next: SiteRoute) => {
    navigate(next)
    setMenuOpen(false)
  }

  const page = route === '/community'
    ? <CommunityPage navigate={go} notify={setNotice} />
    : route === '/guide'
      ? <GuidePage navigate={go} />
      : route === '/project'
        ? <ProjectPage navigate={go} />
      : route === '/print'
        ? <PrintPage navigate={go} notify={setNotice} />
        : <HomePage navigate={go} notify={setNotice} />

  return (
    <div className="site-app">
      <header className="site-header">
        <div className="site-header-inner">
          <button className="site-brand" type="button" onClick={() => go('/')} aria-label="SnapBoard 首页">
            <Logo />
            <span className="site-brand-copy"><b>SnapBoard</b><small>校园空间共创计划</small></span>
          </button>
          <nav className={menuOpen ? 'site-nav open' : 'site-nav'} aria-label="主导航">
            {navItems.map(item => (
              <button key={item.route} type="button" className={route === item.route ? 'active' : ''} onClick={() => go(item.route)}>{item.label}</button>
            ))}
            <DesignerLink className="site-nav-mobile-design">打开设计器</DesignerLink>
          </nav>
          <div className="site-header-actions">
            <a className="site-github-link" href="https://github.com/Ruoshui1145/snapboard" target="_blank" rel="noreferrer">GitHub</a>
            <button className="site-login" type="button" onClick={() => setNotice('账号系统将在社区数据接入后开放')}>登录</button>
            <DesignerLink className="site-primary compact">开始设计 <Icon name="arrow" size={16} /></DesignerLink>
            <button className="site-menu" type="button" onClick={() => setMenuOpen(value => !value)} aria-label="打开导航" aria-expanded={menuOpen}>
              <Icon name={menuOpen ? 'x' : 'menu'} size={22} />
            </button>
          </div>
        </div>
      </header>
      <main className="site-main">{page}<SiteFooter navigate={go} /></main>
      {notice && <div className="site-toast" role="status"><Icon name="check" size={17} />{notice}</div>}
    </div>
  )
}

function HomePage({ navigate, notify }: { navigate: (route: SiteRoute) => void; notify: (message: string) => void }) {
  return (
    <>
      <section className="hero-section site-section">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-dot" /> 为中国大学宿舍而设计</div>
          <h1>把宿舍墙面，<br />变成<span>你的空间。</span></h1>
          <p className="hero-lead">找到同楼同床型的实测方案，围绕侧柜、床架和插座画出 L 型、阶梯型或带凹口的板面。没有打印机，也能让附近的打印伙伴帮你完成。</p>
          <div className="hero-actions">
            <button className="site-primary large" type="button" onClick={() => navigate('/community')}>寻找我的宿舍方案 <Icon name="arrow" /></button>
            <DesignerLink className="site-secondary large"><Icon name="cube" /> 从零开始设计</DesignerLink>
          </div>
          <div className="hero-proof">
            <div className="avatar-stack"><span>林</span><span>乔</span><span>周</span><span>+8</span></div>
            <div><div className="proof-stars">★★★★★</div><p>首批校园体验官共同验证</p></div>
          </div>
        </div>
        <HeroWorkbench />
      </section>

      <section className="campus-search-wrap">
        <div className="campus-search-card">
          <div className="search-intro"><span className="search-icon-box"><Icon name="map" size={23} /></span><div><b>从你的学校开始</b><small>一个可靠母版，可以被整栋楼反复使用</small></div></div>
          <div className="campus-search-fields">
            <button type="button" onClick={() => navigate('/community')}><span><small>学校 / 校区</small><b>搜索学校名称</b></span><Icon name="chevron" size={16} /></button>
            <button type="button" onClick={() => navigate('/community')}><span><small>宿舍楼</small><b>选择楼栋与床型</b></span><Icon name="chevron" size={16} /></button>
            <button className="search-submit" type="button" onClick={() => navigate('/community')}><Icon name="search" /> 查找方案</button>
          </div>
        </div>
      </section>

      <IrregularShowcase navigate={navigate} />

      <section className="site-section featured-section">
        <SectionHeading eyebrow="本周精选" title="真实宿舍里，正在被使用的方案" description="每个“已试装”标记背后，都有一次真实打印与安装反馈。先复制可靠母版，再做属于自己的版本。" action="浏览全部方案" onAction={() => navigate('/community')} />
        <div className="template-grid home-grid">
          {templates.slice(0, 3).map(item => <TemplateCard key={item.id} item={item} onCopy={openDesigner} onLike={() => notify('已收藏到你的灵感清单')} />)}
        </div>
      </section>

      <section className="site-section process-section">
        <div className="process-heading"><span>从一面空墙到装好 · 正确操作顺序</span><h2>先画板，再分割，最后放配件。</h2></div>
        <div className="process-grid">
          <ProcessStep number="01" icon="map" title="测量或复制母版" text="先确认净空尺寸；同楼同方向已有可靠母版时，核对后复制为个人副本。" />
          <ProcessStep number="02" icon="layers" title="先画板子轮廓" text="只画闭合外轮廓、避让内孔和精确尺寸，此时不放挂钩、托盘等配件。" />
          <ProcessStep number="03" icon="cube" title="分割后放配件" text="按热床自动分板并检查接缝，再切到 3D 视图布置配件。" />
          <ProcessStep number="04" icon="printer" title="导出并打印" text="核对板件编号与装配方向，导出 3MF 自己打印或提交代打。" />
        </div>
      </section>

      <section className="site-section reuse-section">
        <div className="reuse-visual"><DormStack /></div>
        <div className="reuse-copy">
          <div className="eyebrow dark"><span className="eyebrow-dot" /> 社区不是聊天广场</div>
          <h2>一个人认真测量，<br /><span>一整栋楼都能复用。</span></h2>
          <p>SnapBoard 把尺寸母版和个人布局分开。公共母版只保存床架、插座和可用墙面；你复制后，个人配件和风格完全属于自己。</p>
          <ul>
            <li><span><Icon name="verified" /></span><div><b>四级可信标记</b><small>草稿、已复核、已试装、高可信，不把未经验证的尺寸当答案。</small></div></li>
            <li><span><Icon name="copy" /></span><div><b>复制，不覆盖</b><small>每个人都从母版创建独立副本，公共尺寸不会被随意改坏。</small></div></li>
            <li><span><Icon name="heart" /></span><div><b>贡献会得到回报</b><small>首测、复核和实物反馈都可获得打印优惠或社区积分。</small></div></li>
          </ul>
          <button className="text-link" type="button" onClick={() => navigate('/community')}>看看社区如何运作 <Icon name="arrow" size={17} /></button>
        </div>
      </section>

      <section className="site-section print-cta-section">
        <div className="print-cta-card">
          <div className="print-cta-copy"><div className="eyebrow light"><span className="eyebrow-dot" /> 没有 3D 打印机也没关系</div><h2>设计交给你，<br />打印交给附近的伙伴。</h2><p>提交方案后选择材料和颜色，打印伙伴人工复核再报价。同校拼单还可以减少包装和配送费用。</p><div className="hero-actions"><button className="site-primary light-btn" type="button" onClick={() => navigate('/print')}>了解打印服务 <Icon name="arrow" /></button><button className="site-secondary dark-btn" type="button" onClick={() => notify('合作申请入口已为打印农场预留')}>成为打印伙伴</button></div></div>
          <PrintQueue />
        </div>
      </section>
    </>
  )
}

function CommunityPage({ navigate, notify }: { navigate: (route: SiteRoute) => void; notify: (message: string) => void }) {
  const [query, setQuery] = useState('')
  const [scene, setScene] = useState('全部')
  const [school, setSchool] = useState('全部学校')
  const scenes = ['全部', '学习效率', '电竞桌面', '生活收纳', '创客工具', '小空间', '数码装备']
  const schools = ['全部学校', ...Array.from(new Set(templates.map(item => item.school)))]
  const shown = useMemo(() => templates.filter(item => {
    const matchesScene = scene === '全部' || item.scene === scene
    const matchesSchool = school === '全部学校' || item.school === school
    const haystack = `${item.title}${item.school}${item.building}${item.bed}${item.scene}`.toLowerCase()
    return matchesScene && matchesSchool && haystack.includes(query.trim().toLowerCase())
  }), [query, scene, school])

  return (
    <>
      <section className="subpage-hero community-hero">
        <div className="subpage-hero-copy"><div className="eyebrow"><span className="eyebrow-dot" /> 校园方案库</div><h1>先找同款宿舍，<br /><span>再做你的版本。</span></h1><p>只展示清楚标注来源和验证状态的方案。复制是起点，实物反馈会让下一个人的设计更可靠。</p></div>
        <div className="community-stat-card"><div><b>6</b><span>首批床型母版</span></div><div><b>1,219</b><span>方案复用</span></div><div><b>4</b><span>已覆盖学校</span></div></div>
      </section>
      <section className="site-section community-browser">
        <div className="community-toolbar">
          <label className="community-search"><Icon name="search" size={19} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索学校、楼栋或方案" /></label>
          <select value={school} onChange={event => setSchool(event.target.value)} aria-label="筛选学校">{schools.map(item => <option key={item}>{item}</option>)}</select>
          <button className="site-secondary publish-btn" type="button" onClick={() => notify('方案发布功能将在账号系统接入后开放')}><Icon name="spark" /> 发布我的方案</button>
        </div>
        <div className="filter-tabs">{scenes.map(item => <button key={item} className={scene === item ? 'active' : ''} type="button" onClick={() => setScene(item)}>{item}</button>)}</div>
        <div className="results-heading"><div><h2>{scene === '全部' ? '全部校园方案' : scene}</h2><p>找到 {shown.length} 个可复制方案</p></div><span className="results-note"><Icon name="shield" size={17} /> 平台会标记，但不伪造实物验证</span></div>
        {shown.length ? <div className="template-grid community-grid">{shown.map(item => <TemplateCard key={item.id} item={item} onCopy={openDesigner} onLike={() => notify('已收藏到你的灵感清单')} />)}</div> : <div className="empty-state"><Icon name="search" size={30} /><h3>暂时没有匹配方案</h3><p>换一个关键词，或者成为这栋宿舍的第一位测量者。</p><DesignerLink className="site-primary">创建首个方案</DesignerLink></div>}
      </section>
    </>
  )
}

function GuidePage({ navigate }: { navigate: (route: SiteRoute) => void }) {
  const [active, setActive] = useState(0)
  const steps = [
    {
      stage: '现场', title: '测量墙面净空', time: '约 5 分钟',
      text: '测的是板子真正能占用的净空，不是床板、桌板或墙面的外尺寸。把床架、插座、开关、网口和走线区一起画进记录。',
      actions: ['用钢卷尺测可用宽度 W 与高度 H，关键尺寸各测两遍', '测出障碍物相对左下基准点的位置与大小', '拍一张正面环境照，并在纸上写明左右床位方向'],
      done: '已经得到一组带方向、障碍位置和基准点的毫米尺寸。',
      warning: '不要只拍照片估尺寸；透视畸变会让方案在屏幕里正确、安装时却差几厘米。',
      tips: ['统一使用 mm（毫米）记录', '插座四周保留插头与手指操作空间', '照片避开人脸、姓名牌和快递单'],
    },
    {
      stage: '社区', title: '搜索或创建母版', time: '约 3 分钟',
      text: '先按学校、校区、楼栋和床位方向搜索。同一栋楼往往能复用同一个尺寸母版，但个人的配件布局仍应保存在自己的副本中。',
      actions: ['输入学校和宿舍楼，再选择左/右床位或靠窗方向', '优先查看“已试装”或“高可信”方案及最后验证日期', '核对宽、高和一个障碍物位置；一致后再复制为个人副本'],
      done: '你拥有一个尺寸可信、可以独立修改且不会覆盖原作者的个人副本。',
      warning: '同楼不等于同方向。左右床位、改造批次或家具移动都可能让母版失效。',
      tips: ['至少核对两个关键尺寸', '不匹配时新建母版，不要硬改成熟方案', '发布母版时只共享空间尺寸，不共享隐私照片'],
    },
    {
      stage: '2D 草图', title: '先画出板子轮廓', time: '约 6 分钟',
      text: '进入设计器后，先把“板子本身”画正确。此时只处理外边界、避让孔和精确尺寸，不放挂钩、托盘等配件。',
      actions: ['在顶部“轮廓类型”选择“外轮廓”', '用“矩形 R”画规则板；异形区域可用“直线 P”闭合轮廓', '用“智能尺寸 D”输入实测宽高；需要避让时切到“内孔”再绘制', '用“选择 V”点中轮廓，确认左侧属性显示为闭合外轮廓'],
      done: '画布中只有一块尺寸正确的闭合板面，插座等禁区已做成内孔。',
      warning: '正确顺序是先画板、再分割、最后上配件。不要在完整大板阶段提前布置配件。',
      tips: ['外轮廓必须闭合，否则无法自动分割', '尺寸以测量净空为准，不要按屏幕网格目测', '异形拐角尽量保持边界清晰、不过度复杂'],
    },
    {
      stage: '自动分板', title: '按热床自动分割', time: '约 3 分钟',
      text: '轮廓确认后再生成可打印板件。软件会按照热床、模数、边缘预留和孔缝安全距，把整块板拆成带编号的 P1、P2…板件。',
      actions: ['选中刚才完成的闭合外轮廓', '点“自动分割”旁的齿轮，填写实际热床宽、深和板厚', '点击“自动分割”，在右侧检查板件数量、尺寸与警告', '切到 3D 视图检查接缝、孔位、厚度与装配方向'],
      done: '每个 P 编号板件都能放入打印机热床，且分割结果没有未处理警告。',
      warning: '热床参数填大，会生成实际放不进打印机的板件；看到警告不要直接跳过。',
      tips: ['使用热床真实可用尺寸，不只看标称尺寸', '确认接缝没有穿过关键避让孔', '记录板件总数，后续配件布局以本次分割为准'],
    },
    {
      stage: '3D 装配', title: '分割后再放配件', time: '约 8 分钟',
      text: '板件结构稳定后，切到 3D 视图布置挂钩、托盘与收纳盒。这样配件能参考真实接缝和孔位，不会出现跨缝、悬空或挡住拼接孔。',
      actions: ['保持 3D 视图，展开右侧“配件库”', '把配件卡片拖到目标板件的孔位上', '选中配件后调整尺寸、朝向或安装参数', '绕视角检查配件与板件接缝、桌面和墙面是否冲突'],
      done: '所有配件都落在有效孔位上，没有跨接缝、挡拼接孔或超出墙面净空。',
      warning: '配件必须在分割结果确定后放置；否则重新分割可能改变接缝，让原布局失效。',
      tips: ['重物靠近固定点和板件中心', '常用品放在自然伸手范围', '给灯具、电脑和充电器保留散热与走线空间'],
    },
    {
      stage: '输出', title: '检查并导出打印文件', time: '约 3 分钟',
      text: '最后核对 3D 装配，再从顶部“文件”区输出排盘 3MF。程序会归组重复板件与配件，并按当前热床宽高自动建立多盘。',
      actions: ['在 3D 中逐块确认 P 编号、正反面和配件安装方向', '先“保存”项目；如需自选目录则使用“另存为”', '点击“排盘 3MF”，核对状态栏中的板件数、配件数和盘数', '在切片软件中逐盘检查朝向，再先打印校准件或一块代表性板件'],
      done: '已得到可继续编辑的 .snapboard 项目，以及可由 Bambu Studio / OrcaSlicer 打开的多对象 3MF。',
      warning: '只有资源包里配置了制造模型 model.print 的配件才会进入 3MF；缺失项会在导出后明确提示。',
      tips: ['不要混用不同方案版本的板件', '切片软件中再次检查单位为 mm', '失败或尺寸偏差要写明具体板件编号'],
    },
  ]
  const step = steps[active]
  return (
    <>
      <section className="subpage-hero guide-hero"><div className="subpage-hero-copy"><div className="eyebrow"><span className="eyebrow-dot" /> 第一次使用 · 完整流程</div><h1>先画板，再分割，<br /><span>最后放配件。</span></h1><p>从现场测量到导出打印文件，共六步。图中的编号、引线与界面位置都对应现有设计器，不需要先学传统 CAD。</p><div className="guide-sequence"><span>测量</span><i /><span>母版</span><i /><span>画板</span><i /><span>分割</span><i /><span>配件</span><i /><span>导出</span></div><DesignerLink className="site-primary large">边看指南边设计 <Icon name="arrow" /></DesignerLink></div><MeasureIllustration /></section>
      <section className="site-section guide-layout">
        <aside className="guide-steps" aria-label="教程步骤">{steps.map((item, index) => <button type="button" key={item.title} className={active === index ? 'active' : ''} onClick={() => setActive(index)}><span>{String(index + 1).padStart(2, '0')}</span><div><small>{item.stage}</small><b>{item.title}</b><em>{item.time}</em></div><Icon name="chevron" size={17} /></button>)}</aside>
        <article className="guide-detail">
          <div className="guide-title-row"><div><div className="guide-kicker">步骤 {String(active + 1).padStart(2, '0')} / {String(steps.length).padStart(2, '0')} · {step.stage}</div><h2>{step.title}</h2></div><span className="guide-time"><Icon name="clock" size={15} />{step.time}</span></div>
          <p>{step.text}</p>
          {active >= 2 && active <= 4 && <div className="guide-order-lock" aria-label="正确设计顺序"><b>正确顺序</b><span className={active === 2 ? 'current' : 'done'}>① 画板</span><Icon name="arrow" size={15} /><span className={active === 3 ? 'current' : active > 3 ? 'done' : ''}>② 分割</span><Icon name="arrow" size={15} /><span className={active === 4 ? 'current' : ''}>③ 配件</span></div>}
          <div className="guide-demo"><GuideDemo step={active} /></div>
          <div className="guide-instruction-grid">
            <section className="guide-actions"><h3>照着操作</h3><ol>{step.actions.map((action, index) => <li key={action}><span>{index + 1}</span><p>{action}</p></li>)}</ol></section>
            <aside className="guide-finish"><span>完成标志</span><b>{step.done}</b><div><Icon name="shield" size={18} /><p>{step.warning}</p></div></aside>
          </div>
          <h3>提交下一步前检查</h3><ul>{step.tips.map(tip => <li key={tip}><span><Icon name="check" size={15} /></span>{tip}</li>)}</ul>
          <div className="guide-nav"><button type="button" disabled={active === 0} onClick={() => setActive(value => Math.max(0, value - 1))}>上一步</button>{active < steps.length - 1 ? <button className="site-primary" type="button" onClick={() => setActive(value => Math.min(steps.length - 1, value + 1))}>下一步：{steps[active + 1].title} <Icon name="arrow" size={16} /></button> : <DesignerLink className="site-primary">打开设计器 <Icon name="arrow" size={16} /></DesignerLink>}</div>
        </article>
      </section>
    </>
  )
}

const githubRoot = 'https://github.com/Ruoshui1145/snapboard'

const projectResources = [
  {
    eyebrow: '产品',
    title: '在线设计器',
    text: '从二维草图、孔位和自动分割，到 3D 双面装配与多盘 3MF 导出。',
    action: '打开设计器',
    href: DESIGNER_URL,
    icon: 'cube' as IconName,
  },
  {
    eyebrow: '文档',
    title: '公开技术文档',
    text: '查看模块边界、项目文件、制造导出、打印机预设和校园试点说明。',
    action: '在 GitHub 阅读文档',
    href: `${githubRoot}/tree/main/apps/wiki/docs`,
    icon: 'copy' as IconName,
  },
  {
    eyebrow: '社区',
    title: '校园方案库',
    text: '先复用同楼同床型的可靠母版，再创建自己的配件和纹理布局。',
    action: '浏览方案',
    href: '',
    route: '/community' as SiteRoute,
    icon: 'community' as IconName,
  },
]

const publicDevlog = [
  ['2026-08-28', '统一官网、文档与开发日志入口', '把官网、使用指南、公开文档和第一版开源仓库放入同一套产品导航。'],
  ['2026-08-20', '纹理层与彩色版画工作流', '明确基层、彩色叠色层和材质贴面的制造边界，并保留低成本打印路径。'],
  ['2026-08-12', '多板件 3MF 与打印预设', '按热床尺寸生成多盘制造文件，保留板件编号、材料和打印机预设信息。'],
  ['2026-08-02', '配件锚点与双面装配', '为配件记录端面、朝向和正反面吸附关系，减少导入切片后的装配歧义。'],
  ['2026-07-20', '3D 孔位与装配预览', '把 2D 孔位状态同步到 3D 板件，先确认结构，再布置配件。'],
  ['2026-07-06', '自动分板与倒角验证', '围绕异形轮廓、接缝和上下对称倒角建立可打印的验证样板。'],
]

function ProjectPage({ navigate }: { navigate: (route: SiteRoute) => void }) {
  return (
    <>
      <section className="subpage-hero project-hero">
        <div className="subpage-hero-copy">
          <div className="eyebrow"><span className="eyebrow-dot" /> 一个官网 · 一套产品入口</div>
          <h1>了解项目，<br /><span>然后马上开始设计。</span></h1>
          <p>这里集中放产品介绍、使用指南、公开技术资料和开发日志。普通用户从官网了解 SnapBoard，开发者从 GitHub 获取第一版源码，不需要在两个网站之间来回寻找。</p>
          <div className="project-badges"><span>产品官网</span><span>第一版开源</span><span>公开开发记录</span></div>
          <div className="hero-actions"><DesignerLink className="site-primary large">打开独立设计器 <Icon name="arrow" /></DesignerLink><a className="site-secondary large" href={githubRoot} target="_blank" rel="noreferrer"><Icon name="download" /> 获取开源版本</a></div>
        </div>
        <div className="project-overview-card"><div className="project-overview-head"><span className="live-dot" /> SNAPBOARD PUBLIC BUILD</div><div className="project-overview-flow"><span>测量</span><i /><span>画板</span><i /><span>分割</span><i /><span>装配</span><i /><span>导出</span></div><p>一条从真实空间到可打印文件的完整链路</p><div className="project-overview-foot"><span>React + TypeScript</span><span>3MF / Bambu</span><span>MIT / Apache 2.0 兼容发布</span></div></div>
      </section>

      <section className="site-section project-section">
        <div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-dot" /> 从这里开始</div><h2>同一个网站，三种使用方式。</h2><p>官网负责解释和引导；设计器负责实际创作；GitHub 负责公开源码与可复现的工程记录。</p></div></div>
        <div className="project-resource-grid">
          {projectResources.map(resource => resource.href ? (
            <a className="project-resource-card" href={resource.href} target="_blank" rel="noreferrer" key={resource.title}><span className="project-card-icon"><Icon name={resource.icon} size={21} /></span><small>{resource.eyebrow}</small><h3>{resource.title}</h3><p>{resource.text}</p><span className="project-card-action">{resource.action} <Icon name="arrow" size={15} /></span></a>
          ) : (
            <button className="project-resource-card" type="button" onClick={() => navigate(resource.route!)} key={resource.title}><span className="project-card-icon"><Icon name={resource.icon} size={21} /></span><small>{resource.eyebrow}</small><h3>{resource.title}</h3><p>{resource.text}</p><span className="project-card-action">{resource.action} <Icon name="arrow" size={15} /></span></button>
          ))}
        </div>
      </section>

      <section className="site-section project-log-section">
        <div className="project-log-heading"><div><div className="eyebrow"><span className="eyebrow-dot" /> 公开开发日志</div><h2>每一步都能被看见。</h2><p>这里展示面向用户和贡献者的研发节点；更完整的 Markdown 原文和截图保存在仓库中。</p></div><a className="text-link" href={`${githubRoot}/tree/main/apps/wiki/blog`} target="_blank" rel="noreferrer">查看全部日志 <Icon name="arrow" size={17} /></a></div>
        <div className="project-log-list">{publicDevlog.map(([date, title, text]) => <article key={date} className="project-log-item"><time>{date}</time><div><h3>{title}</h3><p>{text}</p></div><Icon name="chevron" size={17} /></article>)}</div>
      </section>

      <section className="site-section project-boundary-section">
        <div className="project-boundary-card"><span className="project-card-icon"><Icon name="shield" size={22} /></span><div><div className="eyebrow">公开边界</div><h2>把软件和证据公开，保留内部运营资料。</h2><p>公开仓库只包含软件本体、必要示例、模块文档和开发日志。商业计划、市场报告、基金预算、个人联系方式和未授权模型仍保留在本地，不会混入官网或 GitHub。</p></div><a className="site-secondary" href={`${githubRoot}#readme`} target="_blank" rel="noreferrer">查看仓库说明 <Icon name="arrow" size={16} /></a></div>
      </section>
    </>
  )
}

function PrintPage({ navigate, notify }: { navigate: (route: SiteRoute) => void; notify: (message: string) => void }) {
  const [submitted, setSubmitted] = useState(false)
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setSubmitted(true); notify('合作意向已记录；正式后台接入后将发送确认') }
  return (
    <>
      <section className="subpage-hero print-hero"><div className="subpage-hero-copy"><div className="eyebrow"><span className="eyebrow-dot" /> 校园打印网络</div><h1>自己设计，<br /><span>附近完成。</span></h1><p>打印伙伴不会只收到一堆匿名 STL，而会收到带编号、参数和项目版本的完整制造包。</p><div className="hero-actions"><DesignerLink className="site-primary large">先完成设计 <Icon name="arrow" /></DesignerLink><button className="site-secondary large" type="button" onClick={() => document.getElementById('partner-form')?.scrollIntoView({ behavior: 'smooth' })}>申请成为伙伴</button></div></div><PrintNetwork /></section>
      <section className="site-section print-flow-section"><SectionHeading eyebrow="服务流程" title="先检查，再报价；不让自动估价替代责任。" description="首版采用系统估算 + 人工复核。材料、颜色、机时和交付时间确认后才付款，避免低价接单后临时加价。" /><div className="print-flow-grid"><ProcessStep number="01" icon="cube" title="提交项目快照" text="锁定当前版本、板件数量与打印参数，后续修改会创建新报价。" /><ProcessStep number="02" icon="clock" title="人工复核报价" text="打印伙伴检查壁厚、方向、材料、机时和失败风险。" /><ProcessStep number="03" icon="printer" title="排产与质检" text="板件逐一编号，记录机器、材料批次与需要补打的原因。" /><ProcessStep number="04" icon="community" title="同校集中交付" text="同校订单可拼单生产，送到校园自提点或单独快递。" /></div></section>
       <section className="site-section partner-section"><div className="partner-heading"><div><div className="eyebrow dark"><span className="eyebrow-dot" /> 合作打印伙伴</div><h2>首批名额预留中</h2><p>正式上线前只展示经过测试单、设备核验和售后规则确认的伙伴。以下卡片是网站展示格式预览，不代表现已签约。</p></div><span className="placeholder-badge">展示占位</span></div><div className="farm-grid"><FarmCard name="东湖校园打印站" area="东湖大学城 · 3 km" machines="8 台 FDM" material="基础色 PETG" time="预计 2–3 天" color="#705be7" /><FarmCard name="江城创客工坊" area="江城高校片区 · 5 km" machines="12 台 FDM" material="PETG / PLA / ABS" time="预计 3–4 天" color="#f06a47" /><FarmCard name="青禾 3D 实验室" area="滨海大学城 · 4 km" machines="6 台 FDM" material="基础色 PETG" time="预计 2–3 天" color="#129d78" /></div><p className="farm-disclaimer"><Icon name="shield" size={16} /> 正式联系方式只在审核并取得合作方公开授权后展示；平台将同时保留投诉和下架入口。</p></section>
       <section className="site-section partner-form-section" id="partner-form"><div className="partner-form-copy"><span className="site-chip">打印农场 / 校园创客社</span><h2>把你的空闲机时，<br />变成附近同学的成品。</h2><p>我们优先寻找愿意接小批量、能保留生产记录，并能对失败件负责的本地伙伴。</p><ul><li><Icon name="check" /> 平台提供统一制造包和板件编号</li><li><Icon name="check" /> 同校订单可以集中排产与交付</li><li><Icon name="check" /> 伙伴自行确认材料、交期和报价</li></ul></div><form className="partner-form" onSubmit={submit}><label><span>团队或工作室名称</span><input required placeholder="例如：江城大学创客社" /></label><label><span>服务学校 / 城市</span><input required placeholder="例如：江城大学、江城大学城" /></label><div className="form-row"><label><span>设备数量</span><input required type="number" min="1" placeholder="4" /></label><label><span>常用材料</span><input required placeholder="基础色 PETG、PLA" /></label></div><label><span>联系方式</span><input required placeholder="手机号 / 微信 / 邮箱" /></label><label><span>补充说明</span><textarea rows={3} placeholder="设备型号、日产能、是否支持校园自提……" /></label><button className="site-primary large" type="submit" disabled={submitted}>{submitted ? '已记录合作意向' : '提交合作意向'} <Icon name={submitted ? 'check' : 'arrow'} /></button><small>当前为前端演示，正式上线后将接入加密提交与隐私说明。</small></form></section>
    </>
  )
}

function SectionHeading({ eyebrow, title, description, action, onAction }: { eyebrow: string; title: string; description: string; action?: string; onAction?: () => void }) {
  return <div className="section-heading"><div><span className="site-chip">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>{action && <button className="text-link" type="button" onClick={onAction}>{action}<Icon name="arrow" size={17} /></button>}</div>
}

function ProcessStep({ number, icon, title, text }: { number: string; icon: IconName; title: string; text: string }) {
  return <article className="process-card"><div className="process-card-top"><span><Icon name={icon} size={22} /></span><small>{number}</small></div><h3>{title}</h3><p>{text}</p></article>
}

function TemplateCard({ item, onCopy, onLike }: { item: TemplateCardData; onCopy: () => void; onLike: () => void }) {
  const shapeLabels: Record<TemplateCardData['shape'], string> = { arch: '圆弧顶', step: 'L 型避让', wide: '超宽异形', corner: '桌角凹口', compact: '紧凑矩形', dual: '双桌连板' }
  return <article className="template-card"><div className="template-visual" style={{ '--template-accent': item.accent } as React.CSSProperties}><BoardPreview shape={item.shape} /><div className={`trust-badge ${item.verified === '高可信' ? 'high' : ''}`}><Icon name="verified" size={14} />{item.verified}</div><button className="like-button" type="button" aria-label="收藏方案" onClick={onLike}><Icon name="heart" size={17} /></button><span className="shape-badge"><Icon name="spark" size={12}/>{shapeLabels[item.shape]}</span><span className="panel-count">{item.panels} 块板</span></div><div className="template-body"><div className="template-location"><span>{item.school}</span><i />{item.building}</div><h3>{item.title}</h3><p><Icon name="map" size={15} /> {item.bed} · {item.bedSize}</p><div className="template-meta"><div className="template-author"><span>{item.author.slice(0, 1)}</span><small>{item.author}</small></div><div className="template-numbers"><span><Icon name="copy" size={14} />{item.copies}</span><span><Icon name="heart" size={14} />{item.likes}</span></div></div><button className="template-copy" type="button" onClick={onCopy}>复制方案并编辑 <Icon name="arrow" size={16} /></button></div></article>
}

function BoardPreview({ shape }: { shape: TemplateCardData['shape'] }) {
  const className = `mini-board mini-board-${shape}`
  return <div className="board-stage"><div className={className}><div className="board-holes" /><span className="shelf shelf-a"/><span className="shelf shelf-b"/><span className="hook hook-a"/><span className="hook hook-b"/><span className="cup"/><span className="plant">✦</span></div><div className="desk-line" /></div>
}

function IrregularShowcase({ navigate }: { navigate: (route: SiteRoute) => void }) {
  const shapes = [
    { kind: 'l', name: 'L 型', use: '绕开侧柜' },
    { kind: 'step', name: '阶梯型', use: '贴合床架' },
    { kind: 'notch', name: '凹口型', use: '避让立柱' },
    { kind: 'arch', name: '圆弧型', use: '适配斜顶' },
    { kind: 'corner', name: '转角型', use: '包住桌角' },
  ]
  return <section className="site-section irregular-section">
    <div className="irregular-copy">
      <div className="eyebrow"><span className="eyebrow-dot" /> SnapBoard 的核心差异</div>
      <h2>宿舍不是方盒子，<br/><span>板子也不该只有矩形。</span></h2>
      <p>上床下桌有侧柜、横梁、梯子、立柱和插座。SnapBoard 先按真实空间画出 L 型、阶梯型或带凹口的整板，再把异形轮廓自动拆成打印机放得下的板件。</p>
      <ul>
        <li><span>01</span><div><b>沿家具生长</b><small>板面绕开柜体和床架，而不是牺牲整片可用空间。</small></div></li>
        <li><span>02</span><div><b>异形也能自动分割</b><small>保留拐角、孔位与接缝关系，继续生成 P1、P2…板件。</small></div></li>
        <li><span>03</span><div><b>先结构，后配件</b><small>接缝确定后再布置挂钩和托盘，避免跨缝与悬空。</small></div></li>
      </ul>
      <DesignerLink className="site-primary large">画一块异形板 <Icon name="arrow"/></DesignerLink>
    </div>
    <div className="irregular-visual">
      <IrregularWorkbench />
      <div className="shape-gallery" aria-label="支持的异形板示例">{shapes.map(shape => <article key={shape.kind}><div className={`shape-swatch shape-${shape.kind}`}><span/></div><b>{shape.name}</b><small>{shape.use}</small></article>)}</div>
    </div>
  </section>
}

function IrregularWorkbench() {
  return <div className="irregular-workbench"><div className="irregular-stage-head"><span>上床下桌 · 右侧柜体避让</span><b>异形轮廓已闭合</b></div><div className="irregular-room"><div className="irregular-bed"><span>床板 / 横梁</span></div><div className="irregular-main-board"><div className="irregular-holes"/><i className="irregular-cut cut-a"/><i className="irregular-cut cut-b"/><i className="irregular-cut cut-c"/><em className="irregular-panel ip1">P1</em><em className="irregular-panel ip2">P2</em><em className="irregular-panel ip3">P3</em><em className="irregular-panel ip4">P4</em><span className="irregular-shelf"/><span className="irregular-hook ih1"/><span className="irregular-hook ih2"/></div><div className="irregular-dimension idw">1800 mm</div><div className="irregular-dimension idh">1450 mm</div><div className="irregular-cabinet"><span>侧柜</span><small>板面自动绕开</small></div><div className="irregular-outlet">插座</div><div className="irregular-desk"/><div className="irregular-callout callout-l"><b>L 型转角</b><small>完整利用柜体上方空间</small></div><div className="irregular-callout callout-split"><b>异形自动分板</b><small>4 块板 · 适配 220 × 220</small></div></div></div>
}

function Logo() {
  return <span className="site-logo" aria-hidden="true"><svg viewBox="0 0 42 42"><path d="M10 5h22a5 5 0 0 1 5 5v22a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5V10a5 5 0 0 1 5-5Z" fill="currentColor"/><g fill="#fff"><rect x="11" y="10" width="4" height="8" rx="2"/><rect x="19" y="14" width="4" height="8" rx="2"/><rect x="27" y="10" width="4" height="8" rx="2"/><rect x="11" y="24" width="4" height="8" rx="2"/><rect x="19" y="20" width="4" height="8" rx="2"/><rect x="27" y="24" width="4" height="8" rx="2"/></g></svg></span>
}

function HeroWorkbench() {
  return <div className="hero-workbench"><div className="hero-orbit hero-orbit-one"/><div className="hero-orbit hero-orbit-two"/><div className="workbench-window"><div className="workbench-bar"><div><span/><span/><span/></div><b>宿舍异形板编辑器</b><small>轮廓已闭合</small></div><div className="workbench-body"><aside><span className="active"><Icon name="home" size={15}/>异形轮廓</span><span><Icon name="layers" size={15}/>自动分板</span><span><Icon name="cube" size={15}/>配件</span></aside><div className="workbench-canvas"><div className="dimension dim-top">1800 mm</div><div className="dimension dim-side">1450 mm</div><div className="hero-board"><div className="hero-board-holes"/><div className="hero-split split-v"/><div className="hero-split split-h"/><span className="hero-shelf"/><span className="hero-hook h1"/><span className="hero-hook h2"/><span className="hero-bin"/><span className="hero-headset">∩</span><i className="piece-tag p1">P1</i><i className="piece-tag p2">P2</i><i className="piece-tag p3">P3</i><i className="piece-tag p4">P4</i><span className="hero-cabinet-label">侧柜避让</span></div></div><div className="workbench-panel"><small>异形自动分割结果</small><b>4 块板件</b><span><i/>L 型边缘融合</span><span><i/>适配 220 × 220</span><button type="button">查看 3D 预览</button></div></div></div><div className="floating-card verified-card"><span><Icon name="verified" size={18}/></span><div><b>L 型贴合侧柜</b><small>保留柜体上方可用空间</small></div></div><div className="floating-card copy-card"><span><Icon name="spark" size={18}/></span><div><b>异形也能自动分板</b><small>拐角、孔位与编号完整保留</small></div></div></div>
}

function DormStack() {
  return <div className="dorm-stack"><div className="dorm-building"><div className="building-label"><span>江城大学</span><b>松园 3 号楼</b></div>{[1,2,3].map(floor => <div className="dorm-floor" key={floor}><span>{floor + 3}F</span><div className="dorm-room"><i/><i/><i/><i/><b>{floor === 2 ? '母版' : '副本'}</b></div><div className="dorm-room mirror"><i/><i/><i/><i/><b>副本</b></div></div>)}</div><div className="dorm-connector"><span>1 个尺寸母版</span><i/><b>已生成 28 个个性化方案</b></div></div>
}

function PrintQueue() {
 return <div className="print-queue"><div className="printer-machine"><div className="printer-top"><span>SNAP / FARM 04</span><i/></div><div className="printer-frame"><div className="printer-head"/><div className="print-bed"><div className="printed-board"/></div></div><div className="printer-bottom"><span/><span/><b>78%</b></div></div><div className="queue-panel"><div><span className="live-dot"/>正在打印</div><b>松园 3 号楼 · 拼单 #08</b><ul><li><span>板件 P1–P4</span><b>78%</b></li><li><span>材料</span><b>基础色 PETG · 5 mm</b></li><li><span>预计完成</span><b>今天 21:40</b></li></ul></div></div>
}

function MeasureIllustration() {
  return <div className="measure-illustration"><div className="measure-wall"><div className="measure-board"><div className="board-holes"/><span className="measure-line width"><i/>1800 mm<i/></span><span className="measure-line height"><i/>1450 mm<i/></span><span className="measure-outlet">▦</span></div><div className="measure-desk"><span/><i/><i/></div></div><div className="measure-note"><Icon name="check" size={17}/><span><b>先测净空</b><small>插座与床架都要避让</small></span></div></div>
}

function FigureCallout({ number, label, className }: { number: number; label: string; className: string }) {
  return <span className={`figure-callout ${className}`}><b>{number}</b><small>{label}</small></span>
}

function FigureLeaders({ paths }: { paths: string[] }) {
  return <svg className="figure-leaders" viewBox="0 0 760 410" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="guide-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 8 4 0 8Z" /></marker></defs>{paths.map((path, index) => <path key={index} d={path} markerEnd="url(#guide-arrow)" />)}</svg>
}

function GuideDemo({ step }: { step: number }) {
  if (step === 0) return <MeasurePatentFigure />
  if (step === 1) return <TemplatePatentFigure />
  return <DesignerPatentFigure step={step} />
}

function MeasurePatentFigure() {
  return <figure className="patent-figure measure-patent"><div className="patent-sheet"><span className="patent-label">现场测量示意</span><div className="patent-wall"><div className="patent-board-area"><span className="patent-grid"/><span className="patent-dimension patent-width"><i/>W = 1800 mm<i/></span><span className="patent-dimension patent-height"><i/>H = 1450 mm<i/></span><span className="patent-obstacle outlet">插座</span><span className="patent-obstacle frame">床架</span><span className="patent-origin">0,0</span></div><div className="patent-desk"/></div><FigureLeaders paths={['M112 70 L230 70 L330 105','M116 316 L180 316 L180 238','M650 78 L604 78 L575 230','M650 327 L590 327 L515 350']} /><FigureCallout number={1} label="测净宽 W" className="c1"/><FigureCallout number={2} label="测净高 H" className="c2"/><FigureCallout number={3} label="标出障碍" className="c3"/><FigureCallout number={4} label="统一左下基准" className="c4"/></div><figcaption><span>图 01</span> 先确定同一坐标基准，再记录所有尺寸</figcaption></figure>
}

function TemplatePatentFigure() {
  return <figure className="patent-figure template-patent"><div className="patent-sheet"><span className="patent-label">校园方案库 · 母版检索</span><div className="patent-community-ui"><div className="patent-community-filters"><label><small>学校 / 校区</small><b>江城大学</b></label><label><small>宿舍楼</small><b>松园 3 号楼</b></label><label><small>床位方向</small><b>右侧床位</b></label><button type="button">搜索</button></div><div className="patent-template-card"><div className="patent-template-board"><span className="patent-grid"/><i className="patent-cut v"/><i className="patent-cut h"/></div><div className="patent-template-info"><span className="patent-trust">已试装 · 3 人确认</span><h4>上床下桌 · 尺寸母版</h4><p>净空 1800 × 1450 mm</p><p>最后验证：2026-08</p><button type="button">复制方案并编辑</button></div></div></div><FigureLeaders paths={['M94 72 L190 72 L190 121','M100 334 L190 334 L266 313','M650 86 L595 86 L559 221','M650 329 L615 329 L575 330']} /><FigureCallout number={1} label="筛选楼栋与方向" className="c1"/><FigureCallout number={2} label="核对关键尺寸" className="c2"/><FigureCallout number={3} label="看验证等级" className="c3"/><FigureCallout number={4} label="复制为个人副本" className="c4"/></div><figcaption><span>图 02</span> 复用的是尺寸母版，不是别人的个人配件布局</figcaption></figure>
}

function DesignerPatentFigure({ step }: { step: number }) {
  const isDraw = step === 2
  const isSplit = step === 3
  const isParts = step === 4
  const isExport = step === 5
  const labels = isDraw
    ? ['选“外轮廓”', '使用矩形 / 直线', '智能尺寸定宽高', '确认闭合轮廓']
    : isSplit
      ? ['填写热床参数', '选中外轮廓', '点击自动分割', '检查 P1–P4']
      : isParts
        ? ['切换 3D 视图', '展开配件库', '拖到有效孔位', '避开板件接缝']
        : ['逐块核对编号', '检查 3D 方向', '点击导出 3MF', '保留同一版本']
  const paths = isDraw
    ? ['M100 75 L275 75 L310 90','M102 325 L185 325 L262 79','M650 74 L596 74 L510 214','M652 331 L585 331 L178 260']
    : isSplit
      ? ['M102 75 L555 75 L653 165','M102 329 L205 329 L330 248','M650 75 L575 75 L515 74','M650 330 L610 330 L655 270']
      : isParts
        ? ['M102 75 L558 75 L584 73','M652 75 L690 75 L690 155','M102 330 L220 330 L410 205','M650 330 L582 330 L452 235']
        : ['M102 75 L175 75 L316 175','M102 330 L210 330 L480 225','M650 75 L700 75 L700 261','M650 330 L605 330 L555 325']
  return <figure className={`patent-figure designer-patent designer-step-${step}`}><div className="patent-sheet"><span className="patent-label">SnapBoard 设计器 · {isDraw ? '2D 异形草图' : isSplit ? '异形自动分板' : isParts ? '3D 装配' : '制造输出'}</span><div className="patent-designer-ui"><div className="patent-ui-top"><span className={isDraw ? 'focus' : ''}>◎ 外轮廓</span><span className={isDraw ? 'focus' : ''}>✏ 直线 P</span><span>↔ 尺寸 D</span><span className={isSplit ? 'focus' : ''}>🔪 自动分割</span><span className={isParts || isExport ? 'focus' : ''}>{isDraw || isSplit ? '🧊 3D 视图' : '📐 3D 视图'}</span></div><div className="patent-ui-body"><aside className="patent-ui-left"><b>项目结构</b><span>▾ 板件</span><span className="selected">　L 型外轮廓 01</span><span>　内孔 01</span><small>属性</small><label>类型 <b>异形外轮廓</b></label><label>状态 <b>已闭合</b></label></aside><div className={`patent-ui-canvas ${isParts || isExport ? 'is-3d' : ''}`}><span className="canvas-axis">Y ↑<br/>0,0　→ X</span><div className="patent-ui-board irregular"><span className="patent-grid"/>{!isDraw && <><i className="patent-cut v"/><i className="patent-cut h"/><em className="panel-id p1">P1</em><em className="panel-id p2">P2</em><em className="panel-id p3">P3</em><em className="panel-id p4">P4</em></>}{isDraw && <><span className="ui-dimension w">1800 mm</span><span className="ui-dimension h">1450 mm</span><i className="inner-hole"/></>}{(isParts || isExport) && <><span className="ui-part shelf"/><span className="ui-part bin"/><span className="ui-part hook"/></>}</div><span className="patent-cabinet">侧柜避让</span></div><aside className={`patent-ui-right ${isParts ? 'parts-mode' : ''}`}><b>{isParts ? '🧩 配件库' : '🔪 分割引擎'}</b>{isParts ? <><div className="part-search">搜索配件</div><div className="part-tile"><i>⌜</i><span>短挂钩<small>拖到板面</small></span></div><div className="part-tile"><i>▱</i><span>小托盘<small>拖到板面</small></span></div><div className="part-tile"><i>▤</i><span>收纳盒<small>拖到板面</small></span></div></> : <><label>热床宽 <b>220</b></label><label>热床深 <b>220</b></label><label>板厚 <b>5.0</b></label><button type="button">{isDraw ? '等待生成' : '⚡ 自动分割'}</button><div className="split-list"><strong>异形分割结果</strong><span>P1　220 × 220</span><span>P2　220 × 220</span><span>P3　220 × 180</span><span>P4　L 型融合板</span>{isExport && <button className="export-3mf" type="button">↓ 导出 3MF</button>}</div></>}</aside></div></div><FigureLeaders paths={paths}/>{labels.map((label, index) => <FigureCallout key={label} number={index + 1} label={label} className={`c${index + 1}`}/>)}</div><figcaption><span>图 {String(step + 1).padStart(2, '0')}</span> {isDraw ? '先沿柜体和床架画出 L 型外轮廓，配件在此阶段保持为空' : isSplit ? '异形轮廓同样生成真实接缝与板件编号' : isParts ? '配件根据已经确定的异形板件和孔位进行装配' : '导出前让异形板件、配件与项目版本保持一致'}</figcaption></figure>
}

function PrintNetwork() {
  return <div className="network-map"><div className="map-grid"/><div className="school-node main"><span><Icon name="home" size={22}/></span><b>你的学校</b><small>8 个待拼单项目</small></div><div className="farm-node n1"><span><Icon name="printer" size={18}/></span><b>打印伙伴 A</b><small>3.2 km</small></div><div className="farm-node n2"><span><Icon name="printer" size={18}/></span><b>创客社 B</b><small>校内自提</small></div><div className="farm-node n3"><span><Icon name="printer" size={18}/></span><b>打印农场 C</b><small>5.4 km</small></div><svg viewBox="0 0 500 340" preserveAspectRatio="none"><path d="M250 175C185 130 160 100 105 82M250 175c80-60 112-45 164-87M250 175c65 65 70 78 135 104"/></svg></div>
}

function FarmCard({ name, area, machines, material, time, color }: { name: string; area: string; machines: string; material: string; time: string; color: string }) {
  return <article className="farm-card" style={{ '--farm-color': color } as React.CSSProperties}><div className="farm-card-head"><span><Icon name="printer" size={23}/></span><div><h3>{name}</h3><p><Icon name="map" size={14}/>{area}</p></div><small>待审核</small></div><div className="farm-card-stats"><span><small>设备</small><b>{machines}</b></span><span><small>材料</small><b>{material}</b></span></div><div className="farm-card-foot"><span><Icon name="clock" size={15}/>{time}</span><button type="button" disabled>联系方式待开放</button></div></article>
}

function SiteFooter({ navigate }: { navigate: (route: SiteRoute) => void }) {
  return <footer className="site-footer"><div className="footer-top"><div className="footer-brand"><button className="site-brand" type="button" onClick={() => navigate('/')}><Logo/><span className="site-brand-copy"><b>SnapBoard</b><small>校园空间共创计划</small></span></button><p>让一次认真测量，被整栋楼重复使用。<br/>让每个小空间，都有自己的秩序。</p></div><div className="footer-links"><div><b>产品</b><button onClick={openDesigner}>在线设计器 ↗</button><button onClick={() => navigate('/community')}>校园方案库</button><button onClick={() => navigate('/print')}>打印服务</button></div><div><b>帮助</b><button onClick={() => navigate('/guide')}>第一次使用</button><button onClick={() => navigate('/guide')}>测量指南</button><button onClick={() => navigate('/guide')}>打印与安装</button></div><div><b>项目</b><button onClick={() => navigate('/project')}>项目资料</button><button onClick={() => navigate('/project')}>开发日志</button><button onClick={() => navigate('/project')}>GitHub 开源</button></div></div></div><div className="footer-bottom"><span>© 2026 SnapBoard · 当前为产品原型</span><div><button type="button">用户协议</button><button type="button">隐私说明</button><button type="button">社区规范</button></div></div></footer>
}
