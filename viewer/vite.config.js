import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `base` must match the GitHub Pages project path: https://michaelyeh507.github.io/OmniSight/
// It is used in dev too, so path bugs surface early. Override with OMNI_BASE=/ for a
// root-hosted deploy (Vercel, Netlify, a .tech domain).
//
// `npm run dev` stays plain http on 127.0.0.1: `adb reverse tcp:5173 tcp:5173` then gives
// the Samsung a secure-context localhost URL with no certificate, which WebXR accepts.
// `npm run dev:ssl` adds a self-signed cert for hotspot testing (Chrome: Advanced > Proceed).
export default defineConfig(({ mode }) => ({
  base: process.env.OMNI_BASE || '/OmniSight/',
  plugins: mode === 'ssl' ? [basicSsl()] : [],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
}));
