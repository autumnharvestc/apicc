<script setup lang="ts">
/** 空态占位：居中灰字。 */
defineProps<{ text: string }>();
</script>

<template>
  <div class="empty-state" data-testid="empty-state">{{ text }}</div>
</template>

<style scoped>
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 120px;
  padding: 16px;
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
}
</style>
