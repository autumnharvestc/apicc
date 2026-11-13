# 主工作台顶栏精简样板

2026-11-13，使用内置 imagegen 在上一张主工作台样板上修改顶栏。左侧显示应用图标与工作区名。右侧用「中／EN」和当前主题图标触发下拉，主题菜单显示图标、名称与当前选中项。

项目查找与打开由主页承接，已打开项目由页签切换。主页的「管理连接」承接连接和登录，在线工作区菜单需要保留迁移和退出入口，退出继续使用原影响范围确认。本图展示本地工作区的顶栏。

## 生成提示

Use case: ui-mockup, precise-object-edit. Image 1 is the existing Chinese light-mode desktop API workbench mockup and the edit target. Make a revised version for review, same wide canvas, same original scale and crop. Edit the GLOBAL TOP ROW ONLY, with one small expanded theme dropdown as an overlay. Preserve the project tab row and everything below it exactly: pinned “主页”, “订单服务”, “第二项目”, “外部规范同步”, horizontal module navigation, directory and API rows, request/response panels, all typography and sample data. The global row should feel deliberately minimal, airy and cohesive.

Top left: keep the existing small blue rounded-square a app mark, but completely remove the adjacent wordmark text “apicc”; close that gap and put the folder icon with “合成工作区” and its tiny downward chevron next to the app mark. Use a restrained divider if useful. Render no app name text in this row.

Remove the entire large “查找项目” search input and entire “在线模式” button from the top row, including their icons, borders, green dot and placeholders. Leave calm unobstructed neutral space between left workspace identity and right utilities.

Right end of the global row, immediately before the subtle divider and the original Windows minimize/maximize/close: three evenly aligned compact quiet buttons. First language button uses only the single character “中” and a tiny down chevron, for current Chinese. Second theme button uses a simple outline sun and tiny down chevron. Third settings button is the existing simple gear. Remove the old globe + “中文” full-length trigger and the old three-option segmented theme bar. Match icon stroke, height, spacing and soft hover surface.

Show only the theme dropdown open below its sun trigger to illustrate the affordance, with a small white 3-row menu, fine cool-gray outline, slight shadow, and no title. Rows exact text and icons: monitor “自动”, sun “亮色” with a checkmark at right and subtle blue selection tint, moon “暗色”. Use real thin icons, no emoji. Keep the popover compact, place it just to the left of the far-right sync button so it covers only the otherwise blank part of the tab/module rows, not tab labels or editor controls. The open dropdown is the only element overlapping the preserved area. Do not open a language menu at the same time.

Do not regenerate or change any other page content. Keep the same clean slate-white-blue design and Chinese text fidelity. Output one edited image, no annotations, labels outside UI, arrows, watermark or side-by-side variant.
