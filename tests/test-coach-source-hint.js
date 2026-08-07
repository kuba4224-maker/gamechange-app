// ============================================================
// GAMECHANGE — tests/test-coach-source-hint.js
// ============================================================
// NOWY PLIK (ZRODLO C5, 08.08.2026).
//
// PO CO ISTNIEJE — trzy powody, każdy konkretny:
//
// 1. KONTRAKT MIĘDZY PASAMI. `decision_recommendations.source_hint` jest
//    pisane przez pas A (api/generate-recommendation.js) i czytane tutaj,
//    w panelu trenera. Kontrakt (RAPORT_ZWROTNY_A_RUNDA_4.md, sekcja 11)
//    zawiera trzy PROŚBY, których złamanie nic nie wywali: nie pokazuj
//    `celowanie`, nie pokazuj `wybor`, nie renderuj „s. null". Prośba bez
//    testu to prośba, o której następna sesja się nie dowie.
//
// 2. O9 — panel trenera (~4 000 linii) nie ma ani jednego testu
//    automatycznego, i to jest wprost wskazane jako przyczyna O5 (plik
//    stracił już trzy razy fragmenty przez nadpisanie). Ten plik nie
//    zamyka O9, ale zaczyna go zamykać od tej funkcji, którą ta runda
//    właśnie dołożyła.
//
// 3. O11 — `tests/` wchodzi do pasa sesji, która testowany plik zmienia.
//    Runda 3 napisała 55 scenariuszy dla tego panelu i wszystkie zniknęły
//    razem z sesją, bo nie trafiły na dysk. Ten plik trafia na dysk.
//
// Metoda: blok <script> z coach.html uruchomiony w `vm` na atrapie DOM —
// ten sam wzorzec co tests/test-raport-rodzica.js (runda 4) i ten, którego
// runda 3 użyła dla tego samego pliku.
//
// Uruchomienie: node tests/test-coach-source-hint.js
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_PATH = path.join(__dirname, '..', 'coach.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// ------------------------------------------------------------
// Atrapa DOM — dokładnie tyle, ile potrzeba, żeby blok <script> tego
// pliku wykonał się do końca. `initApp()` na samym dole skryptu jest
// asynchroniczne i odbija się od atrapy Supabase; interesują nas funkcje
// czyste, nie ścieżka logowania.
// ------------------------------------------------------------
function makeElement(id) {
  const classes = new Set();
  const el = {
    id,
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    style: {},
    onclick: null,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    appendChild: () => {},
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute: () => {},
    getAttribute: () => null,
    focus: () => {},
    scrollIntoView: () => {},
  };
  return el;
}

function loadPanel() {
  const elements = new Map();
  for (const m of html.matchAll(/\bid="([a-zA-Z0-9_-]+)"/g)) {
    if (!elements.has(m[1])) elements.set(m[1], makeElement(m[1]));
  }

  const document = {
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    // escapeHtml() w coach.html jest czystym replace()em (nie chodzi przez
    // createElement), ale createElement bywa wołane gdzie indziej.
    createElement: () => makeElement(null),
    body: makeElement('body'),
  };

  const bloki = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.strictEqual(bloki.length, 1, 'coach.html ma mieć dokładnie jeden własny blok <script>');

  const fetchCalls = [];
  const sandbox = {
    document,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { href: '', search: '', hash: '' },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URLSearchParams,
    URL,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
    },
    Date, Number, Array, Object, JSON, Math, Map, Set, String, Boolean, Promise, RegExp, Intl, Error,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signInWithOtp: async () => ({ error: null }),
        signOut: async () => ({ error: null }),
      },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    }),
  };

  vm.createContext(sandbox);
  vm.runInContext(bloki[0], sandbox, { filename: 'coach.html<script>' });
  const stala = (wyrazenie) => vm.runInContext(wyrazenie, sandbox);
  return { sandbox, elements, fetchCalls, stala };
}

// Usuwa komentarze HTML i JS — testy „czego tu nie ma" muszą patrzeć na
// KOD, nie na komentarze, które celowo nazywają rzeczy nieobecne.
function bezKomentarzy(tekst) {
  return tekst
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

let passed = 0;
let failed = 0;
function scenario(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL — ${name}`);
    console.error(`    ${e.stack || e.message}`);
  }
}

const P = loadPanel();
const renderSourceHint = P.sandbox.renderSourceHint;
const parseSourceHint = P.sandbox.parseSourceHint;
const sourceHintOriginText = P.sandbox.sourceHintOriginText;
const renderRecommendationCard = P.sandbox.renderRecommendationCard;

// --- Prawdziwy rekord z kontraktu pasa A (sekcja 11, przykład 1:1) ---
const HINT_PELNY = {
  wersja: 1,
  klucz: 'regeneracja-wyduzenie-snu-nocnego-o-46-113-minut-02',
  tresc: 'Wyznacz stałą godzinę snu i trzymaj się jej codziennie, także w weekendy. Zasypianie o różnych porach działa na organizm jak ciągła zmiana strefy czasowej.',
  material: 'Regeneracja — System Gamechange (pełny)',
  strona: '2',
  rodzaj: 'zrobic',
  celowanie: 'element_celu',
  segment_id: 'regeneracja',
  component_id: '8f2c1d34-9b0a-4e77-a1c5-6d3e5b90aa11',
  wybor: 'wskazana_przez_ai',
  wszystkie_w_promptcie: 2,
};

// Podpowiedź systemowa z decyzji A9 — JEDYNY wiersz w korpusie bez strony.
const HINT_SYSTEMOWY = {
  wersja: 1,
  klucz: 'a9-systemowa-01',
  tresc: 'Dawki suplementów pokazujemy dopiero od 16 lat. To nie jest ocena Twojego zawodnika — to zasada, którą trzymamy dla wszystkich.',
  material: null,
  strona: null,
  rodzaj: 'zrozumiec',
  celowanie: 'segment',
  segment_id: 'regeneracja',
  component_id: null,
  wybor: 'najlepiej_wycelowana',
  wszystkie_w_promptcie: 9,
};

const REKOMENDACJA = {
  id: 'rec-1',
  created_at: '2026-08-06T09:00:00Z',
  recommendation_type: 'training_focus',
  segment_id: 'regeneracja',
  recommendation_text: 'W tym tygodniu popracuj nad rytmem snu.',
  reinforced_by_coach_at: null,
};

console.log('coach.html — source_hint w Centrum Decyzji (blok <script> na atrapie DOM)');

// ============================================================
// 1. TRZY PRZYPADKI, KTÓRE TRENER REALNIE ZOBACZY
// ============================================================
console.log('\n1. Trzy przypadki z zakresu polecenia');

scenario('podpowiedź ze źródłem i stroną -> cytat + „Materiał, s. N"', () => {
  const out = renderSourceHint(HINT_PELNY);
  assert.ok(out.includes('Na czym stoi ta rekomendacja'), 'brak nagłówka sekcji');
  assert.ok(out.includes('Wyznacz stałą godzinę snu'), 'brak treści podpowiedzi');
  assert.ok(
    out.includes('Regeneracja — System Gamechange (pełny), s. 2'),
    'materiał i strona muszą być w jednej linii, przy zdaniu — to jest cały dowód'
  );
});

scenario('podpowiedź BEZ strony (zdanie systemowe) -> zero „s. null", zero „s. —"', () => {
  const out = renderSourceHint(HINT_SYSTEMOWY);
  assert.ok(out.includes('Dawki suplementów pokazujemy dopiero od 16 lat'), 'treść ma się pokazać');
  assert.ok(!/s\.\s*null/i.test(out), 'NIGDY „s. null" — zasada 1 kontraktu pasa A');
  assert.ok(!/s\.\s*—/.test(out), 'NIGDY „s. —"');
  assert.ok(!/s\.\s*undefined/i.test(out), 'NIGDY „s. undefined"');
  assert.ok(!out.includes('gc-source-hint-origin'), 'bez materiału nie ma przypisu w ogóle');
});

scenario('source_hint = NULL -> sekcji NIE MA (nie pusta ramka, nie „brak źródła")', () => {
  assert.strictEqual(renderSourceHint(null), '');
  assert.strictEqual(renderSourceHint(undefined), '');
  assert.strictEqual(renderSourceHint(''), '');
});

// ============================================================
// 2. TRZY PROŚBY Z KONTRAKTU PASA A — sekcja 11
// ============================================================
console.log('\n2. Kontrakt pasa A (RAPORT_ZWROTNY_A_RUNDA_4.md, sekcja 11)');

scenario('NIE pokazujemy pola `celowanie` — to diagnostyka, nie treść', () => {
  const out = renderSourceHint(HINT_PELNY);
  assert.ok(!out.includes('element_celu'), 'wartość `celowanie` wyciekła na ekran');
  assert.ok(!/celowanie/i.test(out), 'nazwa pola `celowanie` wyciekła na ekran');
  // i drugi raz, na wszystkich czterech możliwych wartościach
  for (const v of ['element_celu', 'obszar', 'segment', 'niedopasowany']) {
    const o = renderSourceHint({ ...HINT_PELNY, celowanie: v });
    assert.ok(!o.includes(v), `wartość celowanie=${v} wyciekła`);
  }
});

scenario('NIE pokazujemy pola `wybor` — trener nie ma wiedzieć, czy wskazał ją model', () => {
  for (const v of ['wskazana_przez_ai', 'najlepiej_wycelowana']) {
    const o = renderSourceHint({ ...HINT_PELNY, wybor: v });
    assert.ok(!o.includes(v), `wartość wybor=${v} wyciekła`);
  }
  assert.ok(!/wybor/i.test(renderSourceHint(HINT_PELNY)), 'nazwa pola `wybor` wyciekła');
});

scenario('`tresc` idzie na ekran BEZ obróbki — bez „Wskazówka:", bez skracania', () => {
  const out = renderSourceHint(HINT_PELNY);
  assert.ok(out.includes(HINT_PELNY.tresc), 'treść skrócona albo zmieniona');
  assert.ok(!/Wskazówka:/.test(out), 'dopisany przedrostek — zasada 3 kontraktu');
  assert.ok(!out.includes('…'), 'treść ucięta wielokropkiem');
});

scenario('pozostałe pola diagnostyczne też nie wychodzą na ekran', () => {
  const out = renderSourceHint(HINT_PELNY);
  assert.ok(!out.includes(HINT_PELNY.klucz), '`klucz` to identyfikator, nie treść');
  assert.ok(!out.includes(HINT_PELNY.component_id), '`component_id` to uuid, nie treść');
  assert.ok(!out.includes('wszystkie_w_promptcie'), 'licznik z promptu nie jest dla trenera');
  assert.ok(!out.includes('"wersja"') && !out.includes('wersja:'), '`wersja` nie jest dla trenera');
});

// ============================================================
// 3. „S. NULL" — pełna macierz, bo to jedyna rzecz, o którą pas A prosi
//    dwa razy w tym samym akapicie
// ============================================================
console.log('\n3. Brak strony — pełna macierz');

scenario('każda pusta postać strony daje sam tytuł materiału', () => {
  for (const strona of [null, undefined, '', '   ', 'null', 'undefined', '—', '–', '-', 'brak', 'NULL']) {
    const out = renderSourceHint({ ...HINT_PELNY, strona });
    assert.ok(out.includes('Regeneracja — System Gamechange (pełny)'), `tytuł zniknął dla strona=${JSON.stringify(strona)}`);
    assert.ok(!/,\s*s\.\s*\S/.test(out.replace(/Regeneracja — System Gamechange \(pełny\)/g, '')),
      `doklejona strona dla strona=${JSON.stringify(strona)}`);
  }
});

scenario('strona jako ZAKRES i jako lista przechodzi w całości (kontrakt: to tekst, nie liczba)', () => {
  assert.ok(renderSourceHint({ ...HINT_PELNY, strona: '12–13' }).includes(', s. 12–13'));
  assert.ok(renderSourceHint({ ...HINT_PELNY, strona: '5, 13' }).includes(', s. 5, 13'));
});

scenario('strona jako liczba (gdyby kiedyś przyszła liczbą) też działa', () => {
  assert.ok(renderSourceHint({ ...HINT_PELNY, strona: 8 }).includes(', s. 8'));
});

scenario('materiał pusty + strona obecna -> BRAK przypisu (nie sama strona bez tytułu)', () => {
  const out = renderSourceHint({ ...HINT_PELNY, material: null, strona: '8' });
  assert.ok(!out.includes('gc-source-hint-origin'), 'strona bez tytułu nie jest dowodem na nic');
  assert.ok(!/s\.\s*8/.test(out));
});

// ============================================================
// 4. ODPORNOŚĆ — pole przychodzi z bazy, nie z naszego kodu
// ============================================================
console.log('\n4. Odporność na kształt danych');

scenario('pusta/biała `tresc` -> nic nie renderujemy (zamiast pustej ramki z tytułem)', () => {
  assert.strictEqual(renderSourceHint({ ...HINT_PELNY, tresc: '' }), '');
  assert.strictEqual(renderSourceHint({ ...HINT_PELNY, tresc: '   ' }), '');
  assert.strictEqual(renderSourceHint({ ...HINT_PELNY, tresc: null }), '');
});

scenario('source_hint jako TEKST (json) jest parsowany, a nie pokazany jako „[object Object]"', () => {
  const out = renderSourceHint(JSON.stringify(HINT_PELNY));
  assert.ok(out.includes('Wyznacz stałą godzinę snu'));
  assert.ok(!out.includes('[object Object]'));
});

scenario('zepsuty json / tablica / liczba -> nic, bez wyjątku', () => {
  assert.strictEqual(renderSourceHint('{to nie jest json'), '');
  assert.strictEqual(renderSourceHint([HINT_PELNY]), '');
  assert.strictEqual(renderSourceHint(42), '');
  assert.strictEqual(renderSourceHint(true), '');
});

scenario('nieznany `rodzaj` -> brak etykiety rodzaju, reszta bez zmian', () => {
  const out = renderSourceHint({ ...HINT_PELNY, rodzaj: 'cos_nowego' });
  assert.ok(!out.includes('cos_nowego'), 'surowa wartość `rodzaj` wyciekła na ekran');
  assert.ok(out.includes('Na czym stoi ta rekomendacja'));
  assert.ok(out.includes('Wyznacz stałą godzinę snu'));
});

scenario('znane wartości `rodzaj` dają dwie RÓŻNE, ludzkie etykiety', () => {
  const a = renderSourceHint({ ...HINT_PELNY, rodzaj: 'zrobic' });
  const b = renderSourceHint({ ...HINT_PELNY, rodzaj: 'zrozumiec' });
  assert.ok(a.includes('do zrobienia'));
  assert.ok(b.includes('do zrozumienia'));
  assert.notStrictEqual(a, b, 'dwa różne rodzaje muszą dać dwa różne teksty');
});

scenario('wersja > 1 -> nadal renderujemy trzon, ale NIE po cichu (console.warn)', () => {
  const warns = [];
  const oryg = P.sandbox.console.warn;
  P.sandbox.console.warn = (...a) => warns.push(a.join(' '));
  try {
    const out = renderSourceHint({ ...HINT_PELNY, wersja: 2 });
    assert.ok(out.includes('Wyznacz stałą godzinę snu'), 'trzon kontraktu ma działać dalej');
    assert.strictEqual(warns.length, 1, 'zmiana wersji kontraktu nie może być cicha (reguła R5)');
    assert.ok(/wersj/i.test(warns[0]));
  } finally {
    P.sandbox.console.warn = oryg;
  }
});

scenario('treść jest ESCAPE\'owana — HTML z bazy nie wykonuje się w panelu', () => {
  const out = renderSourceHint({
    ...HINT_PELNY,
    tresc: '<img src=x onerror="alert(1)"> & "cudzysłów"',
    material: '<b>Moc</b>',
    strona: '8',
  });
  assert.ok(!out.includes('<img'), 'niezescape\'owany znacznik w treści');
  assert.ok(!out.includes('<b>Moc</b>'), 'niezescape\'owany znacznik w tytule materiału');
  assert.ok(out.includes('&lt;img'), 'escapeHtml nie zadziałał');
});

// ============================================================
// 5. OSADZENIE W KARCIE REKOMENDACJI
// ============================================================
console.log('\n5. Karta rekomendacji');

scenario('karta z source_hint niesie sekcję; karta bez niego wygląda jak przed tą rundą', () => {
  const zHintem = renderRecommendationCard({ ...REKOMENDACJA, source_hint: HINT_PELNY });
  const bezHintu = renderRecommendationCard({ ...REKOMENDACJA, source_hint: null });
  assert.ok(zHintem.includes('gc-source-hint'), 'sekcja nie weszła do karty');
  assert.ok(!bezHintu.includes('gc-source-hint'), 'karta bez podpowiedzi nie może urosnąć ani o znak');
  assert.ok(bezHintu.includes('W tym tygodniu popracuj nad rytmem snu'), 'treść rekomendacji zniknęła');
});

scenario('cytat stoi POD treścią rekomendacji, nad wzmocnieniem i ocenami', () => {
  const out = renderRecommendationCard({
    ...REKOMENDACJA,
    source_hint: HINT_PELNY,
    reinforced_by_coach_at: '2026-08-06T12:00:00Z',
  });
  const iTresc = out.indexOf('W tym tygodniu popracuj');
  const iHint = out.indexOf('gc-source-hint');
  const iWzmocnienie = out.indexOf('Wzmocnione przez Ciebie');
  assert.ok(iTresc > -1 && iHint > iTresc, 'cytat ma być POD rekomendacją, nie nad nią');
  assert.ok(iWzmocnienie > iHint, 'wzmocnienie trenera ma zostać na końcu karty');
});

scenario('rekomendacja bez treści, ale z podpowiedzią -> podpowiedź i tak widać', () => {
  const out = renderRecommendationCard({
    ...REKOMENDACJA, recommendation_text: null, weekly_focus_text: null, source_hint: HINT_PELNY,
  });
  assert.ok(out.includes('Wyznacz stałą godzinę snu'));
});

// ============================================================
// 6. RZECZY, KTÓRYCH TA RUNDA NIE MIAŁA RUSZYĆ
// ============================================================
console.log('\n6. Nietknięte');

scenario('zapytanie do decision_recommendations nadal idzie przez select=*', () => {
  assert.ok(
    /decision_recommendations\?user_id=eq\.\$\{playerId\}[^`]*select=\*/.test(html),
    'source_hint przychodzi WYŁĄCZNIE dlatego, że to zapytanie bierze wszystkie kolumny'
  );
});

scenario('nic w tej sekcji nie zapisuje do bazy — panel tylko czyta source_hint', () => {
  const kod = bezKomentarzy(String(renderSourceHint) + String(parseSourceHint) + String(sourceHintOriginText));
  assert.ok(!/fetch\s*\(/.test(kod), 'renderowanie podpowiedzi nie ma prawa nic wołać');
  assert.ok(!/localStorage|sessionStorage/.test(kod));
});

scenario('rzeczy, których polecenie zabroniło usuwać, są na miejscu', () => {
  for (const [nazwa, wzorzec] of [
    ['RISK_BADGE_LABELS', /RISK_BADGE_LABELS/],
    ['plakietka „Za mało danych"', /Za mało danych/],
    ['zabezpieczenie oceny trenera', /coachInsightBySegment/],
    ['if (navBtn)', /if \(navBtn\)/],
    ['if (panelEl)', /if \(panelEl\)/],
    ['reguła łączenia rekomendacji', /recommendation_type=eq\.training_focus/],
  ]) {
    assert.ok(wzorzec.test(html), `zniknęło: ${nazwa}`);
  }
});

scenario('cztery wyrównane etykiety segmentów — panel mówi tym samym głosem co lib/labels.ts', () => {
  for (const dobra of ['Technika fundamentalna', 'Technika specjalistyczna', 'Tolerancja obciążeń', 'Szybkość decyzji']) {
    assert.ok(html.includes(`'${dobra}'`), `brak etykiety: ${dobra}`);
  }
  for (const zla of ['Technika Fundamentalna', 'Technika Specjalistyczna', 'Tolerancja (Obciążeń)', 'Szybkość Decyzji']) {
    assert.ok(!html.includes(`'${zla}'`), `stara etykieta została: ${zla}`);
  }
  assert.ok(html.includes("['mental', 'Odwaga w grze']"), 'rename z rundy 3/4 nietknięty');
  assert.ok(html.includes('Filar 4 — Mentalność'), 'nazwa filaru nietknięta');
});

console.log(`\n${failed === 0 ? `WSZYSTKIE TESTY PRZESZŁY (${passed}).` : `PRZESZŁO ${passed}, PADŁO ${failed}.`}`);
process.exit(failed === 0 ? 0 : 1);
