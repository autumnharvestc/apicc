# P2 真实组件浏览器回执

2026-11-08，IAB，合成内存数据、无后台/IPC。具体限制见 P2 验证记录。

- 主页项目名 Enter：打开计数 0→1；随后更多菜单展开四项，仍为 1。
- 连接昵称编辑保存：原两行保留，第一行名称改为“合成连接改名”，URL 保持原合成地址。未测试真实认证。
- 900×720 英文深色：请求签轨道 clientWidth=462，scrollWidth=1797；每个名称按钮约 194 px；最后一个签选中时 scrollLeft=1308.5714，left=570.5715/right=764.5715。点击最后一个关闭按钮后 8→7，新建 HTTP 请求仍显示。
- 树长接口行聚焦前/后：width=245.4286、height=30.0000；活动元素 aria-label=Rename；两个 icon-action 各24×24，opacity=1。此处为真实键盘焦点测量，不代表鼠标/触摸的所有状态均已测试。
- 保存/发送：Save request、Send 依次点击，计数为打开1/保存1/发送1；只证明按钮调用，非落盘或网络请求证明。
- 长响应滚动：viewer.top=68.5714，scrollTop=1302.8572，tools.top=80.5714；输入 SKU-49 后 matches=1、scrollTop=1009.1429、tools.top仍80.5714。点击清除可恢复空框；无外部请求。
- 测量时 document.body.scrollWidth=900、innerWidth=900。
- 浏览器日志发现树顶部新建分组缺 AButton 导入；修正后 DOM 为 BUTTON/type=button，英文 New Group 按 Enter 打开实际输入对话框。最终两张 editor 图在此修正后保存；旧图保留于本地 before-tree-button 目录。
- 深色实际 DOM：原选中文字 rgb(45,84,201)；最终 rgb(154,184,255)。Tabs 最近不透明祖先 editor/viewer 背景 rgb(28,38,54)，对比2.336→7.736；radio 背景rgb(20,20,20)，对比2.828→9.364。
- 对两处点击后均实测 hover=true，文字仍rgb(154,184,255)。pressed覆盖经规则审查，未抓取按住状态。
- Send/solid/primary 仍白字与rgb(45,84,201)背景，对比6.515；disabled outline仍rgba(255,255,255,.25)文字、.18背景。theme-boundaries-dark.png为真实Antd边界夹具。

相应截图与源码/夹具分别散列封存。截图为实际组件，不是完整 App 或新的原生验证包。
