// ============================================================
// GAMECHANGE — tests/test-coach-team-view.js
// ============================================================
// NOWY PLIK (DRUZYNA C7, 08.08.2026).
//
// PO CO ISTNIEJE:
//
// 1. ZASTĘPSTWO ZA WIDOK Z LEJKA. 08.08.2026 zdjęto politykę RLS
//    `anon can read diagnostics` (luka P0 — każdy bez logowania czytał
//    diagnozy nieletnich po team_code) i razem z nią umarł widok drużyny
//    w lejku (gamechange-diagnoza/index.html, loadTeamView). Zastępstwo
//    żyje w coach.html za logowaniem, na polityce diagnostics_coach_select
//    ((user_id IS NOT NULL) AND coach_has_any_access(...)). Ten test pilnuje
//    rzeczy, których złamanie nic by nie wywaliło: trzech ROZŁĄCZNYCH
//    stanów pustki, braku e-maili w HTML widoku i braku kolumny email
//    w nowym selectcie o skład.
//
// 2. O5/O9 — coach.html tracił już fragmenty przez nadpisywanie. Sekcja
//    "NIETKNIĘTE" liczy wystąpienia kluczowych stałych i wypisuje POMIARY
//    osobnym console.log przy każdym uruchomieniu (nie w etykietach asercji),
//    żeby liczby były w logu także wtedy, gdy wszystko jest zielone.
//
// Metoda: blok <script> z coach.html uruchomiony w `vm` na atrapie DOM —
// ten sam wzorzec co tests/test-coach-source-hint.js (i test-raport-rodzica.js).
// Stałe `const`/`let` z bloku NIE wiszą na obiekcie globalnym sandboxa —
// czytamy je przez stala('WYRAZENIE'), dokładnie jak w teście źródłowym.
//
// Uruchomienie: node tests/test-coach-team-view.js
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_PATH = path.join(__dirname, '..', 'coach.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// ------------------------------------------------------------
// Atrapa DOM — 1:1 wzorzec z tests/test-coach-source-hint.js.
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
      if (sandbox.__fetchImpl) return sandbox.__fetchImpl(url, opts);
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

// Usuwa komentarze HTML i JS — liczenie "czego widać w interfejsie" musi
// patrzeć na KOD, nie na komentarze (np. zakomentowany przycisk nav-private).
function bezKomentarzy(tekst) {
  return tekst
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

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

// ============================================================
// POMIARY NIETKNIĘTYCH STAŁYCH — wypisywane OSOBNYM console.log przy
// KAŻDYM uruchomieniu (celowo poza etykietami asercji), żeby liczby były
// widoczne w logu także wtedy, gdy wszystko jest zielone.
// ============================================================
const count = (re) => (html.match(re) || []).length;
const POMIARY = {
  'RISK_BADGE_LABELS': count(/RISK_BADGE_LABELS/g),
  'MARKETPLACE_ENABLED': count(/MARKETPLACE_ENABLED/g),
  'WEEKLY_TEAM_PULSE_ENABLED': count(/WEEKLY_TEAM_PULSE_ENABLED/g),
  "'Odwaga w grze'": count(/'Odwaga w grze'/g),
  "'Technika fundamentalna'": count(/'Technika fundamentalna'/g),
  'parseSourceHint (wystąpienia)': count(/parseSourceHint/g),
  'renderSourceHint (wystąpienia)': count(/renderSourceHint/g),
  'gc-nav-btn (wystąpienia w całym pliku)': count(/gc-nav-btn/g),
};
console.log('coach.html — Diagnozy drużyny (blok <script> na atrapie DOM)');
console.log('\nPOMIAR: rozmiar coach.html w bajtach: ' + Buffer.byteLength(html, 'utf8'));
Object.entries(POMIARY).forEach(([k, v]) => console.log(`POMIAR: ${k}: ${v}`));
const aktywnyHtml = bezKomentarzy(html);
const navButtons = (aktywnyHtml.match(/class="gc-nav-btn/g) || []).length;
console.log('POMIAR: aktywne (niezakomentowane) przyciski nawigacji: ' + navButtons);

const P = loadPanel();
const S = P.sandbox;
const stala = P.stala;

// --- Dane testowe. E-maile są w danych WEJŚCIOWYCH celowo — test dowodzi,
// że NIE przechodzą do HTML (identyfikacja imieniem/nazwą, jak w Składzie).
// Zawodnik 1: scores stringiem JSON, zawodnik 2: obiektem — oba kształty
// występują w bazie (patrz parseScores w coach.html).
const CZLONKOWIE = [
  { playerId: 'u-1', name: 'Adam Kowalski', diag: { user_id: 'u-1', created_at: '2026-08-01T10:00:00Z', scores: JSON.stringify({ moc: 72, wytrzymalosc: 68, fizycznosc: 70, techFund: 66, techSpec: 71, tolerancja: 69, regeneracja: 30, odpornosc: 67, odzywianie: 71, koncentracja: 73, mental: 70, percepcja: 68, decyzja: 72 }) } },
  { playerId: 'u-2', name: 'Borys Nowak', diag: { user_id: 'u-2', created_at: '2026-08-03T10:00:00Z', scores: { moc: 40, wytrzymalosc: 44, fizycznosc: 42, techFund: 28, techSpec: 45, tolerancja: 41, regeneracja: 29, odpornosc: 46, odzywianie: 43, koncentracja: 44, mental: 47, percepcja: 40, decyzja: 61 } } },
  { playerId: 'u-3', name: 'Celina Wiśniewska', diag: null },
];

async function main() {

  // ============================================================
  // 1. WEJŚCIE — JEDNA nowa pozycja w istniejącej nawigacji
  // ============================================================
  console.log('\n1. Nawigacja');

  await scenario('dokładnie 5 aktywnych przycisków nawigacji (4 stare + 1 nowy), nav-private dalej zakomentowany', () => {
    assert.strictEqual(navButtons, 5, `aktywnych przycisków ma być 5, jest ${navButtons}`);
    assert.ok(aktywnyHtml.includes('id="nav-teamdiag"'), 'brak przycisku nav-teamdiag poza komentarzem');
    assert.ok(!aktywnyHtml.includes('id="nav-private"'), 'nav-private miał zostać zakomentowany (zamrożenie 06.08.2026)');
    for (const stary of ['nav-roster', 'nav-assistant', 'nav-settings', 'nav-aggregate']) {
      assert.ok(aktywnyHtml.includes(`id="${stary}"`), `zniknął stary przycisk ${stary}`);
    }
  });

  await scenario('teamdiag jest w COACH_PANELS i ma dispatch w switchCoachPanel', () => {
    assert.strictEqual(
      stala("COACH_PANELS.join('|')"),
      'roster|assistant|settings|aggregate|teamdiag|private',
      'COACH_PANELS bez teamdiag — panel nie będzie się chował/pokazywał'
    );
    assert.strictEqual(typeof S.loadTeamDiagnosesPanel, 'function');
    assert.ok(/if \(name === 'teamdiag'\) loadTeamDiagnosesPanel\(\);/.test(html), 'brak dispatchu w switchCoachPanel');
  });

  await scenario('panel-teamdiag i teamdiag-body istnieją w DOM', () => {
    assert.ok(P.elements.has('panel-teamdiag'));
    assert.ok(P.elements.has('teamdiag-body'));
  });

  // ============================================================
  // 2. TRZY UCZCIWE, ROZŁĄCZNE STANY PUSTKI
  // ============================================================
  console.log('\n2. Trzy stany pustki — rozróżnialne');

  await scenario('(a) zero zawodników, (b) zero diagnoz z kontem, (c) błąd odczytu — trzy RÓŻNE zdania', () => {
    const a = S.renderTeamDiagEmptyNoPlayers();
    const b = S.renderTeamDiagEmptyNoDiagnoses(3);
    const c = S.renderTeamDiagError();
    for (const [nazwa, out] of [['a', a], ['b', b], ['c', c]]) {
      assert.ok(typeof out === 'string' && out.length > 40, `stan (${nazwa}) pusty albo zdawkowy`);
    }
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(b, c);
    assert.notStrictEqual(a, c);
  });

  await scenario('(b) mówi trenerowi ZDANIEM o niewidocznych diagnozach bez konta (user_id NULL)', () => {
    const b = S.renderTeamDiagEmptyNoDiagnoses(3);
    assert.ok(/bez zalogowania|bez konta/i.test(b), 'stan (b) nie tłumaczy, czemu diagnozy z lejka są niewidoczne');
    assert.ok(/niewidoczne/i.test(b), 'stan (b) musi mówić wprost o niewidoczności');
    assert.ok(/ochrona danych/i.test(b), 'stan (b) ma nazwać powód (ochrona danych), nie sugerować błąd');
    assert.ok(b.includes('3'), 'stan (b) ma pokazać liczbę zawodników, o których mowa');
  });

  await scenario('(c) błąd odczytu nie udaje pustki danych — inne słowa niż (a) i (b)', () => {
    const c = S.renderTeamDiagError();
    assert.ok(/nie udało się/i.test(c));
    assert.ok(!/żaden nie ma diagnozy|Brak aktywnych zawodników/i.test(c));
  });

  await scenario('renderTeamDiagnosesBody: zawodnicy są, diagnoz brak -> stan (b), nie pusta tabela', () => {
    const out = S.renderTeamDiagnosesBody(CZLONKOWIE.map(m => ({ ...m, diag: null })));
    assert.strictEqual(out, S.renderTeamDiagEmptyNoDiagnoses(3));
    assert.ok(!out.includes('<table'), 'przy zerze diagnoz nie renderujemy szkieletu tabeli');
  });

  // ============================================================
  // 3. ŚCIEŻKA loadTeamDiagnosesPanel() — stany (a) i (c) na żywym fetchu
  // ============================================================
  console.log('\n3. loadTeamDiagnosesPanel na atrapie fetch');

  await scenario('pusta odpowiedź z team_memberships -> stan (a) w teamdiag-body', async () => {
    // sandbox fetch domyślnie zwraca [] — to jest dokładnie stan (a).
    // currentUser jest potrzebny, bo authHeaders() czyta currentUser.accessToken.
    vm.runInContext('currentTeam = { id: "team-test-1" }; currentUser = { accessToken: "test-token" };', S);
    await S.loadTeamDiagnosesPanel();
    const bodyEl = P.elements.get('teamdiag-body');
    assert.strictEqual(bodyEl.innerHTML, S.renderTeamDiagEmptyNoPlayers());
    const call = P.fetchCalls.find(c => String(c.url).includes('team_memberships') && String(c.url).includes('users(full_name)'));
    assert.ok(call, 'zapytanie o skład nie poszło wzorcem panelu (embed users(full_name))');
  });

  await scenario('padnięty fetch -> stan (c), nigdy cicha pustka', async () => {
    S.__fetchImpl = async () => { throw new Error('sieć padła'); };
    try {
      await S.loadTeamDiagnosesPanel();
    } finally {
      S.__fetchImpl = null;
    }
    const bodyEl = P.elements.get('teamdiag-body');
    assert.strictEqual(bodyEl.innerHTML, S.renderTeamDiagError());
  });

  await scenario('nowy select o diagnostics to zwykły REST select przez RLS (bez service-keys, bez rpc)', () => {
    const m = html.match(/diagnostics\?user_id=in\.\(\$\{ids\.join\(','\)\}\)[^`]*/);
    assert.ok(m, 'brak nowego zapytania o diagnostics w loadTeamDiagnosesPanel');
    assert.ok(m[0].includes('event=eq.email_submitted'), 'zgubiony filtr ukończonej diagnozy');
    assert.ok(m[0].includes('scores=not.is.null'), 'zgubiony filtr niepustych scores');
    assert.ok(!/service_role|service-key/i.test(m[0]));
    const kod = bezKomentarzy(String(S.loadTeamDiagnosesPanel));
    assert.ok(kod.includes('authHeaders()'), 'zapytania mają iść z sesją zalogowanego trenera (authHeaders)');
  });

  // ============================================================
  // 4. TABELA — wyniki per segment, identyfikacja imieniem, zero e-maili
  // ============================================================
  console.log('\n4. Tabela wyników');

  await scenario('tabela: imiona zawodników z diagnozą + 13 kolumn segmentów + wartości', () => {
    const out = S.renderTeamDiagnosesBody(CZLONKOWIE);
    assert.ok(out.includes('<table'), 'brak tabeli');
    assert.ok(out.includes('Adam Kowalski'));
    assert.ok(out.includes('Borys Nowak'));
    const segIds = stala('TEAMDIAG_SEGMENT_IDS');
    assert.strictEqual(segIds.length, 13, 'ma być dokładnie 13 segmentów');
    for (const id of segIds) {
      assert.ok(out.includes(stala(`TEAMDIAG_SHORT_LABELS[${JSON.stringify(id)}]`)), `brak kolumny segmentu ${id}`);
    }
    assert.ok(out.includes('>72<') && out.includes('>30<'), 'w komórkach mają być wartości liczbowe');
  });

  await scenario('zawodnik bez diagnozy wymieniony pod tabelą, nie zgubiony po cichu', () => {
    const out = S.renderTeamDiagnosesBody(CZLONKOWIE);
    assert.ok(out.includes('Celina Wiśniewska'), 'zawodnik bez diagnozy zniknął z widoku');
    assert.ok(/Bez diagnozy na koncie/.test(out), 'brak etykiety grupy bez diagnozy');
  });

  await scenario('widok mówi o niewidoczności diagnoz bez konta TAKŻE przy niepustej tabeli', () => {
    const out = S.renderTeamDiagnosesBody(CZLONKOWIE);
    assert.ok(/bez konta/i.test(out), 'stopka o granicy RLS zniknęła z pełnego widoku');
  });

  await scenario('ZERO e-maili w HTML widoku — nawet gdy przyjdą w danych', () => {
    const zEmailami = CZLONKOWIE.map(m => ({
      ...m,
      users: { full_name: m.name, email: `${m.playerId}@example.com` },
    }));
    const out = S.renderTeamDiagnosesBody(zEmailami);
    assert.ok(!out.includes('@example.com'), 'e-mail wyciekł do HTML widoku');
    assert.ok(!/[a-z0-9._-]+@[a-z0-9.-]+/i.test(out), 'coś o kształcie e-maila w HTML widoku');
  });

  await scenario('teamDiagPlayerName NIGDY nie sięga po email (od r14 reszta UI trzyma ten sam wzorzec)', () => {
    assert.strictEqual(S.teamDiagPlayerName({ full_name: 'Jan', email: 'jan@x.pl' }), 'Jan');
    const fallback = S.teamDiagPlayerName({ email: 'jan@x.pl' });
    assert.ok(!fallback.includes('@'), 'fallback nazwy użył e-maila');
    assert.ok(fallback.length > 0, 'fallback nazwy nie może być pustym ciągiem');
    const kod = bezKomentarzy(String(S.teamDiagPlayerName));
    assert.ok(!/email/.test(kod), 'kod funkcji nazwy w ogóle nie może czytać pola email');
  });

  await scenario('nowy select o skład NIE pobiera kolumny email', () => {
    const kod = bezKomentarzy(String(S.loadTeamDiagnosesPanel));
    assert.ok(kod.includes('users(full_name)'), 'embed users(full_name) zniknął');
    assert.ok(!kod.includes('users(full_name,email)'), 'nowy widok nie ma prawa pobierać e-maili');
  });

  // AGENT-N1 (runda 14, 08.08.2026) — wyrównanie STARYCH miejsc panelu do
  // wzorca D4: e-mail (potencjalnie nieletniego) nie jest już fallbackiem
  // nazwy w Składzie, liście prywatnych, nagłówku szczegółów ani panelu
  // sugestii grupowej. player_email jako IDENTYFIKATOR zapisu (player_insights,
  // coach_notes) celowo zostaje — to nie jest treść ekranu.
  await scenario('AGENT-N1 (r14): e-mail zawodnika NIE jest nazwą nigdzie w UI trenera', () => {
    // Trzy rozłączne stany wspólnej funkcji nazwy:
    assert.strictEqual(S.playerNameForCoachUI({ full_name: 'Jan Kowalski', email: 'jan@x.pl' }), 'Jan Kowalski');
    assert.strictEqual(S.playerNameForCoachUI({ email: 'jan@x.pl' }), 'Zawodnik bez nazwy w systemie');
    assert.ok(S.playerNameForCoachUI({}).includes('napisz do Kuby'), 'stan serwisowy „nic nie doszło" zniknął');
    assert.ok(S.playerNameForCoachUI(null).includes('napisz do Kuby'), 'null ma dawać stan serwisowy, nie wyjątek');
    for (const u of [{ email: 'a@b.pl' }, {}, null, { full_name: '', email: 'c@d.pl' }]) {
      assert.ok(!String(S.playerNameForCoachUI(u)).includes('@'), 'e-mail wyciekł przez funkcję nazwy');
    }
    // Cztery miejsca UI używają wspólnej funkcji (a nie własnego `|| u.email`).
    // bezKomentarzy() nie zdejmuje komentarzy NA KOŃCU linii — komentarze
    // AGENT-N1 cytują stary kod, więc zdejmujemy je tu osobno.
    const bezAgentN1 = (fn) => bezKomentarzy(String(fn)).replace(/\/\/ AGENT-N1[^\n]*/g, '');
    for (const fn of [S.renderRosterCard, S.renderPrivateRosterCard, S.renderGroupGoalSuggestPanel, S.openPlayerDetail]) {
      const kod = bezAgentN1(fn);
      assert.ok(kod.includes('playerNameForCoachUI('), `funkcja ${fn.name} nie używa wspólnej nazwy`);
      assert.ok(!/\|\|\s*u\.email/.test(kod), `funkcja ${fn.name} wciąż ma fallback nazwy na e-mail`);
    }
  });

  await scenario('imię z bazy jest ESCAPE\'owane — HTML w nazwie nie wykonuje się', () => {
    const out = S.renderTeamDiagnosesBody([
      { playerId: 'u-x', name: '<img src=x onerror="alert(1)">', diag: CZLONKOWIE[0].diag },
    ]);
    assert.ok(!out.includes('<img'), 'niezescape\'owany znacznik w nazwie zawodnika');
    assert.ok(out.includes('&lt;img'), 'escapeHtml nie zadziałał na nazwie');
  });

  // ============================================================
  // 5. HEATMAPA — logika kolorów przeniesiona z lejka (progi 35/50/65)
  // ============================================================
  console.log('\n5. Heatmapa segmentów');

  await scenario('cztery poziomy kolorów lejka: <35, <50, <65, >=65 — kolory i etykiety', () => {
    // JSON.stringify zamiast deepStrictEqual — obiekty z sandboxa vm mają
    // inny Object.prototype (inny realm) i deepStrictEqual by je odrzucił.
    const j = (v) => JSON.stringify(S.teamDiagHeatLevel(v));
    assert.strictEqual(j(34), JSON.stringify({ bg: '#FDEBEB', border: '#C0392B', text: '#8B1A1A', label: 'Wymaga uwagi' }));
    assert.strictEqual(j(49), JSON.stringify({ bg: '#fff3e0', border: '#e08020', text: '#c06010', label: 'Do pracy' }));
    assert.strictEqual(j(64), JSON.stringify({ bg: '#fffde0', border: '#c8b820', text: '#9a8c10', label: 'Przeciętny' }));
    assert.strictEqual(j(65), JSON.stringify({ bg: '#e8f5e9', border: '#2a7a3a', text: '#1a5a2a', label: 'Dobry' }));
    assert.strictEqual(S.teamDiagHeatLevel(35).label, 'Do pracy', 'granica 35 należy do wyższego poziomu — jak w lejku');
  });

  await scenario('heatmapa: kafelki od najsłabszego segmentu, etykiety z SEG_LABELS, licznik n=', () => {
    const withDiag = CZLONKOWIE.filter(m => m.diag).map(m => ({ ...m, scores: S.parseScores(m.diag.scores) }));
    const out = S.renderTeamDiagHeatmap(withDiag);
    assert.ok(out.includes('teamdiag-heatmap-grid'));
    // regeneracja: (30+29)/2 = 30 (Wymaga uwagi) — musi stać PRZED mocą (72+40)/2 = 56.
    const iRegen = out.indexOf(stala("SEG_LABELS.regeneracja"));
    const iMoc = out.indexOf('>' + stala("SEG_LABELS.moc") + '<');
    assert.ok(iRegen > -1, 'brak kafelka regeneracji');
    assert.ok(iMoc > iRegen, 'kolejność nie idzie od najsłabszego segmentu');
    assert.ok(out.includes('n=2'), 'kafelek nie mówi, z ilu zawodników liczona średnia');
    assert.ok(out.includes('#FDEBEB'), 'najsłabszy segment (śr. 30) nie dostał koloru „Wymaga uwagi"');
  });

  // ============================================================
  // 6. WĄSKIE GARDŁA — względem własnej mediany (logika lejka), nie surowe minimum
  // ============================================================
  console.log('\n6. Wąskie gardła');

  await scenario('wyrównany profil -> ZERO deficytów (nie „najniższy z normy")', () => {
    const rowne = { moc: 70, wytrzymalosc: 69, fizycznosc: 71, techFund: 68, techSpec: 70, tolerancja: 72, regeneracja: 69, odpornosc: 70, odzywianie: 71, koncentracja: 70, mental: 69, percepcja: 71, decyzja: 68 };
    assert.strictEqual(S.teamDiagRelativeDeficits(rowne, 4).length, 0);
  });

  await scenario('segment wyraźnie poniżej własnej mediany -> jest deficytem', () => {
    const scores = S.parseScores(CZLONKOWIE[0].diag.scores); // regeneracja 30, reszta ~70
    const deficits = S.teamDiagRelativeDeficits(scores, 4);
    assert.ok(deficits.includes('regeneracja'));
    assert.ok(!deficits.includes('koncentracja'), 'segment w normie nie może być deficytem');
  });

  await scenario('zestawienie: wspólne wąskie gardło z licznikiem x/y', () => {
    const withDiag = CZLONKOWIE.filter(m => m.diag).map(m => ({ ...m, scores: S.parseScores(m.diag.scores) }));
    const out = S.renderTeamDiagBottlenecks(withDiag);
    assert.ok(out.includes(stala("SEG_LABELS.regeneracja")), 'regeneracja jest deficytem obu zawodników');
    assert.ok(out.includes('2/2'), 'brak licznika „u ilu z ilu"');
  });

  await scenario('zero deficytów w drużynie -> uczciwe zdanie, nie pusta sekcja', () => {
    const rowni = [{ playerId: 'u-r', name: 'Równy Profil', scores: { moc: 70, wytrzymalosc: 70, fizycznosc: 70 } }];
    const out = S.renderTeamDiagBottlenecks(rowni);
    assert.ok(/brak wspólnych wąskich gardeł/i.test(out));
  });

  // ============================================================
  // 7. NIETKNIĘTE — liczniki stałych i funkcje source_hint
  // ============================================================
  console.log('\n7. Nietknięte');

  await scenario('liczniki kluczowych stałych zgodne z oczekiwaniem', () => {
    assert.strictEqual(POMIARY['RISK_BADGE_LABELS'], 3);
    assert.strictEqual(POMIARY['MARKETPLACE_ENABLED'], 2);
    assert.strictEqual(POMIARY['WEEKLY_TEAM_PULSE_ENABLED'], 2);
    assert.strictEqual(POMIARY["'Odwaga w grze'"], 2);
    assert.strictEqual(POMIARY["'Technika fundamentalna'"], 1);
  });

  await scenario('funkcje source_hint z rundy 5 obecne i wykonywalne', () => {
    assert.strictEqual(typeof S.parseSourceHint, 'function');
    assert.strictEqual(typeof S.renderSourceHint, 'function');
    assert.strictEqual(S.renderSourceHint(null), '');
  });

  await scenario('istniejące panele i ich loadery na miejscu', () => {
    for (const fn of ['loadRoster', 'loadAssistantPanel', 'loadSettingsPanel', 'updateAggregateAvailability', 'loadPrivateRoster', 'renderAggregate']) {
      assert.strictEqual(typeof S[fn], 'function', `zniknęła funkcja ${fn}`);
    }
  });

  // ============================================================
  // 8. CO TRENER ZOBACZY — zrzut wygenerowany testem (do raportu),
  //    nie pisany ręcznie.
  // ============================================================
  console.log('\n8. Zrzut widoku (generowany)');
  {
    const pelny = S.renderTeamDiagnosesBody(CZLONKOWIE);
    const tekst = pelny
      .replace(/<[^>]+>/g, '|')
      .replace(/\|+/g, ' | ')
      .replace(/\s+/g, ' ')
      .slice(0, 1200);
    console.log('ZRZUT (a): ' + S.renderTeamDiagEmptyNoPlayers().replace(/<[^>]+>/g, ''));
    console.log('ZRZUT (b): ' + S.renderTeamDiagEmptyNoDiagnoses(3).replace(/<[^>]+>/g, ''));
    console.log('ZRZUT (c): ' + S.renderTeamDiagError().replace(/<[^>]+>/g, ''));
    console.log('ZRZUT (pełny widok, tekst): ' + tekst);
  }

  console.log(`\n${failed === 0 ? `WSZYSTKIE TESTY PRZESZŁY (${passed}).` : `PRZESZŁO ${passed}, PADŁO ${failed}.`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Nieoczekiwany błąd harnessu:', e.stack || e.message);
  process.exit(1);
});
