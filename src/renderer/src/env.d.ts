import type { MainApi } from '@shared/types'

declare global {
  interface Window {
    /** 由 preload 通过 contextBridge 暴露的主进程能力集合 */
    api: MainApi
  }
}

/** 渲染层不引入任何新依赖，这里只声明本项目用到的静态资源模块 */
declare module '*.css' {
  const content: string
  export default content
}

export {}
