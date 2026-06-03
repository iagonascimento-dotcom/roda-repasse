import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

const BUILD_TIME = new Date().toISOString();

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'write-version-file',
      // Write public/version.txt before build so it gets copied to dist
      buildStart() {
        try {
          if (!fs.existsSync('public')) fs.mkdirSync('public');
          fs.writeFileSync(path.resolve('public/version.txt'), BUILD_TIME);
        } catch (e) {
          console.warn('Could not write version.txt:', e.message);
        }
      }
    }
  ],
  define: {
    __BUILD_TIME__: JSON.stringify(BUILD_TIME)
  },
  base: './',
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      }
    }
  }
});
