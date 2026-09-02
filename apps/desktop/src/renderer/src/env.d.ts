// 声明 .vue 单文件组件模块，使 tsc --noEmit 能通过 src/renderer 与 tests 对 App.vue 的导入。
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
