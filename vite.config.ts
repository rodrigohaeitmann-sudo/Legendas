import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    // ffmpeg.wasm's internal worker is module-type. importScripts() throws
    // in module workers, so it falls back to `await import(coreURL)` — which
    // requires the ESM build (`export default createFFmpegCore`). The UMD
    // file we shipped before can't be ESM-imported and failed silently with
    // ERROR_IMPORT_FAILURE. Copy the ESM JS + matching wasm to /ffmpeg/.
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js',
          dest: 'ffmpeg',
        },
        {
          src: 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm',
          dest: 'ffmpeg',
        },
      ],
    }),
  ],
})
