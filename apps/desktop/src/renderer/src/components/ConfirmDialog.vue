<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Modal as AModal, Input as AInput } from "ant-design-vue";

/**
 * 确认对话框（可复用为输入对话框）：open 控制显隐；
 * 传 inputPlaceholder 时显示输入框，confirm 回传输入值；否则回传 null（纯确认）。
 * 供重命名/创建/删除确认与 TopBar 新建工作区复用；默认插槽可注入额外正文
 * （SideTree 删除影响清单）。
 * antd 4 落地：a-modal 承载（open/title/okText/cancelText 走 i18n，与原按钮文案一致），
 * 按钮 data-testid 经 okButtonProps/cancelButtonProps 保留在等效触发元素上；
 * 输入框为 a-input（v-model:value），Enter 提交走 @press-enter。
 * antd 4 的 Modal 恒经传送门渲染于 body（getContainer=false 会被 Modal 内部
 * falsy 回退吞掉），因此测试用 document.body 作用域查询（见测试文件说明）；
 * 模板外层 v-if="open"：关闭即整体卸载、无离场动画——既有「取消后对话框不存在」
 * 语义同步保留且不引入动画时序依赖。
 */
const props = defineProps<{
  open: boolean;
  title: string;
  inputPlaceholder?: string;
  initialValue?: string;
}>();
const emit = defineEmits<{ confirm: [value: string | null]; cancel: [] }>();
const { t } = useI18n();

const value = ref("");
watch(
  () => props.open,
  (open) => {
    if (open) value.value = props.initialValue ?? "";
  },
);

function confirm() {
  emit("confirm", props.inputPlaceholder !== undefined ? value.value : null);
}

// data-* 为 HTML 透传属性，antd 按钮 props 类型未建模；经 any 索引签名断言保留测试锚点
// （运行时 Vue 原样透传到 ok/cancel 按钮上，行为不变，见 vue-tsc 收口）。
const okButtonProps: Record<string, any> = { "data-testid": "dialog-confirm" };
const cancelButtonProps: Record<string, any> = { "data-testid": "dialog-cancel" };
</script>

<template>
  <a-modal
    v-if="open"
    :open="open"
    :title="title"
    :ok-text="t('common.confirm')"
    :cancel-text="t('common.cancel')"
    :ok-button-props="okButtonProps"
    :cancel-button-props="cancelButtonProps"
    :width="360"
    data-testid="confirm-dialog"
    @ok="confirm"
    @cancel="emit('cancel')"
  >
    <a-input
      v-if="inputPlaceholder !== undefined"
      v-model:value="value"
      data-testid="dialog-input"
      :placeholder="inputPlaceholder"
      @press-enter="confirm"
    />
    <!-- 默认插槽：调用方注入额外正文（任务 6 删除影响清单 impact-list 由此进入弹窗）。 -->
    <slot />
  </a-modal>
</template>
