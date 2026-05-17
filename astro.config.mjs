// @ts-check

import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://blog.miproteina.com.co',
  output: 'static',
  integrations: [sitemap()],
  i18n: {
    defaultLocale: 'es',
    locales: ['es'],
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
