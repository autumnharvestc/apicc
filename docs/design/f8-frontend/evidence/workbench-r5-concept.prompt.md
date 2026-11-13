# 工作区标签与环境快捷菜单样板

2026-11-13，使用内置 imagegen 在单行顶栏样板上修订。工作区名称使用固定宽度的只读标签，单行超长省略，只有发生截断时才在悬停或键盘聚焦时显示完整名称。主页负责打开或选择工作区。

左侧「环境」打开快捷菜单。样板展示接口调试，菜单与当前请求页签的环境选择同步，选择后留在调试页。底部「管理环境」进入配置。现有请求、运行和工作流各自读取其环境选择，快捷菜单需要显示当前作用范围并复用该范围的选择逻辑。

## 生成提示

Use case: ui-mockup, precise-object-edit. Image 1 is the prior apicc light-mode Chinese desktop workbench concept and the edit target. Keep its exact wide canvas, restrained blue-gray design, single top row with fixed “主页” and project tabs, narrow left module rail, interface tree, large request and response panels and lower-left project tool. Create one revised visual sample, changing only the workspace label and environment interaction below.

Workspace identity at the upper left is now a plain non-interactive label. Keep the blue app icon and the small folder icon. Use one fixed-width text slot around 144 logical px with the long display name visually truncated on one line, exact visible string “合成验收工作区…”. Remove the downward caret after it. No button outline, menu, selected treatment or expanded tooltip in the screenshot. “主页” and the two project tabs stay aligned and maintain their prior positions.

Demonstrate quick environment switching while the Interface module and current request stay open. The original left-rail item “环境” opens a compact contextual popover to its RIGHT, just below the bottom of the visible API tree entries, over the quiet blank lower portion of the directory pane and away from the main editor. It should be visibly anchored to that rail item by a subtle small pointer, white with light border, 8px corners, slight shadow. The interface item remains the active module in blue; the environment trigger has only a light pressed state and small chevron. Do not change it into a second active module or replace the main editor.

Popup exact content: understated label “当前请求环境”; stacked choices “无环境”, “开发环境”, “预发布环境”. “开发环境” is the checked current row with a subtle blue background and right check mark. A thin separator and one final gear item “管理环境” open the configuration page when used. No description paragraph or fake actions. Update the existing request toolbar environment field to show exactly “开发环境” with its chevron as the same selected value. Render menu in clean high-contrast Chinese typography with modest padding, not a large modal. The request data and response still visible and identical.

All other labels, module positions, document tab, project sync action, colors, sizes and sample response stay as in the provided image. No annotation strokes, exterior labels, extra menus, tooltip, duplicative environment selector in the header, marketing copy or watermark. One full-width realistic product UI mockup.
