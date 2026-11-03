import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
export default defineConfig({ plugins: [vue()], base: '/share-viewer/', build: { rollupOptions: { output: { entryFileNames: 'viewer.js', assetFileNames: 'viewer.[ext]', chunkFileNames: 'chunk-[name].js' } } }, test: { environment: 'jsdom', alias: { '@apicc/core/collaboration/presentation': new URL('../../packages/core/src/collaboration/presentation.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') } } });
