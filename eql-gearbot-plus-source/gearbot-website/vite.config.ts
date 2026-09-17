import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// No dev proxy here on purpose: the OAuth redirect (Discord -> eq-gear-bot's
// /auth/callback) is a full-page browser navigation straight to the API's
// real origin (OAUTH_REDIRECT_URI in eq-gear-bot/.env), so the session
// cookie gets set against that origin. Proxying /api through Vite would
// make that cookie invisible to proxied same-origin fetches. Instead the
// app calls the API's real URL directly (VITE_API_URL) with
// `credentials: 'include'`, and the API's CORS config trusts WEBSITE_URL.
// See README.md for the same-site-domain requirement this implies.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173
  }
});
