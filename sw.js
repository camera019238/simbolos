const CACHE_NAME = "simbolos-v3";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/simbolos.html",
  "/download.html",
  "/tools.html",
  "/404.html",
  "/UnicodeData.txt",
  "/manifest.json",
  // Iconos — todas las variantes
  "/icon.svg",
  "/icon-32.png",
  "/icon-32-dark.png",
  "/icon-192.png",
  "/icon-192-dark.png",
  "/icon-512.png",
  "/icon-512-dark.png",
  "/favicon.ico",
  // Fuentes locales
  "/fonts/syne-variable.ttf",
  "/fonts/dm-mono-regular.ttf",
  "/fonts/noto-music.ttf",
  "/fonts/noto-sans-math.ttf",
  "/fonts/noto-sans-symbols.ttf",
  "/fonts/noto-sans-symbols2.ttf",
  "/fonts/noto-emoji.ttf",
  "/fonts/noto-sans.ttf",
  "/fonts/stix-two-math.ttf",
];

// Fuentes y recursos externos que cacheamos en runtime
const FONT_DOMAINS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

// ── INSTALL: precachear assets estáticos ────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cachear lo que esté disponible, ignorar fallos individuales
      return Promise.allSettled(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((e) => console.warn("[SW] No se pudo cachear:", url, e))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: limpiar caches viejos ─────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => {
            console.log("[SW] Eliminando cache viejo:", key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── BLOQUEAR EXTENSIONES ─────────────────────────────────────
// Las extensiones de Chrome inyectan requests desde chrome-extension://
// El SW puede interceptarlos y rechazarlos
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Bloquear requests de extensiones
  if (event.request.url.startsWith("chrome-extension://") ||
      event.request.url.startsWith("moz-extension://") ||
      event.request.referrer?.startsWith("chrome-extension://")) {
    event.respondWith(new Response("Bloqueado.", { status: 403, statusText: "Forbidden" }));
    return;
  }

  // Ignorar peticiones no-GET
  if (event.request.method !== "GET") return;

  // Fuentes de Google: cache-first con fallback de red
  if (FONT_DOMAINS.some((d) => url.hostname.includes(d))) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // UnicodeData.txt: cache-first (es grande y no cambia)
  if (url.pathname.endsWith("UnicodeData.txt")) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // HTML principal: network-first para tener siempre la última versión
  if (url.pathname.endsWith(".html") || url.pathname === "/" || url.pathname.endsWith("/")) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Imágenes e iconos: cache-first
  if (/\.(png|jpg|jpeg|webp|svg|ico)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Todo lo demás: stale-while-revalidate
  event.respondWith(staleWhileRevalidate(event.request));
});

// ── ESTRATEGIAS ─────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response("Sin conexión y sin caché.", { status: 503 });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response("Sin conexión.", { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || (await fetchPromise) || new Response("Sin conexión.", { status: 503 });
}

// ── MENSAJE desde la app ─────────────────────────────────────
self.addEventListener("message", (event) => {
  if (!event.data) return;

  // Forzar update
  if (event.data === "skipWaiting") {
    self.skipWaiting();
    return;
  }

  const { type, url } = event.data;

  // Abrir una nueva tab/ventana dentro de la PWA
  if (type === "openTab" && url) {
    event.waitUntil(self.clients.openWindow(url));
    return;
  }

  // Navegar en el cliente actual
  if (type === "navigate" && url) {
    event.waitUntil(
      event.source.navigate(url).catch(() => self.clients.openWindow(url))
    );
    return;
  }

  // Broadcast a todos los clientes (ej. para sincronizar favoritos)
  if (type === "broadcast") {
    event.waitUntil(
      self.clients.matchAll({ type: "window" }).then(clients =>
        clients.forEach(c => c !== event.source && c.postMessage(event.data))
      )
    );
    return;
  }

  // App Badge — número de favoritos en el icono de la app
  if (type === "setBadge") {
    const count = event.data.count || 0;
    if ("setAppBadge" in self.navigator) {
      count > 0
        ? self.navigator.setAppBadge(count)
        : self.navigator.clearAppBadge();
    }
    return;
  }
});

// ── NOTIFICACIONES de background sync (futura) ───────────────
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-favorites") {
    // Placeholder para sincronización futura de favoritos
    console.log("[SW] sync-favorites");
  }
});

// ── PERIODIC BACKGROUND SYNC ─────────────────────────────────
// Refresca el cache de UnicodeData.txt en background (ChromeOS/Chrome)
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "refresh-unicode-data") {
    event.waitUntil(
      fetch("/UnicodeData.txt", { cache: "no-cache" }).then(response => {
        if (response.ok) {
          return caches.open(CACHE_NAME).then(cache =>
            cache.put("/UnicodeData.txt", response)
          );
        }
      }).catch(() => {}) // Sin red: silenciar
    );
  }

  if (event.tag === "refresh-pages") {
    event.waitUntil(
      Promise.all(["/simbolos.html", "/tools.html", "/index.html"].map(url =>
        fetch(url, { cache: "no-cache" }).then(r => {
          if (r.ok) caches.open(CACHE_NAME).then(c => c.put(url, r));
        }).catch(() => {})
      ))
    );
  }
});

// ── BACKGROUND FETCH (fuentes pesadas) ───────────────────────
self.addEventListener("backgroundfetchsuccess", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const records = await event.registration.matchAll();
      await Promise.all(records.map(async record => {
        const response = await record.responseReady;
        await cache.put(record.request, response);
      }));
      await event.updateUI({ title: "Fuentes descargadas ✓" });
    })()
  );
});

self.addEventListener("backgroundfetchfail", (event) => {
  console.warn("[SW] Background fetch falló:", event.registration.id);
});

self.addEventListener("backgroundfetchclick", (event) => {
  event.waitUntil(clients.openWindow("/tools.html?tab=fuentes"));
});


