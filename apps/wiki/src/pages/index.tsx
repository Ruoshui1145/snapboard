import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './index.module.css';

const modules = [
  ['二维草图', '画出真实墙面、插座内孔与精确尺寸。', '/docs/product/sketch'],
  ['自动分板', '适配有效打印区域，生成孔阵、拼接和圆角。', '/docs/product/splitting-and-holes'],
  ['3D 装配', '配件锚点、正反面吸附和实时制造预览。', '/docs/product/assembly'],
  ['纹理工作室', 'PETG 基层、彩色版画与材质贴面。', '/docs/product/texture-studio'],
  ['多盘 3MF', '排盘、对象、材料、打印机预设和降级交付。', '/docs/manufacturing/3mf'],
  ['开放开发日志', '记录失败、修正、实体样板和校园试点。', '/devlog'],
];

function ModuleCards() {
  return <section className={styles.cards}>
    {modules.map(([title, body, href]) => (
      <Link className={styles.card} to={href} key={title}>
        <span className={styles.dot} />
        <Heading as="h3">{title}</Heading>
        <p>{body}</p>
      </Link>
    ))}
  </section>;
}

export default function Home() {
  const {siteConfig} = useDocusaurusContext();
  const studioImage = useBaseUrl('/img/studio-overview.png');
  return <Layout title={siteConfig.title} description={siteConfig.tagline}>
    <main>
      <section className={clsx(styles.hero)}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>BROWSER → 3MF → REAL SPACE</span>
          <Heading as="h1">让每一块不规则空间<br/>都能被制造</Heading>
          <p>SnapBoard 把二维轮廓、自动分板、孔阵、3D 装配、彩色纹理和多盘 3MF 连成一条普通用户可以完成的工作流。</p>
          <div className={styles.actions}>
            <Link className="button button--primary button--lg" to="/docs/getting-started/overview">阅读文档</Link>
            <Link className="button button--secondary button--lg" to="/community">浏览校园方案</Link>
          </div>
        </div>
        <div className={styles.heroVisual}>
          <img src={studioImage} alt="SnapBoard Studio 界面" />
        </div>
      </section>
      <section className={styles.statement}>
        <span>SNAPBOARD PRINCIPLE</span>
        <Heading as="h2">开放记录，真实制造，逐步验证。</Heading>
        <p>文档站同时服务用户、开发者、打印者和校园试点。公开内容与内部商业资料分离，所有“完成”都以可运行软件、切片文件或实体测试为准。</p>
      </section>
      <ModuleCards />
    </main>
  </Layout>;
}
