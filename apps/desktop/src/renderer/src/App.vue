<script setup lang="ts">
const ready = true;
</script>

<template>
  <div class="app" data-testid="app-root">
    <span data-testid="app-ready">{{ ready ? "apicc" : "" }}</span>
  </div>
</template>

<style>
html, body, #app { height: 100%; margin: 0; }
</style>
