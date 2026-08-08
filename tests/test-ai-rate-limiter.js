// ============================================================
// GAMECHANGE — tests/test-ai-rate-limiter.js
// ============================================================
// NOWY PLIK (08.08.2026, runda 19 — sesja główna). Testuje wspólną bramkę
// kosztową `lib/ai-rate-limiter.js` ORAZ jej wpięcie w cztery endpointy AI.
//
// PO CO OSOBNY PLIK, skoro limit dozowania ma już testy w
// tests/test-generate-focus-block-dosing.js (sekcja „LIMIT R13"): tamte
// pilnują JEDNEGO endpointu i zostają nietknięte jako świadek, że runda 19
// niczego w dozowaniu nie przesunęła. Ten plik pilnuje rzeczy, których tamte
// z definicji nie widzą — że limit ma KAŻDY endpoint wołający model, że
// budżety się nie mieszają, że adres zawodnika nigdy nie ląduje w kluczu
// jawnym tekstem i że cron przechodzi bokiem, bez bramki.
//
// ZAKRES ŚWIADOMIE POMINIĘTY: ścieżki sukcesu wołające Anthropic (ten sam
// zakres co w pozostałych testach projektu — wymagałyby prawdziwego klucza
// albo atrapy fetch). Wszystkie scenariusze niżej rozstrzygają się PRZED
// jakimkolwiek wywołaniem sieciowym, bo bramka z definicji stoi przed nim.
//
// Uruchomienie: node tests/test-ai-rate-limiter.js
// ============================================================

const assert = require('assert');
const path = require('path');

const {
  makeRateLimiter,
  rateLimitKey,
  respondRateLimited,
  pruneAndCheckRateLimit,
  _internal: { MNOZNIK_KUBLA_WSPOLNEGO, PREFIKS_WSPOLNY, odczytajAdres },
} = require('../lib/ai-rate-limiter.js');

let passed = 0;
let failed = 0;
async function scenario(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL — ${name}`);
    console.error(`    ${e.stack || e.message}`);
  }
}

const MIN10 = 10 * 60 * 1000;

// ------------------------------------------------------------
// Atrapa odpowiedzi HTTP — zbiera to, co handler by wysłał.
// ------------------------------------------------------------
function makeRes() {
  const r = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return r;
}

// Świeży moduł endpointu = świeży licznik w pamięci (limiter jest stanem
// modułu, dokładnie jak na Vercelu przy zimnym starcie). Bez tego drugi
// scenariusz dziedziczyłby zużyty budżet po pierwszym.
function swiezyEndpoint(wzgledna) {
  const pelna = require.resolve(path.join(__dirname, '..', wzgledna));
  delete require.cache[pelna];
  return require(pelna);
}

// Wyciszenie console.warn na czas scenariusza (bramka loguje każdą odmowę —
// w logu testu to szum, a chcemy jeszcze sprawdzić TREŚĆ tych logów).
function przechwycWarn(fn) {
  const oryg = console.warn;
  const zebrane = [];
  console.warn = (...a) => zebrane.push(a.join(' '));
  try {
    return { wynik: fn(), zebrane };
  } finally {
    console.warn = oryg;
  }
}
async function przechwycWarnAsync(fn) {
  const oryg = console.warn;
  const zebrane = [];
  console.warn = (...a) => zebrane.push(a.join(' '));
  try {
    const wynik = await fn();
    return { wynik, zebrane };
  } finally {
    console.warn = oryg;
  }
}

(async () => {
  console.log('lib/ai-rate-limiter.js — bramka kosztowa endpointów AI (runda 19)');

  // ==========================================================
  console.log('\n1. pruneAndCheckRateLimit — czysta logika okna (fałszywy zegar)');
  // ==========================================================

  await scenario('przepuszcza dokładnie `max` wywołań, kolejne odmawia', () => {
    let entries = [];
    for (let i = 0; i < 3; i++) {
      const w = pruneAndCheckRateLimit(entries, 1000 + i, 3, MIN10);
      assert.strictEqual(w.allowed, true, `wywołanie ${i + 1} powinno przejść`);
      entries = w.fresh;
    }
    const czwarte = pruneAndCheckRateLimit(entries, 1003, 3, MIN10);
    assert.strictEqual(czwarte.allowed, false);
    assert.ok(czwarte.retryAfterS > 0, 'odmowa musi nieść czas odczekania');
  });

  await scenario('odrzucone wywołanie NIE przedłuża blokady (stukanie w przycisk się odblokuje)', () => {
    let entries = [];
    for (let i = 0; i < 3; i++) entries = pruneAndCheckRateLimit(entries, i, 3, MIN10).fresh;
    // Dwadzieścia odbić od bramki — lista nie może urosnąć.
    for (let i = 0; i < 20; i++) {
      const w = pruneAndCheckRateLimit(entries, 5000 + i, 3, MIN10);
      assert.strictEqual(w.allowed, false);
      entries = w.fresh;
    }
    assert.strictEqual(entries.length, 3, 'odmowy nie dopisują się do okna');
    const po = pruneAndCheckRateLimit(entries, MIN10 + 1, 3, MIN10);
    assert.strictEqual(po.allowed, true, 'po wyjściu okna limit puszcza');
  });

  await scenario('wpisy starsze niż okno są zapominane', () => {
    const stare = [0, 1, 2];
    const w = pruneAndCheckRateLimit(stare, MIN10 + 100, 3, MIN10);
    assert.strictEqual(w.allowed, true);
    assert.strictEqual(w.fresh.length, 1, 'zostaje tylko bieżące wywołanie');
  });

  await scenario('retryAfterS liczony od NAJSTARSZEGO wpisu i nigdy nie jest zerem', () => {
    const w = pruneAndCheckRateLimit([0, 1000, 2000], MIN10 - 500, 3, MIN10);
    assert.strictEqual(w.allowed, false);
    assert.strictEqual(w.retryAfterS, 1, 'pół sekundy do końca okna -> 1 s, nie 0');
  });

  await scenario('śmieci zamiast listy (null/undefined/liczba) traktowane jak pusta lista', () => {
    for (const smiec of [null, undefined, 42, 'abc', {}]) {
      const w = pruneAndCheckRateLimit(smiec, 1000, 3, MIN10);
      assert.strictEqual(w.allowed, true, `wejście ${String(smiec)} nie może wywalić bramki`);
      assert.deepStrictEqual(w.fresh, [1000]);
    }
  });

  // ==========================================================
  console.log('\n2. makeRateLimiter — budżety, izolacja, bezpiecznik pamięci');
  // ==========================================================

  await scenario('brak nazwy / zły budżet -> rzuca przy tworzeniu, nie po cichu na produkcji', () => {
    assert.throws(() => makeRateLimiter({ max: 3, windowMs: MIN10 }), /brak nazwy/);
    assert.throws(() => makeRateLimiter({ nazwa: 'x', max: 0, windowMs: MIN10 }), /max/);
    assert.throws(() => makeRateLimiter({ nazwa: 'x', max: 3, windowMs: 0 }), /windowMs/);
  });

  await scenario('stan jest per klucz — jeden zawodnik nie blokuje drugiego', () => {
    const l = makeRateLimiter({ nazwa: 't', max: 2, windowMs: MIN10 });
    assert.strictEqual(l.check('u:a', 0).allowed, true);
    assert.strictEqual(l.check('u:a', 1).allowed, true);
    assert.strictEqual(l.check('u:a', 2).allowed, false);
    assert.strictEqual(l.check('u:b', 2).allowed, true, 'inny zawodnik nie dziedziczy blokady');
  });

  await scenario('dwa limitery = dwa osobne budżety (ruch w Celach nie zjada Bloku)', () => {
    const a = makeRateLimiter({ nazwa: 'cele', max: 1, windowMs: MIN10 });
    const b = makeRateLimiter({ nazwa: 'blok', max: 1, windowMs: MIN10 });
    assert.strictEqual(a.check('u:x', 0).allowed, true);
    assert.strictEqual(a.check('u:x', 1).allowed, false);
    assert.strictEqual(b.check('u:x', 1).allowed, true, 'drugi endpoint ma własny licznik');
  });

  await scenario('bezpiecznik pamięci: mapa nie rośnie ponad maxSledzonych', () => {
    const l = makeRateLimiter({ nazwa: 't', max: 3, windowMs: MIN10, maxSledzonych: 50 });
    for (let i = 0; i < 50; i++) l.check('u:' + i, 0);
    const w = l.check('nowy', MIN10 + 1);
    assert.strictEqual(w.allowed, true, 'nowy zawodnik po sprzątaniu przechodzi');
    assert.ok(l.state.size <= 50, `mapa urosła do ${l.state.size}`);
  });

  await scenario('bezpiecznik pamięci: gdy sprzątanie nie wystarcza, mapa jest czyszczona w całości (limit łagodnieje, nie twardnieje)', () => {
    const l = makeRateLimiter({ nazwa: 't', max: 3, windowMs: MIN10, maxSledzonych: 10 });
    for (let i = 0; i < 10; i++) l.check('u:' + i, 1000); // wszystkie ŚWIEŻE
    const w = l.check('nowy', 1001);
    assert.strictEqual(w.allowed, true);
    assert.ok(l.state.size <= 10, `mapa urosła do ${l.state.size}`);
  });

  await scenario('kubeł wspólny (brak jakiegokolwiek identyfikatora) ma budżet ×10 — awaria nagłówków spowalnia, nie wyłącza endpointu', () => {
    const l = makeRateLimiter({ nazwa: 't', max: 2, windowMs: MIN10 });
    const klucz = PREFIKS_WSPOLNY + 'brak-adresu';
    assert.strictEqual(l.maxDlaKlucza(klucz), 2 * MNOZNIK_KUBLA_WSPOLNEGO);
    for (let i = 0; i < 2 * MNOZNIK_KUBLA_WSPOLNEGO; i++) {
      assert.strictEqual(l.check(klucz, i).allowed, true, `wywołanie ${i + 1} we wspólnym kuble`);
    }
    assert.strictEqual(l.check(klucz, 999).allowed, false, 'sufit istnieje także we wspólnym kuble');
  });

  await scenario('reset() czyści stan (zimny start Vercela w miniaturze)', () => {
    const l = makeRateLimiter({ nazwa: 't', max: 1, windowMs: MIN10 });
    l.check('u:a', 0);
    assert.strictEqual(l.check('u:a', 1).allowed, false);
    l.reset();
    assert.strictEqual(l.check('u:a', 2).allowed, true);
  });

  // ==========================================================
  console.log('\n3. rateLimitKey — kolejność źródeł i ochrona adresu');
  // ==========================================================

  await scenario('jawny identyfikator wygrywa z adresem', () => {
    const req = { headers: { 'x-real-ip': '1.2.3.4' } };
    assert.strictEqual(rateLimitKey(req, 'zawodnik-7'), 'u:zawodnik-7');
  });

  await scenario('identyfikator pusty / same spacje / null -> schodzimy na adres', () => {
    const req = { headers: { 'x-real-ip': '1.2.3.4' } };
    for (const zly of ['', '   ', null, undefined]) {
      assert.ok(rateLimitKey(req, zly).startsWith('ip:'), `identyfikator ${JSON.stringify(zly)} nie może być kluczem`);
    }
  });

  await scenario('x-real-ip ma pierwszeństwo przed x-forwarded-for (ten pierwszy ustawia platforma)', () => {
    const zReal = rateLimitKey({ headers: { 'x-real-ip': '5.5.5.5', 'x-forwarded-for': '9.9.9.9' } });
    const samReal = rateLimitKey({ headers: { 'x-real-ip': '5.5.5.5' } });
    assert.strictEqual(zReal, samReal, 'podrobiony x-forwarded-for nie zmienia kubła');
  });

  await scenario('z x-forwarded-for bierzemy TYLKO pierwszy skok', () => {
    const a = rateLimitKey({ headers: { 'x-forwarded-for': '7.7.7.7, 10.0.0.1, 10.0.0.2' } });
    const b = rateLimitKey({ headers: { 'x-forwarded-for': '7.7.7.7' } });
    assert.strictEqual(a, b, 'zmiana łańcucha pośredników nie może zmieniać kubła');
  });

  await scenario('x-forwarded-for podany jako tablica też działa', () => {
    assert.strictEqual(odczytajAdres({ headers: { 'x-forwarded-for': ['3.3.3.3'] } }), '3.3.3.3');
  });

  await scenario('brak nagłówków w ogóle (także req bez pola headers) -> kubeł wspólny, nigdy wyjątek', () => {
    assert.strictEqual(rateLimitKey({}), PREFIKS_WSPOLNY + 'brak-adresu');
    assert.strictEqual(rateLimitKey(undefined), PREFIKS_WSPOLNY + 'brak-adresu');
    assert.strictEqual(rateLimitKey({ headers: {} }), PREFIKS_WSPOLNY + 'brak-adresu');
  });

  await scenario('ADRES NIGDY NIE WYSTĘPUJE W KLUCZU JAWNYM TEKSTEM (dane osobowe nieletnich)', () => {
    const adres = '83.24.117.201';
    const klucz = rateLimitKey({ headers: { 'x-real-ip': adres } });
    assert.ok(!klucz.includes(adres), `adres wyciekł do klucza: ${klucz}`);
    assert.ok(!klucz.includes('83.24'), 'nawet fragment adresu nie może być w kluczu');
    assert.match(klucz, /^ip:[0-9a-f]{16}$/, 'klucz to skrót o stałej długości');
  });

  await scenario('ten sam adres -> ten sam kubeł; inny adres -> inny kubeł', () => {
    const a1 = rateLimitKey({ headers: { 'x-real-ip': '1.1.1.1' } });
    const a2 = rateLimitKey({ headers: { 'x-real-ip': '1.1.1.1' } });
    const b = rateLimitKey({ headers: { 'x-real-ip': '2.2.2.2' } });
    assert.strictEqual(a1, a2);
    assert.notStrictEqual(a1, b);
  });

  // ==========================================================
  console.log('\n4. respondRateLimited — jeden kształt odmowy dla wszystkich endpointów');
  // ==========================================================

  await scenario('429 + nagłówek Retry-After + retryAfterSeconds w treści', () => {
    const res = makeRes();
    const l = makeRateLimiter({ nazwa: 'cele', max: 1, windowMs: MIN10 });
    const { zebrane } = przechwycWarn(() =>
      respondRateLimited(res, { limiter: l, limit: { allowed: false, retryAfterS: 240 }, klucz: 'u:x', komunikat: 'Spróbuj później.' })
    );
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.headers['Retry-After'], '240');
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.retryAfterSeconds, 240);
    assert.strictEqual(res.body.error, 'Spróbuj później.');
    assert.strictEqual(zebrane.length, 1, 'każda odmowa zostawia dokładnie jeden ślad w logu');
  });

  await scenario('brak komunikatu -> sensowna treść domyślna z liczbą minut', () => {
    const res = makeRes();
    const l = makeRateLimiter({ nazwa: 'cele', max: 1, windowMs: MIN10 });
    przechwycWarn(() => respondRateLimited(res, { limiter: l, limit: { allowed: false, retryAfterS: 61 }, klucz: 'u:x' }));
    assert.match(res.body.error, /2 min/, 'zaokrąglamy w górę: 61 s to "2 min"');
  });

  await scenario('LOG nie zawiera całego klucza — tylko jego typ (skrót adresu nie idzie do logów)', () => {
    const l = makeRateLimiter({ nazwa: 'cele', max: 1, windowMs: MIN10 });
    const klucz = rateLimitKey({ headers: { 'x-real-ip': '4.4.4.4' } });
    const { zebrane } = przechwycWarn(() =>
      respondRateLimited(makeRes(), { limiter: l, limit: { allowed: false, retryAfterS: 10 }, klucz })
    );
    const log = zebrane.join('\n');
    assert.ok(!log.includes(klucz.split(':')[1]), `skrót adresu wyciekł do logu: ${log}`);
    assert.match(log, /typ klucza=ip/, 'log ma pozwolić odróżnić jeden natrętny adres od wielu zawodników');
    assert.match(log, /limit-ai:cele/, 'log niesie nazwę endpointu');
  });

  await scenario('res bez setHeader (nietypowa atrapa) nie wywala odmowy', () => {
    const kaleki = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
    przechwycWarn(() => respondRateLimited(kaleki, { limiter: makeRateLimiter({ nazwa: 't', max: 1, windowMs: MIN10 }), limit: { allowed: false, retryAfterS: 5 }, klucz: 'u:x' }));
    assert.strictEqual(kaleki.statusCode, 429);
  });

  // ==========================================================
  console.log('\n5. WPIĘCIE W ENDPOINTY — każdy endpoint wołający model ma bramkę');
  // ==========================================================

  await scenario('validate-goal-refinement: 6 wywołań przechodzi bramkę, 7. dostaje 429', async () => {
    const handler = swiezyEndpoint('api/validate-goal-refinement.js');
    const req = { method: 'POST', headers: { 'x-real-ip': '11.11.11.11' }, body: { segmentId: 'moc', text: 'x' } };
    const { zebrane } = await przechwycWarnAsync(async () => {
      for (let i = 0; i < 6; i++) {
        const res = makeRes();
        await handler(req, res);
        assert.notStrictEqual(res.statusCode, 429, `wywołanie ${i + 1} nie powinno być odrzucone przez limit`);
      }
      const res7 = makeRes();
      await handler(req, res7);
      assert.strictEqual(res7.statusCode, 429, 'siódme wywołanie musi trafić na bramkę');
      assert.ok(res7.headers['Retry-After'], 'odmowa niesie Retry-After');
      assert.match(res7.body.error, /nigdy nie blokuje zapisu/, 'komunikat ma uspokoić zawodnika, nie zawstydzić');
    });
    assert.strictEqual(zebrane.length, 1);
  });

  await scenario('validate-goal-refinement: bramka stoi PRZED wywołaniem modelu (odmowa nie potrzebuje klucza API)', async () => {
    const handler = swiezyEndpoint('api/validate-goal-refinement.js');
    const staryKlucz = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const req = { method: 'POST', headers: { 'x-real-ip': '12.12.12.12' }, body: { segmentId: 'moc', text: 'x' } };
      await przechwycWarnAsync(async () => {
        for (let i = 0; i < 6; i++) await handler(req, makeRes());
        const res = makeRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 429, 'bez klucza API i tak dostajemy 429, nie 400 — bramka jest pierwsza');
      });
    } finally {
      if (staryKlucz !== undefined) process.env.ANTHROPIC_API_KEY = staryKlucz;
    }
  });

  await scenario('validate-goal-refinement: dwa różne adresy mają osobne budżety', async () => {
    const handler = swiezyEndpoint('api/validate-goal-refinement.js');
    const body = { segmentId: 'moc', text: 'x' };
    await przechwycWarnAsync(async () => {
      for (let i = 0; i < 7; i++) await handler({ method: 'POST', headers: { 'x-real-ip': '20.0.0.1' }, body }, makeRes());
      const res = makeRes();
      await handler({ method: 'POST', headers: { 'x-real-ip': '20.0.0.2' }, body }, res);
      assert.notStrictEqual(res.statusCode, 429, 'drugi zawodnik nie dziedziczy blokady pierwszego');
    });
  });

  await scenario('generate-focus-block-content: 5 przechodzi, 6. dostaje 429', async () => {
    const mod = swiezyEndpoint('api/generate-focus-block-content.js');
    const req = { method: 'POST', headers: { 'x-real-ip': '13.13.13.13' }, body: { action: 'checkin', focusBlockId: 'fb-1' } };
    await przechwycWarnAsync(async () => {
      for (let i = 0; i < 5; i++) {
        const res = makeRes();
        await mod(req, res);
        assert.notStrictEqual(res.statusCode, 429, `wywołanie ${i + 1}`);
      }
      const res6 = makeRes();
      await mod(req, res6);
      assert.strictEqual(res6.statusCode, 429);
    });
  });

  await scenario('generate-focus-block-content: bramka jest PRZED walidacją focusBlockId (odbicie się od 400 nie jest darmowe)', async () => {
    const mod = swiezyEndpoint('api/generate-focus-block-content.js');
    const req = { method: 'POST', headers: { 'x-real-ip': '14.14.14.14' }, body: { action: 'checkin' } }; // brak focusBlockId
    await przechwycWarnAsync(async () => {
      for (let i = 0; i < 5; i++) {
        const res = makeRes();
        await mod(req, res);
        assert.strictEqual(res.statusCode, 400, 'brak focusBlockId to nadal 400');
      }
      const res6 = makeRes();
      await mod(req, res6);
      assert.strictEqual(res6.statusCode, 429, 'szóste puste żądanie odbija się od bramki, nie od walidacji');
    });
  });

  await scenario('generate-focus-block-content: metoda != POST nadal 405 (bramka nie zmienia kontraktu)', async () => {
    const mod = swiezyEndpoint('api/generate-focus-block-content.js');
    const res = makeRes();
    await mod({ method: 'GET', headers: {}, body: {} }, res);
    assert.strictEqual(res.statusCode, 405);
  });

  await scenario('generate-focus-block-content: CRON omija bramkę — funkcje robocze nadal w _internal, dokładnie pod nazwą, po którą sięga cron', () => {
    const mod = swiezyEndpoint('api/generate-focus-block-content.js');
    // Lustro linii z api/cron-send-notifications.js (runFocusBlockCheckins):
    //   const { generateCheckin } = require('./generate-focus-block-content')._internal;
    assert.strictEqual(typeof mod._internal.generateCheckin, 'function', 'cron woła generateCheckin bezpośrednio, z pominięciem HTTP i bramki');
    assert.strictEqual(typeof mod._internal.generateClosingReview, 'function');
  });

  await scenario('generate-coach-tip: 8 przechodzi, 9. dostaje 429', async () => {
    const mod = swiezyEndpoint('api/generate-coach-tip.js');
    const req = { method: 'POST', headers: { 'x-real-ip': '15.15.15.15' }, body: { coachUserId: 'trener-1', teamId: 't-1', unitType: 'trening' } };
    await przechwycWarnAsync(async () => {
      for (let i = 0; i < 8; i++) {
        const res = makeRes();
        await mod(req, res);
        assert.notStrictEqual(res.statusCode, 429, `wywołanie ${i + 1}`);
      }
      const res9 = makeRes();
      await mod(req, res9);
      assert.strictEqual(res9.statusCode, 429);
    });
  });

  await scenario('generate-coach-tip: dwaj trenerzy = dwa budżety (klucz po coachUserId, nie po wspólnym adresie panelu)', async () => {
    const mod = swiezyEndpoint('api/generate-coach-tip.js');
    const headers = { 'x-real-ip': '16.16.16.16' }; // ten sam adres!
    await przechwycWarnAsync(async () => {
      for (let i = 0; i < 9; i++) {
        await mod({ method: 'POST', headers, body: { coachUserId: 'trener-A', teamId: 't', unitType: 'trening' } }, makeRes());
      }
      const res = makeRes();
      await mod({ method: 'POST', headers, body: { coachUserId: 'trener-B', teamId: 't', unitType: 'trening' } }, res);
      assert.notStrictEqual(res.statusCode, 429, 'drugi trener z tej samej sieci nie dziedziczy blokady');
    });
  });

  await scenario('generate-coach-tip: ścieżka submit_feedback NIE przechodzi przez bramkę AI (nie woła modelu)', async () => {
    const mod = swiezyEndpoint('api/generate-coach-tip.js');
    const req = { method: 'POST', headers: { 'x-real-ip': '17.17.17.17' }, body: { action: 'submit_feedback', coachUserId: 'c', tipId: 't', response: 'useful' } };
    await przechwycWarnAsync(async () => {
      for (let i = 0; i < 12; i++) {
        const res = makeRes();
        // Bez zmiennych Supabase ta ścieżka rzuca — i DOBRZE: sam fakt, że
        // doszła do klienta bazy, dowodzi, że nie zawróciła jej bramka AI.
        try {
          await mod(req, res);
        } catch (e) {
          assert.match(e.message, /SUPABASE/, `feedback ${i + 1} rzucił z innego powodu niż brak bazy: ${e.message}`);
          continue;
        }
        assert.notStrictEqual(res.statusCode, 429, `feedback ${i + 1} nie może być limitowany bramką AI`);
      }
    });
  });

  await scenario('generate-focus-block-dosing: budżet z rundy 13 bez zmian — 3 przechodzą, 4. to 429', async () => {
    const mod = swiezyEndpoint('api/generate-focus-block-dosing.js');
    const req = { method: 'POST', headers: { 'x-real-ip': '18.18.18.18' }, body: { userId: 'zawodnik-1', segmentId: 'moc' } };
    await przechwycWarnAsync(async () => {
      for (let i = 0; i < 3; i++) {
        const res = makeRes();
        await mod(req, res);
        assert.notStrictEqual(res.statusCode, 429, `wywołanie ${i + 1}`);
      }
      const res4 = makeRes();
      await mod(req, res4);
      assert.strictEqual(res4.statusCode, 429);
      assert.match(res4.body.error, /Sugestia dozowania sprzed chwili/, 'komunikat dozowania zachowany co do brzmienia');
    });
  });

  await scenario('generate-focus-block-dosing: DZIURA ZAMKNIĘTA — wywołanie BEZ userId też ma sufit (dawniej przechodziło bez limitu)', async () => {
    const mod = swiezyEndpoint('api/generate-focus-block-dosing.js');
    const req = { method: 'POST', headers: { 'x-real-ip': '19.19.19.19' }, body: { segmentId: 'moc' } }; // brak userId
    await przechwycWarnAsync(async () => {
      for (let i = 0; i < 3; i++) await mod(req, makeRes());
      const res = makeRes();
      await mod(req, res);
      assert.strictEqual(res.statusCode, 429, 'anonimowe stukanie w dozowanie nie może być darmowe');
    });
  });

  await scenario('KOMPLET: każdy plik w api/ wołający api.anthropic.com wymaga lib/ai-rate-limiter (kontrola przez odczyt źródła)', () => {
    const fs = require('fs');
    const katalog = path.join(__dirname, '..', 'api');
    const bezBramki = [];
    for (const plik of fs.readdirSync(katalog).filter((f) => f.endsWith('.js'))) {
      const zrodlo = fs.readFileSync(path.join(katalog, plik), 'utf8');
      if (!zrodlo.includes('api.anthropic.com')) continue;
      const maBramke = zrodlo.includes("require('../lib/ai-rate-limiter");
      // generate-recommendation.js jest chroniony sekretem backend-do-backend
      // (x-engine-secret) — tam bramka kosztowa byłaby limitem na własny cron.
      const maSekret = zrodlo.includes('DECISION_ENGINE_SECRET');
      if (!maBramke && !maSekret) bezBramki.push(plik);
    }
    assert.deepStrictEqual(bezBramki, [], `endpointy AI bez żadnej ochrony: ${bezBramki.join(', ')}`);
  });

  console.log(`\n[pomiar] budżety rundy 19: dozowanie 3/10 min · Blok (treść) 5/10 min · Cele 6/10 min · trener 8/10 min; kubeł wspólny ×${MNOZNIK_KUBLA_WSPOLNEGO}. Stan w pamięci instancji — limit bywa łagodniejszy (zimny start, wiele instancji), nigdy surowszy.`);

  console.log('');
  if (failed > 0) {
    console.error(`NIEPOWODZENIA: ${failed} (zaliczone: ${passed}).`);
    process.exit(1);
  }
  console.log(`WSZYSTKIE TESTY PRZESZŁY (${passed}).`);
})();
