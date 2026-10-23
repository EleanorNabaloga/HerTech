'use client';

import { useEffect } from 'react';

/**
 * Installs public/sw.js so the app can open without internet. Only in
 * production builds: in development it would serve stale code while editing.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (
      process.env.NODE_ENV !== 'production' ||
      !('serviceWorker' in navigator)
    ) {
      return;
    }

    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch((error) => {
        console.error('Service worker registration failed:', error);
      });
  }, []);

  return null;
}
