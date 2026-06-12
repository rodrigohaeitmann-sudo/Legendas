import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    // ffmpeg.wasm's UMD core has to be loaded via importScripts inside its
    // own Web Worker. The package's exports map blocks deep imports of the
    // dist files, so we copy them to dist/ffmpeg/ at build time (and serve
    // them from /ffmpeg/ in dev) and reference them by absolute path.
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js',
          dest: 'ffmpeg',
        },
        {
          src: 'node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm',
          dest: 'ffmpeg',
        },
      ],
    }),
  ],
})
