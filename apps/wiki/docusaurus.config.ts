import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const repository = process.env.GITHUB_REPOSITORY;
const githubUrl = repository
  ? `https://github.com/${repository}`
  : '/docs/about/publishing';

const config: Config = {
  title: 'SnapBoard Wiki',
  tagline: '把任意空间变成可打印、可装配、可共享的洞洞板',
  favicon: 'img/logo.svg',
  future: {v4: true},
  url: process.env.SITE_URL ?? 'http://localhost:3000',
  baseUrl: process.env.BASE_URL ?? '/',
  organizationName: process.env.GITHUB_ORG ?? 'snapboard-project',
  projectName: process.env.GITHUB_REPO ?? 'snapboard',
  // /design/ is a separately-built Vite app copied into static/design.
  // Docusaurus cannot resolve that static sub-app as a docs route.
  onBrokenLinks: 'ignore',
  markdown: {hooks: {onBrokenMarkdownLinks: 'throw'}},
  i18n: {
    defaultLocale: 'zh-Hans',
    locales: ['zh-Hans'],
    localeConfigs: {'zh-Hans': {label: '简体中文'}},
  },
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: 'docs',
          // The local repository currently has no first commit. Enable these
          // after GitHub history exists, otherwise Docusaurus cannot read VCS metadata.
          showLastUpdateAuthor: false,
          showLastUpdateTime: false,
        },
        blog: {
          routeBasePath: 'devlog',
          blogTitle: 'SnapBoard 开发日志',
          blogDescription: '从二维草图到实体彩色洞洞板的公开开发记录',
          showReadingTime: true,
          postsPerPage: 10,
          feedOptions: {type: ['rss', 'atom'], xslt: true},
          onInlineTags: 'warn',
          onInlineAuthors: 'warn',
          onUntruncatedBlogPosts: 'ignore',
        },
        theme: {customCss: './src/css/custom.css'},
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    image: 'img/studio-overview.png',
    metadata: [
      {name: 'keywords', content: 'SnapBoard, 洞洞板, 3D打印, 3MF, Bambu, PETG, 参数化设计'},
    ],
    colorMode: {defaultMode: 'dark', respectPrefersColorScheme: true},
    navbar: {
      title: 'SnapBoard',
      hideOnScroll: false,
      logo: {alt: 'SnapBoard Logo', src: 'img/logo.svg'},
      items: [
        {type: 'docSidebar', sidebarId: 'docsSidebar', position: 'left', label: '文档'},
        {to: '/community', label: '社区方案', position: 'left'},
        {to: '/design/', label: '在线设计器', position: 'left'},
        {to: '/devlog', label: '开发日志', position: 'left'},
        {to: '/docs/architecture/overview', label: '模块架构', position: 'left'},
        {to: '/docs/operations/campus-pilot', label: '校园试点', position: 'left'},
        {href: githubUrl, label: repository ? 'GitHub' : 'GitHub 接入', position: 'right'},
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {title: '开始', items: [
          {label: '项目概览', to: '/docs/getting-started/overview'},
          {label: '快速启动', to: '/docs/getting-started/quick-start'},
        ]},
        {title: '核心模块', items: [
          {label: '自动分板与孔位', to: '/docs/product/splitting-and-holes'},
          {label: '3D 装配', to: '/docs/product/assembly'},
          {label: '纹理工作室', to: '/docs/product/texture-studio'},
        ]},
        {title: '制造与社区', items: [
          {label: '3MF 制造包', to: '/docs/manufacturing/3mf'},
          {label: '开发日志', to: '/devlog'},
          {label: 'GitHub 发布', to: '/docs/about/publishing'},
        ]},
      ],
      copyright: `Copyright © ${new Date().getFullYear()} SnapBoard. Built with Docusaurus.`,
    },
    docs: {
      sidebar: {hideable: true, autoCollapseCategories: true},
    },
    prism: {theme: prismThemes.github, darkTheme: prismThemes.dracula},
  } satisfies Preset.ThemeConfig,
};

export default config;
