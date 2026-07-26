// ============================================================
// GAMECHANGE - ASYSTENT SPORTOWCA - SERVICE WORKER (PWA, wersja minimalna)
// ============================================================
// Cel tego pliku: TYLKO instalowalnosc (ikona na ekranie glownym,
// otwieranie w trybie "standalone" bez paska adresu przegladarki) -
// NIE pelny tryb offline. Swiadomie ograniczony zakres, uzasadnienie
// nizej przy strategii fetch().
//
// DLACZEGO "network-first", NIE "cache-first" (wazna roznica wzgledem
// typowych przykladow service workerow z internetu, ktore cache'uja
// agresywnie): ta aplikacja jest w aktywnym rozwoju (nowe ekrany, nowe
// zapytania do Supabase co jakis czas) - cache-first ryzykowalby, ze
// zawodnik przez tygodnie widzi STARA wersje appki z przegladarki nawet
// po tym, jak Ty wgrasz nowa (klasyczny problem "service worker zamraza
// appke w czasie"). Network-first z fallbackiem do cache oznacza:
// online = zawsze najnowsza wersja (tak jak dzis, bez SW), offline =
// przynajmniej cos sie otworzy zamiast bialego ekranu/bledu przegladarki
// - wystarczajace dla "wyglada jak appka", nie obiecuje pelnej pracy
// offline (dziennik/cele wymagaja polaczenia z Supabase, tego SW nie
// zmienia i nie probuje).
//
// CACHE_NAME z numerem wersji - podbij recznie (v1 -> v2...) przy
// swiadomej zmianie tego, co ma byc w cache'u (np. dodanie nowej ikony).
// Nie trzeba tego robic przy kazdej zmianie w asystent_app.html samej w
// sobie - network-first i tak zawsze najpierw probuje sieci.
// ============================================================

const CACHE_NAME = 'gamechange-asystent-shell-v1';
const APP_SHELL = [
'/asystent_app.html',
'/manifest.webmanifest',
'/icons/icon-192.png',
'/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
event.waitUntil(
caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
);
self.skipWaiting();
});

self.addEventListener('activate', (event) => {
event.waitUntil(
caches.keys().then((names) =>
Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
)
);
self.clients.claim();
});

self.addEventListener('fetch', (event) => {
const url = new URL(event.request.url);
if (event.request.method !== 'GET') return;
if (url.origin !== self.location.origin) return;

event.respondWith(
fetch(event.request)
.then((response) => {
const copy = response.clone();
caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
return response;
})
.catch(() => caches.match(event.request))
);
});
