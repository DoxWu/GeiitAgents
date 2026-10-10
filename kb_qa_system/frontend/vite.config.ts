import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";
import { visualizer } from "rollup-plugin-visualizer";
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // The default browser entry uses document.createElement, which cannot run in
  // the DOCX Worker. The table-based entry also works in the main page and dev.
  resolve: { alias: { 'decode-named-character-reference': require.resolve('decode-named-character-reference') } },
  worker: { format: 'es' },
  server: {
    // Rust outputs can be locked while linking on Windows; never watch them.
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    sourcemap: false,
    // 优化2：显式配置 modulePreload
    // 作用：入口 chunk 的依赖 chunk 会通过 <link rel="modulepreload"> 预加载
    // polyfill: false → 不注入 modulepreload polyfill（~600 bytes）
    //   理由：目标浏览器（Chrome 61+/Firefox 60+/Safari 10.1+）原生支持 modulepreload，
    //         polyfill 仅为兼容已废弃的旧 Edge，本项目浏览器范围不需要
    modulePreload: { polyfill: true },
    // 资源文件名哈希（长期缓存策略）
    rollupOptions: {
      output: {
        // 入口文件命名：assets/[name]-[hash].js
        entryFileNames: 'assets/[name]-[hash].js',
        // 代码块文件命名：assets/[name]-[hash].js
        chunkFileNames: 'assets/[name]-[hash].js',
        // 静态资源命名：assets/[name]-[hash].[ext]
        assetFileNames: 'assets/[name]-[hash].[ext]',
        // 手动代码分割，将第三方依赖分离为独立 chunk
        manualChunks: {
          // React 核心（react、react-dom、react-router）
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          // 状态管理
          'utils-vendor': ['zustand'],
          // 图标库（独立拆分，避免混入业务 chunk）
          'icons-vendor': ['lucide-react'],
          // Markdown 渲染（独立拆分，体积约 1MB，避免影响首屏加载）
          'markdown-vendor': ['react-markdown', 'remark-gfm', 'rehype-highlight', 'highlight.js'],
        },
      },
    },
    // 警告阈值：单个 chunk 超过 500KB 时警告
    chunkSizeWarningLimit: 500,
  },
  plugins: [
    react({
      babel: {
        plugins: [
          ...(command === 'serve' ? ['react-dev-locator'] : []),
        ],
      },
    }),
    tsconfigPaths(),
    // E2-01: Bundle 体积分析工具
    // 使用方式：ANALYZE=true npm run build
    // 生成 stats.html 可视化报告，识别体积瓶颈
    ...(process.env.ANALYZE
      ? [
          visualizer({
            filename: "stats.html",
            open: true,
            gzipSize: true,
            brotliSize: true,
            template: "treemap",
          }),
        ]
      : []),
  ],
}))
