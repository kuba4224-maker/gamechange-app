// ============================================================
// GAMECHANGE — lib/ai-rate-limiter.js
// ============================================================
// NOWY PLIK (08.08.2026, runda 19 — sesja główna). Wspólna bramka kosztowa
// dla WSZYSTKICH endpointów wołających model. Powód powstania:
//
//   Audyt po rundzie 18 (przegląd folderu api/) pokazał, że z pięciu miejsc
//   wołających api.anthropic.com limit miało DOKŁADNIE JEDNO:
//     - api/generate-focus-block-dosing.js .... 3 wywołania / 10 min / zawodnik  (runda 13, M24)
//     - api/generate-recommendation.js ........ chroniony sekretem x-engine-secret (backend-do-backend)
//     - api/generate-focus-block-content.js ... BEZ ŻADNEGO LIMITU  ← dziura
//     - api/validate-goal-refinement.js ....... BEZ ŻADNEGO LIMITU, w pełni anonimowy  ← dziura
//     - api/generate-coach-tip.js ............. BEZ LIMITU (akcje AI)  ← dziura
//
//   Rachunek z EKONOMIKA_JEDNOSTKOWA_R16: uczciwy zawodnik kosztuje ~1,5 zł
//   AI miesięcznie, a ta sama ścieżka bez limitu ~19 zł. Otwarty endpoint AI
//   to nie tylko rachunek — to wektor, którym obca osoba zamienia klucz
//   projektu na własne wywołania modelu.
//
// CZYM TO NIE JEST: to NIE jest kontrola dostępu ani uwierzytelnianie.
// To bramka kosztowa — ma sprawić, że nadużycie jest wolne i drogie, a nie
// niemożliwe. Uwierzytelnianie endpointów appki (sekret/JWT) to osobna,
// otwarta decyzja Kuby (patrz „sekret AI" w KOLEJCE DECYZJI).
//
// TRZY ŚWIADOME OGRANICZENIA (spisane, żeby nikt nie brał ich za błąd):
//  1. Stan żyje w PAMIĘCI INSTANCJI (ta sama technika co limit z rundy 13).
//     Zimny start Vercela zeruje licznik, a przy wielu instancjach limit jest
//     per instancja. Efekt jest zawsze w jedną stronę: limit bywa ŁAGODNIEJSZY,
//     nigdy surowszy. Wersja „twarda" wymagałaby tabeli w bazie (jak
//     push_send_log dla pushy) — świadomie nie teraz: to zapis na każde
//     kliknięcie w appce, a limit z pamięci wycina 99% realnego nadużycia
//     (skrypt w pętli z jednej maszyny) przy zerowym koszcie.
//  2. Adres z nagłówka jest BEST-EFFORT. Na Vercelu `x-real-ip` ustawia proxy
//     platformy i klient go nie nadpisze; `x-forwarded-for` bierzemy tylko
//     jako zapas i tylko PIERWSZY skok. Poza Vercelem nagłówek da się podrobić
//     — patrz zdanie „to nie kontrola dostępu" wyżej.
//  3. Adresu NIGDY nie trzymamy ani nie logujemy w postaci jawnej. Kluczem
//     jest skrót SHA-256 z solą losowaną przy starcie procesu (sól nie
//     wychodzi poza instancję, więc skróty są nieporównywalne między
//     instancjami i nieodwracalne po restarcie). To dane osobowe zawodników
//     — także tych nieletnich — i mają tu żyć możliwie krótko i w postaci
//     nienadającej się do śledzenia.
//
// UŻYCIE (wzorzec z api/generate-focus-block-dosing.js):
//
//   const { makeRateLimiter, rateLimitKey, respondRateLimited } = require('../lib/ai-rate-limiter');
//   const limiter = makeRateLimiter({ nazwa: 'cele', max: 6, windowMs: 10 * 60 * 1000 });
//   ...
//   const limit = limiter.check(rateLimitKey(req, userId));
//   if (!limit.allowed) return respondRateLimited(res, { limiter, limit, komunikat: '…' });
//
// WAŻNE: bramka siedzi WYŁĄCZNIE w handlerze HTTP, nigdy w funkcji roboczej.
// Crony wołają funkcje bezpośrednio (np. runFocusBlockCheckins) i mają
// własne budżety (MAX_PER_RUN) — limit HTTP nie może ich dotykać.
// ============================================================

const crypto = require('crypto');

// Bezpiecznik pamięci instancji: ile najwyżej kluczy trzymamy naraz.
const DOMYSLNY_MAX_SLEDZONYCH = 500;

// Mnożnik dla kubła wspólnego (żądania bez ŻADNEGO identyfikatora — ani
// userId, ani adresu). Gdyby platforma przestała podawać nagłówki, wszyscy
// wpadliby do jednego kubła i zwykły limit wyłączyłby endpoint dla całego
// świata. Mnożnik zamienia tę awarię w spowolnienie: nadużycie nadal ma
// sufit, ale zwykły ruch przechodzi.
const MNOZNIK_KUBLA_WSPOLNEGO = 10;

const PREFIKS_WSPOLNY = 'wspolny:';

// Sól losowana raz na proces — patrz ograniczenie 3 w nagłówku.
const SOL_ADRESU = crypto.randomBytes(16).toString('hex');

// ------------------------------------------------------------
// CZYSTA LOGIKA OKNA — przeniesiona 1:1 z api/generate-focus-block-dosing.js
// (runda 13, M24). Testowalna z fałszywym zegarem, bez stanu i bez I/O.
//
// `fresh` przy odmowie NIE zawiera bieżącej próby — odrzucone wywołanie
// nie przedłuża blokady (inaczej stukanie w przycisk nigdy by się nie
// odblokowało).
// ------------------------------------------------------------
function pruneAndCheckRateLimit(entries, nowMs, max, windowMs) {
  const fresh = (Array.isArray(entries) ? entries : []).filter((t) => nowMs - t < windowMs);
  if (fresh.length >= max) {
    const retryAfterS = Math.max(1, Math.ceil((windowMs - (nowMs - fresh[0])) / 1000));
    return { allowed: false, fresh, retryAfterS };
  }
  return { allowed: true, fresh: [...fresh, nowMs], retryAfterS: 0 };
}

// ------------------------------------------------------------
// FABRYKA LIMITERA — każdy endpoint dostaje własny, nazwany, z własnym
// budżetem i własną mapą stanu (żeby ruch w jednym nie zjadał budżetu
// drugiego).
// ------------------------------------------------------------
function makeRateLimiter({ nazwa, max, windowMs, maxSledzonych = DOMYSLNY_MAX_SLEDZONYCH }) {
  if (!nazwa) throw new Error('makeRateLimiter: brak nazwy limitera');
  if (!(max > 0)) throw new Error(`makeRateLimiter(${nazwa}): max musi być dodatnie`);
  if (!(windowMs > 0)) throw new Error(`makeRateLimiter(${nazwa}): windowMs musi być dodatnie`);

  const stanWlasny = new Map();

  function maxDlaKlucza(key) {
    return String(key).startsWith(PREFIKS_WSPOLNY) ? max * MNOZNIK_KUBLA_WSPOLNEGO : max;
  }

  // `state` wstrzykiwalny wyłącznie po to, żeby test mógł podać własną mapę.
  function check(key, nowMs = Date.now(), state = stanWlasny) {
    const k = String(key);

    // Zanim dopiszemy nowy klucz, wyrzucamy przeterminowane; gdy to nie
    // wystarcza — czyścimy całość (limit łagodnieje, pamięć nie rośnie).
    if (!state.has(k) && state.size >= maxSledzonych) {
      for (const [kk, vv] of state) {
        if (vv.every((t) => nowMs - t >= windowMs)) state.delete(kk);
      }
      if (state.size >= maxSledzonych) state.clear();
    }

    const wynik = pruneAndCheckRateLimit(state.get(k), nowMs, maxDlaKlucza(k), windowMs);
    state.set(k, wynik.fresh);
    return wynik;
  }

  function reset(state = stanWlasny) {
    state.clear();
  }

  return { nazwa, max, windowMs, maxSledzonych, check, reset, state: stanWlasny, maxDlaKlucza };
}

// ------------------------------------------------------------
// KLUCZ LIMITU — kolejność jest celowa:
//   1. jawny identyfikator (userId / coachUserId) — najuczciwszy,
//   2. adres z nagłówka platformy (skrót z solą),
//   3. kubeł wspólny (patrz MNOZNIK_KUBLA_WSPOLNEGO).
// ------------------------------------------------------------
function odczytajAdres(req) {
  const h = (req && req.headers) || {};
  const realIp = h['x-real-ip'] || h['X-Real-IP'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();

  const xff = h['x-forwarded-for'] || h['X-Forwarded-For'];
  const surowy = Array.isArray(xff) ? xff[0] : xff;
  if (typeof surowy === 'string' && surowy.trim()) {
    // Tylko PIERWSZY skok — reszta łańcucha to pośrednicy.
    const pierwszy = surowy.split(',')[0].trim();
    if (pierwszy) return pierwszy;
  }
  return null;
}

function rateLimitKey(req, jawnyId) {
  if (jawnyId !== undefined && jawnyId !== null && String(jawnyId).trim()) {
    return `u:${String(jawnyId).trim()}`;
  }
  const adres = odczytajAdres(req);
  if (!adres) return `${PREFIKS_WSPOLNY}brak-adresu`;
  const skrot = crypto.createHash('sha256').update(SOL_ADRESU + adres).digest('hex').slice(0, 16);
  return `ip:${skrot}`;
}

// ------------------------------------------------------------
// ODPOWIEDŹ 429 — jeden kształt dla wszystkich endpointów (ten sam co
// dozowanie z rundy 13, żeby appka miała jedną ścieżkę obsługi).
// W logu NIGDY nie ląduje klucz `ip:` w całości — tylko jego prefiks,
// żeby dało się odróżnić „jeden natrętny adres" od „wielu zawodników".
// ------------------------------------------------------------
function respondRateLimited(res, { limiter, limit, komunikat, klucz }) {
  const minuty = Math.ceil(limit.retryAfterS / 60);
  const etykietaKlucza = klucz ? String(klucz).split(':')[0] : 'nieznany';
  console.warn(
    `[limit-ai:${limiter.nazwa}] odmowa — typ klucza=${etykietaKlucza}, ` +
    `budżet ${limiter.max}/${Math.round(limiter.windowMs / 60000)} min, retryAfterS=${limit.retryAfterS}.`
  );
  if (res && typeof res.setHeader === 'function') {
    res.setHeader('Retry-After', String(limit.retryAfterS));
  }
  return res.status(429).json({
    ok: false,
    error: komunikat || `Za dużo prób w krótkim czasie. Spróbuj ponownie za ${minuty} min.`,
    retryAfterSeconds: limit.retryAfterS,
  });
}

module.exports = {
  makeRateLimiter,
  rateLimitKey,
  respondRateLimited,
  pruneAndCheckRateLimit,
  _internal: {
    DOMYSLNY_MAX_SLEDZONYCH,
    MNOZNIK_KUBLA_WSPOLNEGO,
    PREFIKS_WSPOLNY,
    odczytajAdres,
  },
};
