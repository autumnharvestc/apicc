<script setup lang="ts">
import { Empty as AEmpty } from "ant-design-vue";

/** 空态占位：a-empty 承载，props text 保留为描述文案（契约不变）。 */
defineProps<{ text: string }>();
</script>

<template>
  <div class="empty-state" data-testid="empty-state">
    <a-empty :description="text" />
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 120px;
  padding: 16px;
}
</style>
