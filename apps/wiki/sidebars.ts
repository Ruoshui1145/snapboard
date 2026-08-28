import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: '快速开始',
      collapsed: false,
      items: ['getting-started/overview', 'getting-started/quick-start'],
    },
    {
      type: 'category',
      label: '产品与工作流',
      collapsed: false,
      items: [
        'product/workflow',
        'product/sketch',
        'product/splitting-and-holes',
        'product/assembly',
        'product/texture-studio',
      ],
    },
    {
      type: 'category',
      label: '制造与打印',
      items: ['manufacturing/3mf', 'manufacturing/printer-presets'],
    },
    {
      type: 'category',
      label: '模块架构',
      items: ['architecture/overview', 'architecture/modules', 'architecture/repository'],
    },
    {
      type: 'category',
      label: '运营与试点',
      items: ['operations/campus-pilot', 'operations/evidence-and-privacy'],
    },
    {
      type: 'category',
      label: '项目信息',
      items: ['about/roadmap', 'about/publishing'],
    },
  ],
};

export default sidebars;
