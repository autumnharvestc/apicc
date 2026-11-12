# P4b 合成浏览器夹具

归档用途：复现真实公共App、桌面DocumentPreview及生产HTML生成器的呈现。没有真实帐号、权限或服务数据；不代替原生验收。

将本目录四个源文件复制到仓库 `local/f8-frontend-p4b/browser/`，使用已安装依赖和项目固定Node工具链运行该目录 `serve.mjs`。它只监听127.0.0.1:63579，生成offline目录和seed.json。不要在归档路径直接启动：相对仓库根按local目录设计。根页面是公共safe DTO；`?view=preview`是桌面预览；offline六个HTML名见serve.mjs。

artifacts目录是最终生成字节。document-dark.html是专用视觉夹具，唯一变更为将生产暗色媒体查询改成all；不能把它当系统媒体偏好验收证据。其余HTML直接由生产生成器生成。public.html保持无脚本和原CSP。
