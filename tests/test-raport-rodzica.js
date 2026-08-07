// ============================================================
// GAMECHANGE — tests/test-raport-rodzica.js
// ============================================================
// NOWY PLIK (RODZIC C4, 08.08.2026). `raport-rodzica.html` to jedyna
// powierzchnia w całym systemie, na którą patrzy osoba podejmująca
// decyzję zakupową (decyzja A3: rodzic płaci) — i do tej rundy nie miała
// ani jednego testu.
//
// DWA POWODY, DLA KTÓRYCH TEN PLIK ISTNIEJE — oba konkretne:
//
// 1. BRAMKA WIEKOWA (decyzja A9). To jedyna rzecz w tej rundzie, której
//    pomyłka ma realny koszt zdrowotny. Rodzic ma widzieć podpowiedzi
//    z dawkami suplementacyjnymi ZAWSZE, niezależnie od wieku dziecka;
//    zawodnik poniżej 16 lat NIGDY. Testy niżej pilnują strony rodzica
//    na realnych wierszach z materiału.
//
// 2. ŚWIADOMA DUPLIKACJA. Strona nie może zrobić `require()` do `lib/`,
//    więc trzy funkcje warstwy rodzica (`selectParentHints`,
//    `describeParentActivity`, `describeParentChange`) żyją w DWÓCH
//    miejscach: tutaj i w `lib/email-templates.js`. Ta duplikacja jest
//    zaakceptowana (ten sam wzorzec co SEG_NAMES), ale bez testu nic jej
//    nie pilnuje — a rozjazd znaczy, że e-mail i strona mówią rodzicowi
//    dwie różne rzeczy o tych samych danych. Sekcja 2 porównuje obie
//    kopie na tym samym zestawie przypadków i wymaga IDENTYCZNYCH wyników.
//
// Metoda: blok <script> ze strony uruchomiony w `vm` na atrapie DOM
// i `fetch` — ten sam wzorzec, którego runda 3 użyła dla `coach.html`.
//
// Uruchomienie: node tests/test-raport-rodzica.js
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_PATH = path.join(__dirname, '..', 'raport-rodzica.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// --- 1. Atrapa DOM: tyle, ile ta strona realnie używa ---
function makeElement(id) {
  const classes = new Set();
  return {
    id,
    _classes: classes,
    textContent: '',
    innerHTML: '',
    onclick: null,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
}

function makeDom() {
  const elements = new Map();
  // Wszystkie id-ki obecne w pliku — czytane z samego HTML, żeby test nie
  // rozjechał się ze stroną przy dodaniu kolejnego bloku.
  for (const m of html.matchAll(/\bid="([a-zA-Z0-9_-]+)"/g)) {
    const el = makeElement(m[1]);
    // Klasy z atrybutu class tego samego znacznika — potrzebne, żeby
    // `gc-hidden` startowało tak, jak startuje w przeglądarce.
    elements.set(m[1], el);
  }
  for (const m of html.matchAll(/<[^>]*\bid="([a-zA-Z0-9_-]+)"[^>]*>/g)) {
    const tag = m[0];
    const el = elements.get(m[1]);
    const cls = /class="([^"]*)"/.exec(tag);
    if (el && cls) cls[1].split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
  }
  return {
    elements,
    document: {
      getElementById: (id) => elements.get(id) || null,
      // escapeHtml() na stronie działa przez createElement('div') —
      // odtwarzam dokładnie tę semantykę (textContent -> innerHTML).
      createElement: () => {
        const el = { _text: '' };
        Object.defineProperty(el, 'textContent', {
          get() { return el._text; },
          set(v) { el._text = v == null ? '' : String(v); },
        });
        Object.defineProperty(el, 'innerHTML', {
          get() {
            return el._text
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          },
        });
        return el;
      },
    },
  };
}

function loadPage({ search = '' } = {}) {
  const dom = makeDom();
  const bloki = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.strictEqual(bloki.length, 1, 'strona ma mieć dokładnie jeden blok <script>');
  const fetchCalls = [];
  const sandbox = {
    document: dom.document,
    window: { location: { search } },
    URLSearchParams,
    console: { log: () => {} },
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true, status: 200, json: async () => null };
    },
    Date,
    Number,
    Array,
    JSON,
    Math,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bloki[0], sandbox, { filename: 'raport-rodzica.html<script>' });
  // `const` na najwyższym poziomie skryptu nie ląduje na obiekcie
  // globalnym (inaczej niż `function`), więc stałe czytam wyrażeniem
  // w tym samym kontekście.
  const stala = (nazwa) => vm.runInContext(nazwa, sandbox);
  return { sandbox, dom, fetchCalls, stala };
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

// --- Realne wiersze z PODPOWIEDZI_Z_MATERIALOW_A.md, segment `regeneracja` ---
const HINTS = [
  { klucz: 'regeneracja-segment-08', hint: 'Dawka bazowa dla zawodnika ok. 70 kg: 200–400 mg magnezu elementarnego dziennie, wieczorem przed snem.', odbiorca: 'rodzic', min_age: 16, rodzaj: 'zrobic', zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '5, 13', pozycja: 8 },
  { klucz: 'regeneracja-segment-09', hint: 'Wybieraj diglicynian albo cytrynian magnezu, unikaj tlenku.', odbiorca: 'rodzic', min_age: 16, rodzaj: 'zrobic', zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '5, 13–14', pozycja: 9 },
  { klucz: 'regeneracja-segment-10', hint: 'Przy zdrowych nerkach przedawkowanie magnezu jest mało prawdopodobne.', odbiorca: 'rodzic', min_age: 16, rodzaj: 'zrozumiec', zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '11', pozycja: 10 },
  { klucz: 'regeneracja-wyduzenie-snu-02', hint: 'Wyznacz stałą godzinę snu i trzymaj się jej codziennie, także w weekendy.', odbiorca: 'oba', min_age: null, rodzaj: 'zrobic', zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '2', pozycja: 2 },
  { klucz: 'regeneracja-segment-01', hint: 'W ciągu 30–60 minut po treningu zjedz posiłek z węglowodanami i białkiem.', odbiorca: 'oba', min_age: null, rodzaj: 'zrobic', zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '3', pozycja: 1 },
  { klucz: 'regeneracja-segment-07', hint: 'Magnez to sprawa do ustalenia z rodzicem.', odbiorca: 'zawodnik', min_age: null, rodzaj: 'zrozumiec', zrodlo: 'decyzja A9', strony: '—', pozycja: 7 },
];

const RAPORT_12 = {
  player_name: 'Antek',
  priority_goal: { segment_id: 'regeneracja', horizon_weeks: 6 },
  active_goals_count: 2, recent_training_sessions_7d: 3, recent_matches_30d: 1,
  growth_spurt_typical_age_range: true, height_growth_rate_elevated: false,
  last_diagnosis_at: '2026-07-20T10:00:00Z',
};

console.log('raport-rodzica.html — testy jednostkowe (blok <script> na atrapie DOM)');

// ============================================================
// 1. BRAMKA WIEKOWA (decyzja A9) — strona rodzica
// ============================================================
console.log('\n1. Bramka wiekowa A9 — rodzic widzi dawki ZAWSZE');

scenario('DOWÓD KONSTRUKCYJNY: selectParentHints na stronie też nie przyjmuje wieku (arność 1)', () => {
  const { sandbox } = loadPage();
  assert.strictEqual(sandbox.selectParentHints.length, 1,
    'Ktoś dodał parametr — najpewniej wiek. To jest zmiana, której tu nie wolno zrobić.');
});

scenario('nigdzie w skrypcie strony min_age NIE jest użyte jako warunek filtrowania', () => {
  const skrypt = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  // Dozwolone jest WYŁĄCZNIE zliczanie (zDawkami) — czyli porównania
  // z null/undefined. Zakazane: jakiekolwiek porównanie z liczbą albo
  // z wiekiem, bo to znaczyłoby, że ktoś zbudował tu bramkę wieku.
  const podejrzane = skrypt.match(/min_age\s*(>=|<=|>|<|===\s*\d|!==\s*\d)/g);
  assert.strictEqual(podejrzane, null, `podejrzane użycia min_age: ${podejrzane}`);
  // Ani śladu po parametrze wieku w jakiejkolwiek postaci. (Świadomie NIE
  // szukam samego słowa „age" — występuje w `growth_spurt_typical_age_range`,
  // czyli w polu o skoku wzrostowym, które z bramką A9 nie ma nic wspólnego.)
  assert.ok(!/\bp_age\b|\bwiek\b|\bplayerAge\b|\bbirth_year\b/.test(skrypt),
    'skrypt strony nie powinien znać wieku zawodnika');
});

scenario('dziecko 12 lat: obie podpowiedzi z dawkami trafiają do rodzica', () => {
  const { sandbox } = loadPage();
  const w = sandbox.selectParentHints(HINTS);
  const klucze = w.doZrobienia.concat(w.wartoWiedziec).map((h) => h.klucz);
  assert.ok(klucze.includes('regeneracja-segment-08'));
  assert.ok(klucze.includes('regeneracja-segment-09'));
  assert.ok(klucze.includes('regeneracja-segment-10'));
  assert.strictEqual(w.zDawkami, 3);
});

scenario('treść pisana DO ZAWODNIKA nigdy nie trafia na stronę rodzica', () => {
  const { sandbox } = loadPage();
  const w = sandbox.selectParentHints(HINTS);
  const klucze = w.doZrobienia.concat(w.wartoWiedziec).map((h) => h.klucz);
  assert.ok(!klucze.includes('regeneracja-segment-07'));
});

scenario('render: liczba „200–400 mg" realnie ląduje w DOM, razem ze źródłem i zdaniem o dawkach', () => {
  const { sandbox, dom } = loadPage();
  sandbox.renderHints(RAPORT_12, { hints_available: true, hints: HINTS, segment_id: 'regeneracja' });
  const lista = dom.elements.get('gc-hints-do').innerHTML;
  assert.match(lista, /200–400 mg magnezu elementarnego/);
  assert.match(lista, /Regeneracja — System Gamechange \(pełny\), s\. 5, 13/);
  assert.ok(!dom.elements.get('gc-hints-doses').classList.contains('gc-hidden'),
    'zdanie „to widzisz Ty, nie dziecko" musi się pokazać, gdy są dawki');
});

scenario('render: brak wierszy z min_age -> zdanie o dawkach zostaje ukryte', () => {
  const { sandbox, dom } = loadPage();
  sandbox.renderHints(RAPORT_12, {
    hints_available: true, segment_id: 'regeneracja',
    hints: HINTS.filter((h) => h.min_age == null && h.odbiorca !== 'zawodnik'),
  });
  assert.ok(dom.elements.get('gc-hints-doses').classList.contains('gc-hidden'));
});

// ============================================================
// 2. ZGODNOŚĆ Z lib/email-templates.js (świadoma duplikacja)
// ============================================================
console.log('\n2. Zgodność kopii ze stroną e-mailową (żeby e-mail i strona mówiły to samo)');

const lib = require('../lib/email-templates.js');
const PRZYPADKI_HINTS = [
  [],
  HINTS,
  HINTS.filter((h) => h.odbiorca === 'zawodnik'),
  HINTS.filter((h) => h.rodzaj === 'zrozumiec'),
  Array.from({ length: 25 }, (_, i) => ({ klucz: `oba-${i}`, hint: `X${i}`, odbiorca: 'oba', min_age: null, rodzaj: i % 2 ? 'zrozumiec' : 'zrobic', zrodlo: 'M', strony: String(i + 1), pozycja: i + 1 })),
];

scenario('selectParentHints — 5 zestawów wejściowych, wynik identyczny w obu kopiach', () => {
  const { sandbox } = loadPage();
  PRZYPADKI_HINTS.forEach((wejscie, i) => {
    const a = sandbox.selectParentHints(wejscie);
    const b = lib.selectParentHints(wejscie);
    // Porównanie przez JSON, nie deepStrictEqual: obiekty z `vm` mają inny
    // Object.prototype (inny realm), więc deepStrictEqual zgłosiłby różnicę
    // tam, gdzie treść jest identyczna.
    const odcisk = (x) => JSON.stringify({
      do: x.doZrobienia.map((h) => h.klucz), w: x.wartoWiedziec.map((h) => h.klucz),
      r: x.razem, d: x.zDawkami, p: x.pominietych, s: x.dostepnych,
    });
    assert.strictEqual(odcisk(a), odcisk(b), `rozjazd na zestawie ${i}`);
  });
});

scenario('describeParentActivity — trzy stany, wynik identyczny w obu kopiach', () => {
  const { sandbox } = loadPage();
  const przypadki = [
    { report: RAPORT_12, lastLogAt: '2026-08-06T18:00:00Z' },
    { report: Object.assign({}, RAPORT_12, { recent_training_sessions_7d: 0, recent_matches_30d: 0 }), lastLogAt: null },
    { report: { active_goals_count: 0, recent_training_sessions_7d: 0, recent_matches_30d: 0 }, lastLogAt: null },
  ];
  przypadki.forEach((p, i) => {
    const a = sandbox.describeParentActivity(p);
    const b = lib.describeParentActivity(p);
    assert.strictEqual(a.state, b.state, `stan rozjechany na ${i}`);
    assert.strictEqual(a.headline, b.headline, `nagłówek rozjechany na ${i}`);
    assert.strictEqual(a.body, b.body, `treść rozjechana na ${i}`);
  });
});

scenario('describeParentChange — z migawką i bez, wynik identyczny w obu kopiach', () => {
  const { sandbox } = loadPage();
  const przypadki = [
    { report: RAPORT_12, previousReport: null },
    { report: RAPORT_12, previousReport: Object.assign({}, RAPORT_12, { recent_training_sessions_7d: 1, priority_goal: { segment_id: 'mental' } }), previousReportAt: '2026-07-08T10:00:00Z' },
    { report: RAPORT_12, previousReport: RAPORT_12 },
  ];
  przypadki.forEach((p, i) => {
    const a = sandbox.describeParentChange(p);
    const b = lib.describeParentChange(p);
    assert.strictEqual(JSON.stringify(a.lines), JSON.stringify(b.lines), `linie rozjechane na ${i}`);
    assert.strictEqual(a.note, b.note, `przypis rozjechany na ${i}`);
    assert.strictEqual(!!a.hasPrevious, !!b.hasPrevious, `hasPrevious rozjechane na ${i}`);
  });
});

scenario('parentHintSource — identyczne w obu kopiach', () => {
  const { sandbox } = loadPage();
  [{ zrodlo: 'Moc', strony: '3' }, { zrodlo: 'decyzja A9', strony: '—' }, { zrodlo: 'X' }, null].forEach((h) => {
    assert.strictEqual(sandbox.parentHintSource(h), lib.parentHintSource(h));
  });
});

scenario('SEG_NAMES na stronie zgodne z SEG_NAMES w e-mailach — w tym rename „Odwaga w grze"', () => {
  const { stala } = loadPage();
  assert.strictEqual(stala('SEG_NAMES').mental, 'Odwaga w grze');
  const zEmaila = lib.describeParentChange({
    report: { priority_goal: { segment_id: 'mental' }, active_goals_count: 0 },
    previousReport: { priority_goal: { segment_id: 'mental' }, active_goals_count: 0 },
  });
  assert.ok(zEmaila.lines.some((l) => l.includes('Odwaga w grze')));
});

// ============================================================
// 3. TRZY UCZCIWE STANY PUSTKI (reguła R5) — w DOM
// ============================================================
console.log('\n3. Trzy uczciwe stany pustki (R5)');

scenario('dziecko zapisuje -> pudełko wyjaśniające ukryte (liczby mówią same za siebie)', () => {
  const { sandbox, dom } = loadPage();
  sandbox.renderActivity(RAPORT_12, { last_log_at: '2026-08-06T18:00:00Z' });
  assert.ok(dom.elements.get('gc-activity-box').classList.contains('gc-hidden'));
});

scenario('dziecko nic nie zapisało od dwóch tygodni -> pudełko widoczne i wprost rozdziela „nie zapisuje" od „nie trenuje"', () => {
  const { sandbox, dom } = loadPage();
  const cichy = Object.assign({}, RAPORT_12, { recent_training_sessions_7d: 0, recent_matches_30d: 0 });
  const czternascieDniTemu = new Date(Date.now() - 14 * 86400000).toISOString();
  sandbox.renderActivity(cichy, { last_log_at: czternascieDniTemu });
  const box = dom.elements.get('gc-activity-box');
  assert.ok(!box.classList.contains('gc-hidden'));
  assert.match(dom.elements.get('gc-activity-body').textContent, /sprzed 14 dni/);
  assert.match(dom.elements.get('gc-activity-body').textContent, /nie znaczy, że dziecko nie trenuje — znaczy, że nie zapisuje/);
});

scenario('konto bez diagnozy, celu i wpisów -> INNA wiadomość niż „cisza"', () => {
  const { sandbox, dom } = loadPage();
  sandbox.renderActivity({ active_goals_count: 0, recent_training_sessions_7d: 0, recent_matches_30d: 0 }, null);
  assert.match(dom.elements.get('gc-activity-headline').textContent, /jeszcze się nie zaczęła/);
  assert.ok(!dom.elements.get('gc-activity-body').textContent.includes('nie zapisuje'));
});

scenario('brak extras -> stan liczony z samego raportu, strona nadal rozróżnia stany', () => {
  const { sandbox, dom } = loadPage();
  const cichy = Object.assign({}, RAPORT_12, { recent_training_sessions_7d: 0, recent_matches_30d: 0 });
  sandbox.renderActivity(cichy, null);
  assert.match(dom.elements.get('gc-activity-body').textContent, /nie zapisało ani jednego wpisu/);
});

// ============================================================
// 4. UCZCIWA NIEWIEDZA, GDY MIGRACJA NIEWKLEJONA
// ============================================================
console.log('\n4. Uczciwa niewiedza (migracja niewklejona)');

scenario('brak extras -> sekcja materiałów mówi wprost, że biblioteka nie jest podłączona', () => {
  const { sandbox, dom } = loadPage();
  sandbox.renderHints(RAPORT_12, null);
  assert.match(dom.elements.get('gc-hints-intro').textContent, /nie jest jeszcze podłączona/);
  assert.ok(dom.elements.get('gc-hints-do').classList.contains('gc-hidden'));
});

scenario('brak extras -> sekcja zmian mówi „nie mam", a NIE „bez zmian"', () => {
  const { sandbox, dom } = loadPage();
  sandbox.renderChange(RAPORT_12, null);
  const tekst = dom.elements.get('gc-change-note').textContent;
  assert.match(tekst, /Nie mam jeszcze zapisanego poprzedniego raportu/);
  assert.ok(!/bez zmian/i.test(tekst));
  assert.ok(dom.elements.get('gc-change-list').classList.contains('gc-hidden'));
});

scenario('extras są, ale to pierwszy raport -> „to pierwszy raport", inny komunikat niż brak extras', () => {
  const { sandbox, dom } = loadPage();
  sandbox.renderChange(RAPORT_12, { hints_available: true, hints: [], previous_report: null });
  assert.match(dom.elements.get('gc-change-note').textContent, /To pierwszy raport/);
});

scenario('obszar bez treści dla rodzica -> uczciwe „nie mamy jeszcze", nie pusta sekcja', () => {
  const { sandbox, dom } = loadPage();
  sandbox.renderHints(
    Object.assign({}, RAPORT_12, { priority_goal: { segment_id: 'moc' } }),
    { hints_available: true, hints: [], segment_id: 'moc' }
  );
  assert.match(dom.elements.get('gc-hints-intro').textContent, /Dla obszaru „Moc” nie mamy jeszcze wskazówek/);
});

scenario('limit wskazówek widoczny, nigdy cichy', () => {
  const { sandbox, dom } = loadPage();
  const duzo = Array.from({ length: 30 }, (_, i) => ({ hint: `Wspólna ${i}`, odbiorca: 'oba', min_age: null, rodzaj: 'zrobic', zrodlo: 'M', strony: '1', pozycja: i + 1 }));
  sandbox.renderHints(RAPORT_12, { hints_available: true, hints: duzo, segment_id: 'regeneracja' });
  assert.match(dom.elements.get('gc-hints-cap').textContent, /Pokazuję 6 z 30 wskazówek/);
  assert.ok(!dom.elements.get('gc-hints-cap').classList.contains('gc-hidden'));
});

// ============================================================
// 5. CZEGO TA RUNDA NIE MIAŁA RUSZYĆ
// ============================================================
console.log('\n5. Nietknięte: prywatność, token, brak paywalla');

scenario('mechanizm tokenu bez zmian: nadal dwie stare funkcje RPC po tokenie z URL', () => {
  const skrypt = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  assert.match(skrypt, /callRpc\('get_parent_report',\s*\{\s*p_token: token\s*\}\)/);
  assert.match(skrypt, /callRpc\('parent_report_unsubscribe',\s*\{\s*p_token: token\s*\}\)/);
  assert.match(skrypt, /params\.get\('token'\)/);
  // Zero logowania, zero klienta Auth, zero magazynu przeglądarki — to jest
  // cała prywatność tej strony i tego się nie rusza. Sprawdzam KOD, nie
  // komentarze (komentarz na górze pliku wymienia te nazwy, żeby wyjaśnić,
  // czego tu świadomie NIE MA).
  assert.ok(!/createClient\s*\(|signIn|getSession|localStorage\.|sessionStorage\.|document\.cookie/.test(bezKomentarzy(skrypt)));
});

scenario('nowa funkcja jest ADDYTYWNA — nie podmienia get_parent_report', () => {
  const skrypt = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  assert.match(skrypt, /callRpc\('get_parent_report_extras'/);
  const ile = (skrypt.match(/callRpc\('get_parent_report'/g) || []).length;
  assert.strictEqual(ile, 1, 'stara funkcja nadal wołana dokładnie raz');
});

scenario('awaria nowej funkcji NIE wywala strony (osobne try/catch)', () => {
  const skrypt = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  assert.match(skrypt, /try\s*\{[\s\S]{0,200}get_parent_report_extras[\s\S]{0,200}\}\s*catch/);
});

scenario('ŻADNEGO paywalla ani wezwania do zakupu na całej stronie', () => {
  [/kup teraz/i, /przejdź na (wersję|plan)/i, /cennik/i, /zapłać/i, /abonament/i,
    /\bpłatnoś/i, /\d+\s*zł/, /subskrypcj/i, /stripe/i, /checkout/i, /PILOT_HIDE_PURCHASE\s*=\s*false/]
    .forEach((wzorzec) => {
      // Na treści BEZ komentarzy — komentarz nagłówkowy mówi wprost
      // „żadnego przycisku «kup teraz»" i to zdanie ma tam zostać.
      assert.ok(!wzorzec.test(bezKomentarzy(html)), `raport rodzica nie może zawierać ${wzorzec}`);
    });
});

scenario('trzy stare stany strony (zły link / brak raportu / wypisano) nietknięte', () => {
  const { dom } = loadPage();
  ['gc-invalid-link', 'gc-not-found', 'gc-unsubscribed', 'gc-error', 'gc-loading']
    .forEach((id) => assert.ok(dom.elements.get(id), `zniknął stan ${id}`));
});

scenario('bez tokenu w URL strona pokazuje „zły link" i NIE woła żadnego RPC', () => {
  const { dom, fetchCalls } = loadPage({ search: '' });
  assert.strictEqual(fetchCalls.length, 0);
  assert.ok(!dom.elements.get('gc-invalid-link').classList.contains('gc-hidden'));
});

console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
process.exit(failed === 0 ? 0 : 1);
