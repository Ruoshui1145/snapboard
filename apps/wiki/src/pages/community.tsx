import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './community.module.css';

const templates = [
  {title: '上床下桌 · 侧柜避让', location: '郑州 · 松园 3 号楼', meta: 'L 型 · 4 块板', tag: '已试装', color: '#2ac7b3'},
  {title: '右侧床位 · 插座凹口', location: '郑州 · 梅园 2 号楼', meta: '凹口型 · 3 块板', tag: '已复核', color: '#8b5cf6'},
  {title: '双桌连板 · 横梁避让', location: '郑州 · 创客宿舍', meta: '超宽异形 · 6 块板', tag: '草稿', color: '#edaa58'},
];

function MiniBoard({color}: {color: string}) {
  return <div className={styles.board} style={{'--accent': color} as React.CSSProperties}><div className={styles.holes}/><i className={styles.cut}/><i className={styles.shelf}/><i className={styles.hook}/></div>;
}

export default function Community() {
  return <Layout title="社区方案" description="浏览 SnapBoard 的校园异形洞洞板方案">
    <main className={styles.page}>
      <section className={styles.hero}>
        <div><span className={styles.eyebrow}>COMMUNITY BOARD · 校园方案库</span><Heading as="h1">先找到你的空间，<br/><span>再开始设计。</span></Heading><p>从已经测量、复核和试装过的宿舍母版开始。复制之后，只需要调整自己的配件布局。</p><div className={styles.actions}><Link className="button button--primary button--lg" to="/design/">从零开始设计</Link><Link className="button button--secondary button--lg" to="/docs/operations/campus-pilot">查看试点规则</Link></div></div>
        <div className={styles.pulse}><div className={styles.pulseRing}/><div className={styles.pulseCard}><b>郑州 · 校园试点</b><strong>3</strong><span>个已试装母版</span><small>尺寸证据、孔位和安装方式都保留在版本记录中</small></div></div>
      </section>
      <section className={styles.section}><div className={styles.sectionHead}><div><span className={styles.eyebrow}>VERIFIED TEMPLATES</span><Heading as="h2">从一个可靠母版开始</Heading></div><Link to="/docs/operations/campus-pilot">了解母版等级 →</Link></div><div className={styles.grid}>{templates.map(t => <article className={styles.card} key={t.title}><div className={styles.visual}><MiniBoard color={t.color}/><span className={styles.tag}>{t.tag}</span><span className={styles.meta}>{t.meta}</span></div><div className={styles.body}><small>{t.location}</small><h3>{t.title}</h3><p>复制母版后，可以重新布置挂钩、托盘和收纳件。</p><div className={styles.cardFoot}><span>◉ 尺寸母版</span><Link to="/design/">复制并编辑 →</Link></div></div></article>)}</div></section>
      <section className={styles.callout}><div><span className={styles.eyebrow}>OPEN WORKFLOW</span><Heading as="h2">一次测量，整栋楼复用。</Heading><p>每个公开方案都标记测量证据、试装状态、适配范围和版本。隐私信息不进入公开页面。</p></div><Link className="button button--primary" to="/devlog">查看开发日志</Link></section>
    </main>
  </Layout>;
}
