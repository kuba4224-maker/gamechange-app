// ============================================================
// GAMECHANGE — tests/test-focus-block-content-store.js
// ============================================================
// PRAKTYKA A5 08.08.2026 — NOWY PLIK.
//
// Pokrywa `lib/focus-block-content-store.js`: magazyn dawki treści Bloku
// Skupienia (zapis + odczyt przed wywołaniem modelu) oraz podpowiedzi
// z materiałów wstrzykiwane do promptu fazy 2.
//
// Wzorzec atrapy Supabase rozszerzony względem `test-generate-focus-block-
// content.js` o `.update()`, `.or()` i wiele `.eq()` — tego istniejąca
// atrapa nie miała, bo żadna testowana wcześniej funkcja tego nie używała.
//
// ⚠️ OGRANICZENIE O11: ten plik MUSI wylądować na dysku Kuby, nie zostać
// w sesji. Runda 3 straciła w ten sposób 55 scenariuszy panelu trenera.
//
// Uruchomienie: node tests/test-focus-block-content-store.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_a5__.js');
require.cache[supabaseStubPath] = {
  id: supabaseStubPath,
  filename: supabaseStubPath,
  loaded: true,
  exports: { createClient: () => ({}) },
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return supabaseStubPath;
  return originalResolveFilename.call(this, request, ...rest);
};

const store = require('../lib/focus-block-content-store.js');
const {
  CONTENT_DOSE_VERSION,
  CONTENT_DOSE_CADENCE_DAYS,
  MAX_STORED_DOSES,
  emptyEnvelope,
  readDoseEnvelope,
  buildDoseKey,
  normalizeDose,
  findDoseForStage,
  findLatestDose,
  checkContentDoseCadence,
  appendDose,
  describeDoseState,
  fetchDoseEnvelope,
  saveContentDose,
  getDoseForBlock,
  loadHintsForFocusBlock,
  buildHintPromptBlock,
  pickShowcaseHint,
} = store;

Module._resolveFilename = originalResolveFilename;

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

const TERAZ = new Date('2026-08-08T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
function przed(dni) {
  return new Date(TERAZ.getTime() - dni * DAY).toISOString();
}

// ------------------------------------------------------------
// ATRAPA SUPABASE — obsługuje select/eq/or/maybeSingle/update.
// `errors` pozwala wymusić błąd dla konkretnej tabeli (symulacja braku
// kolumny / braku tabeli), `updates` zbiera to, co poszło do bazy.
// ------------------------------------------------------------
function makeFakeSupabase(tables, opts = {}) {
  const errors = opts.errors || {};
  const updates = [];
  const client = {
    _updates: updates,
    from(table) {
      const filters = [];
      let pendingUpdate = null;
      const builder = {
        select() { return builder; },
        update(payload) { pendingUpdate = payload; return builder; },
        eq(col, val) {
          filters.push((row) => String(row[col]) === String(val));
          if (pendingUpdate) {
            if (errors[table]) return Promise.resolve({ data: null, error: errors[table] });
            const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
            rows.forEach((r) => Object.assign(r, pendingUpdate));
            updates.push({ table, payload: pendingUpdate, count: rows.length });
            return Promise.resolve({ data: rows, error: null });
          }
          return builder;
        },
        or(expr) {
          // component_id.eq.X,component_id.is.null
          const eqMatch = /component_id\.eq\.([^,]+)/.exec(expr);
          const wanted = eqMatch ? eqMatch[1] : null;
          filters.push((row) => row.component_id == null || String(row.component_id) === wanted);
          return builder;
        },
        maybeSingle() {
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] });
          const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        then(resolve, reject) {
          // zapytanie bez maybeSingle/single — zwraca listę (fetchComponentHints)
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(resolve, reject);
          const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return client;
}

const BLAD_BRAK_KOLUMNY = { code: 'PGRST204', message: "Could not find the 'content_doses' column of 'focus_blocks' in the schema cache" };
const BLAD_BRAK_TABELI = { code: 'PGRST205', message: 'Could not find the table public.component_hints in the schema cache' };

function dawka(over = {}) {
  return {
    wersja: 1,
    klucz: 'b1:e2:2026-08-08',
    etap: 2,
    wygenerowano_at: TERAZ.toISOString(),
    krok_praktyczny: 'Wyznacz stałą godzinę snu i trzymaj się jej codziennie.',
    dla_chetnych: null,
    segment_id: 'regeneracja',
    component_id: 'K-SEN',
    zrodlo_podpowiedzi: null,
    ...over,
  };
}

// ------------------------------------------------------------
// PRAWDZIWE WIERSZE component_hints — przepisane 1:1 z migracji rundy 3
// (claude/PODPOWIEDZI_Z_MATERIALOW_A.md, sekcja 4.3). Nie wymyślone,
// żeby pomiar kosztu promptu był realny, a nie orientacyjny.
// ------------------------------------------------------------
const K_SEN = 'K-ELEMENT-SEN';       // "Wydłużenie snu nocnego o 46-113 minut"
const K_OBSZAR_SEN = 'K-OBSZAR-SEN'; // "Sen jako podstawa regeneracji"
const K_PSYCHO = 'K-OBSZAR-PSYCHO';
const K_TERM = 'K-OBSZAR-TERM';

function ch(o) {
  return {
    segment_id: 'regeneracja', component_id: null, obszar_name: null, element_name: null,
    odbiorca: 'zawodnik', min_age: null, rodzaj: 'zrobic',
    zrodlo: 'Regeneracja — System Gamechange (pełny)', dowody: null, active: true, ...o,
  };
}

// 24 podpowiedzi segmentu `regeneracja` — komplet, tak jak w bazie.
const REGENERACJA = [
  ch({ klucz: 'regeneracja-wyduzenie-snu-nocnego-o-46-113-minut-01', component_id: K_SEN, obszar_name: 'Sen jako podstawa regeneracji', element_name: 'Wydłużenie snu nocnego o 46-113 minut', hint: 'Minimum 8 godzin snu, a przy intensywnym cyklu treningowym 9. To norma, nie luksus.', odbiorca: 'oba', strony: '2', pozycja: 1 }),
  ch({ klucz: 'regeneracja-wyduzenie-snu-nocnego-o-46-113-minut-02', component_id: K_SEN, obszar_name: 'Sen jako podstawa regeneracji', element_name: 'Wydłużenie snu nocnego o 46-113 minut', hint: 'Wyznacz stałą godzinę snu i trzymaj się jej codziennie, także w weekendy. Zasypianie o różnych porach działa na organizm jak ciągła zmiana strefy czasowej.', odbiorca: 'oba', strony: '2', pozycja: 2 }),
  ch({ klucz: 'regeneracja-wyduzenie-snu-nocnego-o-46-113-minut-03', component_id: K_SEN, obszar_name: 'Sen jako podstawa regeneracji', element_name: 'Wydłużenie snu nocnego o 46-113 minut', hint: 'Na godzinę przed snem ogranicz ekrany tak bardzo, jak potrafisz, i zaciemnij pokój na noc.', odbiorca: 'oba', strony: '2', pozycja: 3 }),
  ch({ klucz: 'regeneracja-wyduzenie-snu-nocnego-o-46-113-minut-04', component_id: K_SEN, obszar_name: 'Sen jako podstawa regeneracji', element_name: 'Wydłużenie snu nocnego o 46-113 minut', hint: 'Ostatnia kawa albo napój energetyczny najpóźniej 6 godzin przed snem. Niezależnie od tego, czy Cię pobudza — to fizjologia, nie odczucia.', odbiorca: 'oba', strony: '2', pozycja: 4 }),
  ch({ klucz: 'regeneracja-wyduzenie-snu-nocnego-o-46-113-minut-05', component_id: K_SEN, obszar_name: 'Sen jako podstawa regeneracji', element_name: 'Wydłużenie snu nocnego o 46-113 minut', hint: 'Ostatni posiłek co najmniej 1,5–2 godziny przed położeniem się. Jeśli musisz zjeść bliżej, niech to będzie coś lekkiego.', odbiorca: 'oba', strony: '2', pozycja: 5 }),
  ch({ klucz: 'regeneracja-wyduzenie-snu-nocnego-o-46-113-minut-06', component_id: K_SEN, obszar_name: 'Sen jako podstawa regeneracji', element_name: 'Wydłużenie snu nocnego o 46-113 minut', hint: 'Sen idzie cyklami po około 1,5 godziny. Sprawdź, przy której długości — 6, 7,5 czy 9 godzin — budzisz się najbardziej rześki. To jest indywidualne.', strony: '7', pozycja: 6 }),
  ch({ klucz: 'regeneracja-sen-jako-podstawa-regeneracji-01', component_id: K_OBSZAR_SEN, obszar_name: 'Sen jako podstawa regeneracji', hint: 'Najwięcej melatoniny wytwarza się między północą a trzecią nad ranem — dlatego warto zasnąć przed północą.', rodzaj: 'zrozumiec', strony: '6', pozycja: 1 }),
  ch({ klucz: 'regeneracja-sen-jako-podstawa-regeneracji-02', component_id: K_OBSZAR_SEN, obszar_name: 'Sen jako podstawa regeneracji', hint: 'W fazie głębokiej mózg zapisuje nowe wzorce ruchowe, decyzje boiskowe i elementy taktyczne. Jakość snu to dosłownie jakość uczenia się piłki nożnej.', rodzaj: 'zrozumiec', strony: '7', pozycja: 2 }),
  ch({ klucz: 'regeneracja-regeneracja-termiczna-zimne-kapiele-01', component_id: K_TERM, obszar_name: 'Regeneracja termiczna (zimne kąpiele)', hint: 'Sauna po ciężkim treningu, gdy jesteś mocno zmęczony, dokłada obciążenia zamiast pomagać. Sensowna jest po ciężkim tygodniu, gdy masz przed sobą dwa dni przerwy.', rodzaj: 'zrozumiec', strony: '7', pozycja: 1 }),
  ch({ klucz: 'regeneracja-regeneracja-psychologiczna-01', component_id: K_PSYCHO, obszar_name: 'Regeneracja psychologiczna', hint: 'Bezpośrednio po treningu, zanim zrobisz cokolwiek innego, usiądź lub połóż się na 3–5 minut. Wdech nosem 4 sekundy, zatrzymanie 2, wydech ustami 6. Ręka na brzuchu ma się unosić, nie klatka.', strony: '4', pozycja: 1 }),
  ch({ klucz: 'regeneracja-regeneracja-psychologiczna-02', component_id: K_PSYCHO, obszar_name: 'Regeneracja psychologiczna', hint: 'Wydech musi być dłuższy niż wdech. Wdech lekko pobudza, wydech wycisza — im dłuższy wydech, tym silniejszy efekt.', rodzaj: 'zrozumiec', strony: '8', pozycja: 2 }),
  ch({ klucz: 'regeneracja-regeneracja-psychologiczna-03', component_id: K_PSYCHO, obszar_name: 'Regeneracja psychologiczna', hint: 'Po intensywnym wysiłku ciało zostaje w trybie gotowości nawet kilka godzin i wtedy regeneracja jest ograniczona, choćbyś leżał spokojnie. Oddech to jedyna część tego układu, którą kontrolujesz świadomie.', rodzaj: 'zrozumiec', strony: '8', pozycja: 3 }),
  ch({ klucz: 'regeneracja-segment-01', hint: 'W ciągu 30–60 minut po treningu zjedz posiłek z węglowodanami i białkiem, z minimum 20–30 gramami białka. Jeśli nie jesteś głodny, zjedz mimo to choćby małą porcję.', odbiorca: 'oba', strony: '3', pozycja: 1 }),
  ch({ klucz: 'regeneracja-segment-02', hint: 'Sprawdzaj kolor moczu: jasnosłomkowy to dobre nawodnienie, ciemnożółty to sygnał, że musisz pić więcej przez cały dzień. Uzupełniaj płyny stopniowo, nie jednym haustem.', strony: '3', pozycja: 2 }),
  ch({ klucz: 'regeneracja-segment-03', hint: 'Agresywne rozciąganie obolałych mięśni i rolowanie bolesnego miejsca mogą pogłębić problem zamiast pomóc. Najpierw usuń to, co zaburza regenerację, dopiero potem dokładaj zabiegi.', rodzaj: 'zrozumiec', strony: '7', pozycja: 3 }),
  ch({ klucz: 'regeneracja-segment-04', hint: 'Trening, który przynosi efekty, to taki, po którym organizm ma warunki odbudować się z nadwyżką. Bez regeneracji trening tylko niszczy, a nie buduje.', rodzaj: 'zrozumiec', strony: '1', pozycja: 4 }),
  ch({ klucz: 'regeneracja-segment-05', hint: 'Magnez działa przez wysycenie organizmu, nie przez jednorazową dawkę. Bierze się go codziennie i regularnie — pierwsze efekty po 1–2 tygodniach, pełne wysycenie po 2–3.', rodzaj: 'zrozumiec', strony: '12–13', pozycja: 5 }),
  ch({ klucz: 'regeneracja-segment-06', hint: 'Forma magnezu znaczy więcej niż liczba na etykiecie. Najtańsze suplementy z tlenkiem magnezu w praktyce się nie wchłaniają.', rodzaj: 'zrozumiec', strony: '11–12', pozycja: 6 }),
  ch({ klucz: 'regeneracja-segment-07', hint: 'Magnez to sprawa do ustalenia z rodzicem — to on kupuje i pilnuje dawki. Pełne wytyczne z liczbami są w jego egzemplarzu materiału.', rodzaj: 'zrozumiec', zrodlo: 'decyzja A9 (tekst systemowy — nie z materiału)', strony: '—', pozycja: 7 }),
  ch({ klucz: 'regeneracja-segment-08', hint: 'Dawka bazowa dla zawodnika ok. 70 kg: 200–400 mg magnezu elementarnego dziennie, wieczorem przed snem. W okresach dużych obciążeń 300–500 mg.', odbiorca: 'rodzic', min_age: 16, strony: '5, 13', pozycja: 8 }),
  ch({ klucz: 'regeneracja-segment-09', hint: 'Wybieraj diglicynian albo cytrynian magnezu, unikaj tlenku. Dawkę liczy się z magnezu elementarnego, nie z masy związku.', odbiorca: 'rodzic', min_age: 16, strony: '5, 13–14', pozycja: 9 }),
  ch({ klucz: 'regeneracja-segment-10', hint: 'Przy zdrowych nerkach przedawkowanie magnezu jest mało prawdopodobne. Pierwszym sygnałem przekroczenia granicy wchłaniania jest biegunka, nie toksyczność.', odbiorca: 'rodzic', min_age: 16, rodzaj: 'zrozumiec', strony: '11', pozycja: 10 }),
  ch({ klucz: 'regeneracja-segment-11', hint: 'Badanie magnezu w surowicy u sportowca ma ograniczoną wartość — organizm broni poziomu we krwi kosztem tkanek. Sens diagnostyczny mają tylko wyniki skrajne.', odbiorca: 'rodzic', min_age: 16, rodzaj: 'zrozumiec', strony: '11', pozycja: 11 }),
  ch({ klucz: 'regeneracja-segment-12', hint: 'L-treonian magnezu to dodatek na funkcje mózgu (koncentracja, kontrola stresu), nie baza. Dla ok. 70 kg 100–200 mg elementarnego dziennie.', odbiorca: 'rodzic', min_age: 16, strony: '12, 13', pozycja: 12 }),
];

(async () => {
  console.log('lib/focus-block-content-store.js — testy jednostkowe (PRAKTYKA A5 08.08.2026)');

  // ══════════════════════════════════════════════════════════
  console.log('\n1. readDoseEnvelope — pięć różnych stanów, nie jedna pustka (R5)');

  await scenario('kolumna NULL -> stan "pusta", NIE "uszkodzona"', () => {
    const r = readDoseEnvelope(null);
    assert.strictEqual(r.stan, 'pusta');
    assert.deepStrictEqual(r.envelope.dawki, []);
  });

  await scenario('poprawna koperta -> stan "ok" i dawki na miejscu', () => {
    const r = readDoseEnvelope({ wersja: 1, dawki: [dawka()] });
    assert.strictEqual(r.stan, 'ok');
    assert.strictEqual(r.envelope.dawki.length, 1);
  });

  await scenario('koperta jako TEKST (klient/atrapa oddaje string) -> parsowana', () => {
    const r = readDoseEnvelope(JSON.stringify({ wersja: 1, dawki: [dawka()] }));
    assert.strictEqual(r.stan, 'ok');
    assert.strictEqual(r.envelope.dawki.length, 1);
  });

  await scenario('tekst, który nie jest JSON-em -> "uszkodzona", nie wyjątek', () => {
    const r = readDoseEnvelope('to nie jest json');
    assert.strictEqual(r.stan, 'uszkodzona');
    assert.deepStrictEqual(r.envelope.dawki, []);
  });

  await scenario('obiekt bez tablicy `dawki` -> "uszkodzona"', () => {
    assert.strictEqual(readDoseEnvelope({ wersja: 1 }).stan, 'uszkodzona');
  });

  await scenario('koperta z NOWSZEJ wersji -> "nieznana_wersja", dawki NIE gubione', () => {
    const r = readDoseEnvelope({ wersja: 7, dawki: [dawka()] });
    assert.strictEqual(r.stan, 'nieznana_wersja');
    assert.strictEqual(r.envelope.dawki.length, 1, 'nie wolno udawać, że koperta jest pusta');
  });

  await scenario('"pusta" i "uszkodzona" to DWA różne stany, nie jeden', () => {
    assert.notStrictEqual(readDoseEnvelope(null).stan, readDoseEnvelope('xxx').stan);
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n2. normalizeDose — dawka bez treści to NIE jest dawka');

  await scenario('practicalStep + forCurious -> pełny wiersz', () => {
    const d = normalizeDose({ practicalStep: 'Zrób A.', forCurious: 'Bo B.' }, {
      focusBlockId: 'b1', stage: 2, segmentId: 'regeneracja', componentId: K_SEN, now: TERAZ,
    });
    assert.strictEqual(d.krok_praktyczny, 'Zrób A.');
    assert.strictEqual(d.dla_chetnych, 'Bo B.');
    assert.strictEqual(d.etap, 2);
    assert.strictEqual(d.wersja, CONTENT_DOSE_VERSION);
    assert.strictEqual(d.segment_id, 'regeneracja');
    assert.strictEqual(d.component_id, K_SEN);
  });

  await scenario('forCurious null -> pole null, nie pusty string ani "null"', () => {
    const d = normalizeDose({ practicalStep: 'Zrób A.', forCurious: null }, { focusBlockId: 'b1', stage: 1, now: TERAZ });
    assert.strictEqual(d.dla_chetnych, null);
  });

  await scenario('forCurious jako sam whitespace -> null (nie renderujemy pustki)', () => {
    const d = normalizeDose({ practicalStep: 'Zrób A.', forCurious: '   ' }, { focusBlockId: 'b1', stage: 1, now: TERAZ });
    assert.strictEqual(d.dla_chetnych, null);
  });

  await scenario('brak practicalStep -> null, NIE pusta skorupa w bazie', () => {
    assert.strictEqual(normalizeDose({ forCurious: 'coś' }, { focusBlockId: 'b1', now: TERAZ }), null);
  });

  await scenario('practicalStep jako sam whitespace -> null', () => {
    assert.strictEqual(normalizeDose({ practicalStep: '   ' }, { focusBlockId: 'b1', now: TERAZ }), null);
  });

  await scenario('wejście null/nie-obiekt -> null (nie rzuca)', () => {
    assert.strictEqual(normalizeDose(null, { focusBlockId: 'b1' }), null);
    assert.strictEqual(normalizeDose('tekst', { focusBlockId: 'b1' }), null);
  });

  await scenario('zrodlo_podpowiedzi ma kształt source_hint z rundy 4 (nie drugi kształt na to samo)', () => {
    const sh = { wersja: 1, klucz: 'regeneracja-segment-04', tresc: 'x', material: 'Regeneracja', strona: '1', rodzaj: 'zrozumiec', celowanie: 'segment', segment_id: 'regeneracja', component_id: null, wybor: 'najlepiej_wycelowana', wszystkie_w_promptcie: 12 };
    const d = normalizeDose({ practicalStep: 'A' }, { focusBlockId: 'b1', stage: 1, sourceHint: sh, now: TERAZ });
    assert.deepStrictEqual(d.zrodlo_podpowiedzi, sh);
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n3. buildDoseKey — deterministyczny, bez Math.random/Date.now w środku');

  await scenario('ten sam blok + etap + dzień -> ten sam klucz (dwa wywołania)', () => {
    assert.strictEqual(buildDoseKey('b1', 2, TERAZ), buildDoseKey('b1', 2, TERAZ));
  });

  await scenario('inny etap -> inny klucz', () => {
    assert.notStrictEqual(buildDoseKey('b1', 2, TERAZ), buildDoseKey('b1', 3, TERAZ));
  });

  await scenario('etap null -> klucz zawiera "brak", nie "null"', () => {
    assert.match(buildDoseKey('b1', null, TERAZ), /:ebrak:/);
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n4. findDoseForStage / findLatestDose');

  const kopertaWielo = {
    wersja: 1,
    dawki: [
      dawka({ klucz: 'k-e1-stara', etap: 1, wygenerowano_at: przed(40) }),
      dawka({ klucz: 'k-e2-stara', etap: 2, wygenerowano_at: przed(30) }),
      dawka({ klucz: 'k-e2-nowa', etap: 2, wygenerowano_at: przed(3) }),
    ],
  };

  await scenario('dla etapu 2 bierze NAJNOWSZĄ z dwóch', () => {
    assert.strictEqual(findDoseForStage(kopertaWielo, 2).klucz, 'k-e2-nowa');
  });

  await scenario('dla etapu bez dawki -> null', () => {
    assert.strictEqual(findDoseForStage(kopertaWielo, 5), null);
  });

  await scenario('pusta koperta -> null (nie rzuca)', () => {
    assert.strictEqual(findDoseForStage(emptyEnvelope(), 1), null);
    assert.strictEqual(findDoseForStage(null, 1), null);
  });

  await scenario('findLatestDose ignoruje etap i bierze najnowszą w ogóle', () => {
    assert.strictEqual(findLatestDose(kopertaWielo).klucz, 'k-e2-nowa');
  });

  await scenario('findLatestDose na pustej kopercie -> null', () => {
    assert.strictEqual(findLatestDose(emptyEnvelope()), null);
  });

  await scenario('dawka sprzed zmiany etapu NADAL jest w magazynie (zawodnik może wrócić)', () => {
    assert.ok(findDoseForStage(kopertaWielo, 1), 'stara dawka etapu 1 nie może zniknąć');
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n5. checkContentDoseCadence — ten sam kontrakt co checkTrainingFocusCadence');

  await scenario('brak dawki dla etapu -> { allowed: true } (generujemy, jak dziś)', () => {
    const r = checkContentDoseCadence({ envelope: emptyEnvelope(), stage: 2, now: TERAZ });
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.reason, 'brak_dawki_dla_etapu');
  });

  await scenario('świeża dawka dla etapu -> { allowed: false } + dawka do pokazania', () => {
    const env = { wersja: 1, dawki: [dawka({ etap: 2, wygenerowano_at: przed(3) })] };
    const r = checkContentDoseCadence({ envelope: env, stage: 2, now: TERAZ });
    assert.strictEqual(r.allowed, false);
    assert.ok(r.dawka, 'blokada MUSI oddać dawkę — inaczej zawodnik traci treść');
    assert.match(r.reason, /odczytana z magazynu/);
  });

  await scenario('dawka starsza niż 14 dni -> znów generujemy', () => {
    const env = { wersja: 1, dawki: [dawka({ etap: 2, wygenerowano_at: przed(15) })] };
    const r = checkContentDoseCadence({ envelope: env, stage: 2, now: TERAZ });
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.reason, 'dawka_przeterminowana');
  });

  await scenario('granica: dokładnie 14 dni -> generujemy (>=, tak jak dziś w generateCheckin)', () => {
    const env = { wersja: 1, dawki: [dawka({ etap: 2, wygenerowano_at: przed(CONTENT_DOSE_CADENCE_DAYS) })] };
    assert.strictEqual(checkContentDoseCadence({ envelope: env, stage: 2, now: TERAZ }).allowed, true);
  });

  await scenario('granica: 13,9 dnia -> jeszcze NIE generujemy', () => {
    const env = { wersja: 1, dawki: [dawka({ etap: 2, wygenerowano_at: przed(13.9) })] };
    assert.strictEqual(checkContentDoseCadence({ envelope: env, stage: 2, now: TERAZ }).allowed, false);
  });

  await scenario('dawka dla INNEGO etapu nie blokuje (zmiana etapu = nowa dawka)', () => {
    const env = { wersja: 1, dawki: [dawka({ etap: 1, wygenerowano_at: przed(1) })] };
    assert.strictEqual(checkContentDoseCadence({ envelope: env, stage: 2, now: TERAZ }).allowed, true);
  });

  await scenario('uszkodzona data wygenerowania -> generujemy (bezpieczna strona)', () => {
    const env = { wersja: 1, dawki: [dawka({ etap: 2, wygenerowano_at: 'nie-data' })] };
    assert.strictEqual(checkContentDoseCadence({ envelope: env, stage: 2, now: TERAZ }).allowed, true);
  });

  await scenario('kontrakt wyniku zgodny z checkTrainingFocusCadence: zawsze pole `allowed` typu boolean', () => {
    for (const env of [emptyEnvelope(), { wersja: 1, dawki: [dawka({ etap: 2, wygenerowano_at: przed(1) })] }]) {
      const r = checkContentDoseCadence({ envelope: env, stage: 2, now: TERAZ });
      assert.strictEqual(typeof r.allowed, 'boolean');
      assert.strictEqual(typeof r.reason, 'string');
    }
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n6. appendDose — idempotentna po kluczu, przycina, sortuje malejąco');

  await scenario('dokłada dawkę na początek', () => {
    const env = appendDose(emptyEnvelope(), dawka());
    assert.strictEqual(env.dawki.length, 1);
    assert.strictEqual(env.wersja, CONTENT_DOSE_VERSION);
  });

  await scenario('DWA przebiegi tego samego dnia dla tego samego etapu -> JEDEN wpis', () => {
    let env = appendDose(emptyEnvelope(), dawka());
    env = appendDose(env, dawka());
    assert.strictEqual(env.dawki.length, 1, 'ten sam klucz nie może zrobić duplikatu');
  });

  await scenario('nowsza dawka ląduje przed starszą', () => {
    let env = appendDose(emptyEnvelope(), dawka({ klucz: 'stara', wygenerowano_at: przed(20) }));
    env = appendDose(env, dawka({ klucz: 'nowa', wygenerowano_at: przed(1) }));
    assert.strictEqual(env.dawki[0].klucz, 'nowa');
  });

  await scenario(`przycina do ${MAX_STORED_DOSES} — wiersz focus_blocks nie puchnie bez końca`, () => {
    let env = emptyEnvelope();
    for (let i = 0; i < MAX_STORED_DOSES + 8; i++) {
      env = appendDose(env, dawka({ klucz: `k${i}`, etap: i, wygenerowano_at: przed(MAX_STORED_DOSES + 8 - i) }));
    }
    assert.strictEqual(env.dawki.length, MAX_STORED_DOSES);
  });

  await scenario('przycinanie wyrzuca NAJSTARSZE, nie najnowsze', () => {
    let env = emptyEnvelope();
    for (let i = 0; i < MAX_STORED_DOSES + 3; i++) {
      env = appendDose(env, dawka({ klucz: `k${i}`, etap: i, wygenerowano_at: przed(MAX_STORED_DOSES + 3 - i) }));
    }
    assert.strictEqual(env.dawki[0].klucz, `k${MAX_STORED_DOSES + 2}`);
    assert.ok(!env.dawki.some((d) => d.klucz === 'k0'), 'najstarsza powinna wypaść');
  });

  await scenario('appendDose(null) nie gubi tego, co już jest', () => {
    const env = appendDose({ wersja: 1, dawki: [dawka()] }, null);
    assert.strictEqual(env.dawki.length, 1);
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n7. describeDoseState — jawny stan także (zwłaszcza) gdy nic się nie stało');

  await scenario('brak kolumny jest WIDOCZNY w logu', () => {
    const log = describeDoseState({ stanKolumny: 'brak_kolumny', stanKoperty: 'pusta', zapis: 'brak_kolumny' });
    assert.match(log, /kolumna=brak_kolumny/);
    assert.match(log, /zapis=brak_kolumny/);
  });

  await scenario('odczyt z magazynu jest WIDOCZNY w logu (to jest oszczędność w złotówkach)', () => {
    const kad = { allowed: false, reason: 'x' };
    assert.match(describeDoseState({ stanKolumny: 'ok', stanKoperty: 'ok', kadencja: kad }), /ODCZYT_Z_MAGAZYNU/);
  });

  await scenario('generowanie jest widoczne razem z powodem', () => {
    const kad = { allowed: true, reason: 'brak_dawki_dla_etapu' };
    assert.match(describeDoseState({ stanKolumny: 'ok', stanKoperty: 'pusta', kadencja: kad }), /generujemy=tak \(brak_dawki_dla_etapu\)/);
  });

  await scenario('log zaczyna się od [dawka] — jednym grepem w Vercelu', () => {
    assert.ok(describeDoseState({}).startsWith('[dawka] '));
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n8. fetchDoseEnvelope — I/O, nigdy nie rzuca');

  await scenario('wiersz z kopertą -> stanKolumny ok, dawki na miejscu', async () => {
    const sb = makeFakeSupabase({ focus_blocks: [{ id: 'b1', content_doses: { wersja: 1, dawki: [dawka()] } }] });
    const r = await fetchDoseEnvelope(sb, 'b1');
    assert.strictEqual(r.stanKolumny, 'ok');
    assert.strictEqual(r.stanKoperty, 'ok');
    assert.strictEqual(r.envelope.dawki.length, 1);
  });

  await scenario('kolumna istnieje, ale NULL -> "ok" + "pusta" (to NIE jest błąd)', async () => {
    const sb = makeFakeSupabase({ focus_blocks: [{ id: 'b1', content_doses: null }] });
    const r = await fetchDoseEnvelope(sb, 'b1');
    assert.strictEqual(r.stanKolumny, 'ok');
    assert.strictEqual(r.stanKoperty, 'pusta');
  });

  await scenario('BRAK KOLUMNY (migracja niewklejona) -> "brak_kolumny", nie wyjątek', async () => {
    const sb = makeFakeSupabase({ focus_blocks: [] }, { errors: { focus_blocks: BLAD_BRAK_KOLUMNY } });
    const r = await fetchDoseEnvelope(sb, 'b1');
    assert.strictEqual(r.stanKolumny, 'brak_kolumny');
    assert.deepStrictEqual(r.envelope.dawki, []);
  });

  await scenario('brak wiersza -> "brak_wiersza", odróżnialne od "brak_kolumny"', async () => {
    const sb = makeFakeSupabase({ focus_blocks: [] });
    const r = await fetchDoseEnvelope(sb, 'b1');
    assert.strictEqual(r.stanKolumny, 'brak_wiersza');
  });

  await scenario('inny błąd bazy -> "blad" z treścią, odróżnialny od braku kolumny', async () => {
    const sb = makeFakeSupabase({ focus_blocks: [] }, { errors: { focus_blocks: { code: '08006', message: 'connection failure' } } });
    const r = await fetchDoseEnvelope(sb, 'b1');
    assert.strictEqual(r.stanKolumny, 'blad');
    assert.match(r.blad, /connection failure/);
  });

  await scenario('brak focusBlockId -> "brak_bloku" (nie strzela do bazy)', async () => {
    const r = await fetchDoseEnvelope(makeFakeSupabase({}), null);
    assert.strictEqual(r.stanKolumny, 'brak_bloku');
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n9. saveContentDose — zapis + ścieżka odzysku');

  await scenario('zapisuje dawkę do focus_blocks.content_doses', async () => {
    const wiersze = [{ id: 'b1', content_doses: null }];
    const sb = makeFakeSupabase({ focus_blocks: wiersze });
    const r = await saveContentDose(sb, { focusBlockId: 'b1', dose: dawka() });
    assert.strictEqual(r.stan, 'zapisano');
    assert.strictEqual(r.liczbaDawek, 1);
    assert.strictEqual(sb._updates.length, 1);
    assert.strictEqual(sb._updates[0].payload.content_doses.dawki.length, 1);
  });

  await scenario('dokłada do istniejących, nie kasuje poprzednich', async () => {
    const wiersze = [{ id: 'b1', content_doses: { wersja: 1, dawki: [dawka({ klucz: 'stara', etap: 1, wygenerowano_at: przed(30) })] } }];
    const sb = makeFakeSupabase({ focus_blocks: wiersze });
    const r = await saveContentDose(sb, { focusBlockId: 'b1', dose: dawka({ klucz: 'nowa', etap: 2 }) });
    assert.strictEqual(r.liczbaDawek, 2);
  });

  await scenario('BRAK KOLUMNY -> "brak_kolumny", pytanie kontrolne się NIE wywraca', async () => {
    const sb = makeFakeSupabase({ focus_blocks: [] }, { errors: { focus_blocks: BLAD_BRAK_KOLUMNY } });
    const r = await saveContentDose(sb, { focusBlockId: 'b1', dose: dawka() });
    assert.strictEqual(r.stan, 'brak_kolumny');
  });

  await scenario('koperta z nowszej wersji -> NIE nadpisujemy jej', async () => {
    const wiersze = [{ id: 'b1', content_doses: { wersja: 9, dawki: [dawka()] } }];
    const sb = makeFakeSupabase({ focus_blocks: wiersze });
    const r = await saveContentDose(sb, { focusBlockId: 'b1', dose: dawka({ klucz: 'nowa' }) });
    assert.strictEqual(r.stan, 'nieznana_wersja');
    assert.strictEqual(sb._updates.length, 0, 'ani jednego UPDATE na nowszej kopercie');
  });

  await scenario('dose = null -> "nic_do_zapisania", zero zapytań', async () => {
    const sb = makeFakeSupabase({ focus_blocks: [{ id: 'b1', content_doses: null }] });
    const r = await saveContentDose(sb, { focusBlockId: 'b1', dose: null });
    assert.strictEqual(r.stan, 'nic_do_zapisania');
    assert.strictEqual(sb._updates.length, 0);
  });

  await scenario('brak focusBlockId -> "blad" z czytelnym komunikatem', async () => {
    const r = await saveContentDose(makeFakeSupabase({}), { dose: dawka() });
    assert.strictEqual(r.stan, 'blad');
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n10. getDoseForBlock — czysty odczyt, ZERO wywołań modelu');

  await scenario('bez podanego etapu -> najnowsza dawka w ogóle', async () => {
    const sb = makeFakeSupabase({ focus_blocks: [{ id: 'b1', content_doses: kopertaWielo }] });
    const r = await getDoseForBlock(sb, 'b1');
    assert.strictEqual(r.dawka.klucz, 'k-e2-nowa');
  });

  await scenario('z podanym etapem -> dawka tego etapu', async () => {
    const sb = makeFakeSupabase({ focus_blocks: [{ id: 'b1', content_doses: kopertaWielo }] });
    const r = await getDoseForBlock(sb, 'b1', { stage: 1 });
    assert.strictEqual(r.dawka.klucz, 'k-e1-stara');
  });

  await scenario('oddaje też CAŁĄ listę — zawodnik może wrócić do wcześniejszych', async () => {
    const sb = makeFakeSupabase({ focus_blocks: [{ id: 'b1', content_doses: kopertaWielo }] });
    const r = await getDoseForBlock(sb, 'b1');
    assert.strictEqual(r.wszystkie.length, 3);
  });

  await scenario('brak kolumny -> dawka null + stan nazwany, nie wyjątek', async () => {
    const sb = makeFakeSupabase({ focus_blocks: [] }, { errors: { focus_blocks: BLAD_BRAK_KOLUMNY } });
    const r = await getDoseForBlock(sb, 'b1');
    assert.strictEqual(r.dawka, null);
    assert.strictEqual(r.stanKolumny, 'brak_kolumny');
  });

  await scenario('zwraca gotową linię logu', async () => {
    const sb = makeFakeSupabase({ focus_blocks: [{ id: 'b1', content_doses: kopertaWielo }] });
    const r = await getDoseForBlock(sb, 'b1');
    assert.match(r.log, /dawek_w_magazynie=3/);
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n11. loadHintsForFocusBlock — B24: Element Bloku wreszcie celuje');

  const UZYTKOWNICY = [
    { id: 'u16', birth_year: 2009 }, // dolna granica 16 w 2026 -> przechodzi
    { id: 'u14', birth_year: 2011 }, // dolna granica 14 -> nie przechodzi
    { id: 'u-brak', birth_year: null },
  ];

  await scenario('component_id Bloku celuje w Element — 6 podpowiedzi "Wydłużenie snu" na czele', async () => {
    const sb = makeFakeSupabase({ component_hints: REGENERACJA, users: UZYTKOWNICY });
    const r = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: K_SEN, userId: 'u16', now: TERAZ });
    assert.strictEqual(r.stanCelowania, 'element_bloku');
    assert.ok(r.selection.wycelowaneWCel >= 6, `oczekiwano >=6 wycelowanych, jest ${r.selection.wycelowaneWCel}`);
    assert.strictEqual(r.selection.hints[0].component_id, K_SEN, 'pierwsza podpowiedź MUSI być tą wycelowaną w Element');
  });

  await scenario('BLOK BEZ ELEMENTU -> stan "blok_bez_elementu", zero wycelowanych, ale podpowiedzi są', async () => {
    const sb = makeFakeSupabase({ component_hints: REGENERACJA, users: UZYTKOWNICY });
    const r = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: null, userId: 'u16', now: TERAZ });
    assert.strictEqual(r.stanCelowania, 'blok_bez_elementu');
    assert.strictEqual(r.selection.wycelowaneWCel, 0);
    assert.ok(r.selection.hints.length > 0, 'segmentowe reguły nadal mają dojechać');
  });

  await scenario('A9 — do promptu zawodnika NIE trafia ani jedna treść dla rodzica', async () => {
    const sb = makeFakeSupabase({ component_hints: REGENERACJA, users: UZYTKOWNICY });
    const r = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: K_SEN, userId: 'u16', now: TERAZ });
    assert.ok(r.selection.hints.every((h) => h.odbiorca !== 'rodzic'));
    assert.strictEqual(r.selection.odrzuconePrzezOdbiorce, 5, 'regeneracja ma 5 wierszy odbiorca=rodzic');
  });

  await scenario('A9 na TREŚCI bloku promptu — fraza "magnezu elementarnego" nie dociera do modelu', async () => {
    const sb = makeFakeSupabase({ component_hints: REGENERACJA, users: UZYTKOWNICY });
    const r = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: K_SEN, userId: 'u16', now: TERAZ });
    const blok = buildHintPromptBlock(r.selection);
    assert.ok(!blok.includes('magnezu elementarnego'), 'dawka suplementacyjna nie może wejść do promptu zawodnika');
  });

  await scenario('14-latek: bramka wiekowa nic nie ukrywa dodatkowo (znalezisko A20 nadal aktualne)', async () => {
    const sb = makeFakeSupabase({ component_hints: REGENERACJA, users: UZYTKOWNICY });
    const r = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: K_SEN, userId: 'u14', now: TERAZ });
    assert.strictEqual(r.selection.ukryteZPowoduWieku, 0, 'wszystkie min_age=16 mają jednocześnie odbiorca=rodzic');
    assert.strictEqual(r.selection.wiekNieznany, false);
  });

  await scenario('NIEZNANY ROCZNIK -> wiekNieznany=true (jawny stan, nie cicha pustka)', async () => {
    const sb = makeFakeSupabase({ component_hints: REGENERACJA, users: UZYTKOWNICY });
    const r = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: K_SEN, userId: 'u-brak', now: TERAZ });
    assert.strictEqual(r.selection.wiekNieznany, true);
    assert.strictEqual(r.stanWieku, 'brak_rocznika');
  });

  await scenario('"nie wiem" i "wiem i nic nie ukryłem" dają DWA różne wyniki', async () => {
    const sb = makeFakeSupabase({ component_hints: REGENERACJA, users: UZYTKOWNICY });
    const a = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: K_SEN, userId: 'u16', now: TERAZ });
    const b = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: K_SEN, userId: 'u-brak', now: TERAZ });
    assert.notStrictEqual(a.selection.wiekNieznany, b.selection.wiekNieznany);
  });

  await scenario('BRAK TABELI component_hints -> stanTabeli "brak_tabeli", pusty blok promptu', async () => {
    const sb = makeFakeSupabase({ users: UZYTKOWNICY }, { errors: { component_hints: BLAD_BRAK_TABELI } });
    const r = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: K_SEN, userId: 'u16', now: TERAZ });
    assert.strictEqual(r.stanTabeli, 'brak_tabeli');
    assert.strictEqual(buildHintPromptBlock(r.selection), '', 'bez tabeli prompt musi zostać dokładnie dzisiejszy');
  });

  await scenario('limit 12 obowiązuje także tutaj', async () => {
    const sb = makeFakeSupabase({ component_hints: REGENERACJA, users: UZYTKOWNICY });
    const r = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: K_SEN, userId: 'u16', now: TERAZ });
    assert.ok(r.selection.hints.length <= 12);
    assert.ok(r.selection.przycieteLimitem > 0);
  });

  await scenario('każda linia promptu niesie materiał i stronę (nie nagłówek sekcji)', async () => {
    const sb = makeFakeSupabase({ component_hints: REGENERACJA, users: UZYTKOWNICY });
    const r = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: K_SEN, userId: 'u16', now: TERAZ });
    const linie = buildHintPromptBlock(r.selection).split('\n').filter((l) => l.startsWith('- ('));
    assert.strictEqual(linie.length, r.selection.hints.length);
    linie.forEach((l) => assert.match(l, /\(Regeneracja — System Gamechange \(pełny\), s\. /));
  });

  await scenario('podpowiedź systemowa A9 (strony "—") NIE dostaje fałszywego numeru strony', async () => {
    const sb = makeFakeSupabase({ component_hints: REGENERACJA, users: UZYTKOWNICY });
    const r = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: null, userId: 'u16', now: TERAZ });
    const sh = pickShowcaseHint(r.selection, 'regeneracja-segment-07');
    if (sh && sh.klucz === 'regeneracja-segment-07') assert.strictEqual(sh.strona, null);
  });

  // ══════════════════════════════════════════════════════════
  console.log('\n12. KOSZT — ile realnie dokładamy do promptu fazy 2');

  await scenario('brak podpowiedzi kosztuje DOKŁADNIE zero znaków', () => {
    assert.strictEqual(buildHintPromptBlock({ hints: [] }), '');
    assert.strictEqual(buildHintPromptBlock(null), '');
  });

  await scenario('regeneracja + Element snu: blok podpowiedzi mieści się poniżej 4 500 znaków', async () => {
    const sb = makeFakeSupabase({ component_hints: REGENERACJA, users: UZYTKOWNICY });
    const r = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: K_SEN, userId: 'u16', now: TERAZ });
    const dl = buildHintPromptBlock(r.selection).length;
    console.log(`       [pomiar] blok podpowiedzi dla regeneracja+Element: ${dl} znaków, ${r.selection.hints.length} podpowiedzi`);
    assert.ok(dl > 0 && dl < 4500, `nieoczekiwana długość: ${dl}`);
  });

  await scenario('pickShowcaseHint zwraca kształt gotowy na ekran (kontrakt rundy 4)', async () => {
    const sb = makeFakeSupabase({ component_hints: REGENERACJA, users: UZYTKOWNICY });
    const r = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: K_SEN, userId: 'u16', now: TERAZ });
    const sh = pickShowcaseHint(r.selection, null);
    assert.strictEqual(sh.wersja, 1);
    assert.strictEqual(sh.celowanie, 'element_celu');
    assert.strictEqual(sh.wybor, 'najlepiej_wycelowana');
    assert.ok(typeof sh.tresc === 'string' && sh.tresc.length > 0);
  });

  await scenario('model wskazał klucz -> wybór "wskazana_przez_ai", nie pierwsza z brzegu', async () => {
    const sb = makeFakeSupabase({ component_hints: REGENERACJA, users: UZYTKOWNICY });
    const r = await loadHintsForFocusBlock(sb, { segmentId: 'regeneracja', componentId: K_SEN, userId: 'u16', now: TERAZ });
    const sh = pickShowcaseHint(r.selection, 'regeneracja-wyduzenie-snu-nocnego-o-46-113-minut-04');
    assert.strictEqual(sh.wybor, 'wskazana_przez_ai');
    assert.strictEqual(sh.klucz, 'regeneracja-wyduzenie-snu-nocnego-o-46-113-minut-04');
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
