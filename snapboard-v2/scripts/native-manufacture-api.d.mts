import type { Plugin } from 'vite'

/** 本地制造进程：只在 dev server 上提供作业式原生导出接口（apply: 'serve'）。 */
export function nativeManufactureApi(): Plugin
