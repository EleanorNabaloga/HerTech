/*
 * DuukaTalk service worker: lets the app open without internet.
 *
 * - Pages: network first, so new deploys show up immediately when online;
 *   the saved copy is used only when the network fails.
 * - /_next/static files: cache first. Their names change with every build,
 *   so a saved copy is never stale.
 * - /api/*: never cached. Ledger data is private; the dashboard keeps its
 *   own per-vendor offline copy and clears it on logout.
 *
 * Bump VERSION to discard all saved copies on the next visit.
 */
const VERSION = "v3";
const PAGE_CACHE = `duukatalk-pages-${VERSION}`;
const STATIC_CACHE = `duukatalk-static-${VERSION}`;
const PAGES = ["/", "/login", "/dashboard"];
const EXTRAS = ["/manifest.webmanifest", "/icon.svg"];

// Collect the script, style and font files a page needs from its HTML.
function assetsIn(html) {
  const found = html.match(/\/_next\/static\/[^"'\s)\\]+/g) || [];
  return [...new Set(found)];
}

async function precache() {
  const pages = await caches.open(PAGE_CACHE);
  const statics = await caches.open(STATIC_CACHE);
  const assets = new Set();

  await Promise.all(
    PAGES.map(async (path) => {
      try {
        const response = await fetch(path, { cache: "no-store" });
        if (!response.ok) return;
        const html = await response.clone().text();
        assetsIn(html).forEach((asset) => assets.add(asset));
        await pages.put(path, response);
      } catch {
        // Offline during install: the page is saved on the next online visit.
      }
    }),
  );

  await Promise.all(
    [...assets, ...EXTRAS].map((url) =>
      statics.add(url).catch(() => undefined),
    ),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== PAGE_CACHE && key !== STATIC_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function savedPage(pages, url) {
  return (await pages.match(url.pathname)) || (await pages.match("/dashboard"));
}

async function networkFirstPage(request) {
  const url = new URL(request.url);
  const pages = await caches.open(PAGE_CACHE);

  try {
    const response = await fetch(request);

    // Server trouble (5xx): show the saved page if there is one, so the
    // app still opens during an outage.
    if (response.status >= 500) {
      const saved = await savedPage(pages, url);
      if (saved) return saved;
    }

    if (response.ok && PAGES.includes(url.pathname)) {
      await pages.put(url.pathname, response.clone());
      // Save the files this version of the page needs, for offline use.
      response
        .clone()
        .text()
        .then((html) =>
          caches
            .open(STATIC_CACHE)
            .then((statics) =>
              Promise.all(
                assetsIn(html).map((asset) =>
                  statics.match(asset).then((hit) => hit || statics.add(asset)),
                ),
              ),
            ),
        )
        .catch(() => undefined);
    }
    return response;
  } catch {
    const saved = await savedPage(pages, url);
    return (
      saved ||
      new Response(
        "<h1>DuukaTalk</h1><p>You are offline. Open the app once with internet so it can work offline.</p>",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
      )
    );
  }
}

async function cacheFirst(request) {
  const statics = await caches.open(STATIC_CACHE);
  const hit = await statics.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await statics.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Private data and the service worker itself always go to the network.
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;

  // Next.js in-app navigation data: let the app handle failures itself.
  if (url.searchParams.has("_rsc") || request.headers.get("RSC")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstPage(request));
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || EXTRAS.includes(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});
