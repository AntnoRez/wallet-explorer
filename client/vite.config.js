import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    port: 5173,

    /**
     * Прокси на backend.
     *
     * Фронт запрашивает /api/... у самого себя, Vite перенаправляет на
     * localhost:4000. Так в разработке нет ни CORS, ни абсолютных URL
     * в коде — а значит и переменной окружения с адресом сервера.
     *
     * На проде оба будут за одним nginx, и путь /api останется тем же.
     */
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
