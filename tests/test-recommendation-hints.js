// ============================================================
// GAMECHANGE — tests/test-recommendation-hints.js
// ============================================================
// PODPOWIEDZI SILNIK A4 08.08.2026 — NOWY PLIK.
//
// Testuje `lib/recommendation-hints.js` — warstwę, która podłącza 214
// podpowiedzi z materiałów Kuby (`component_hints`) do promptu silnika
// rekomendacji i do zapisu w `decision_recommendations`.
//
// DLACZEGO TEN PLIK ISTNIEJE NA DYSKU, A NIE W SESJI (ograniczenie O11):
// runda 3 napisała 55 scenariuszy dla panelu trenera i wszystkie zniknęły
// razem z sesją, bo `tests/` nie należało do niczyjego pasa. Od rundy 4
// sesja, która zmienia plik, jest właścicielem jego testów. To jest ten
// zapis.
//
// CO JEST TU POKRYTE — trzy reguły z polecenia + R5:
//   1. sortowanie po celowaniu (Element celu -> Obszar -> segmentowe),
//   2. bramka wiekowa A9 z JAWNYM stanem "nie wiem" przy braku rocznika,
//   3. `odbiorca` — nigdy 'rodzic' do promptu zawodnika,
//   4. R5: odróżnienie zamierzonego `component_id=NULL` (reguła
//      przekrojowa) od nieudanego dopasowania nazwy,
//   5. R5: brak tabeli `component_hints` -> jawny stan, nie cicha pustka,
//   6. R1: kontrakt podpowiedzi jadącej na ekran (treść/materiał/strona),
//   7. limit 12 i koszt promptu.
//
// ŚWIADOMIE NIE POWTARZAMY: całego `generateRecommendation()` (orkiestrator
// wymagałby atrapy globalnego `fetch` dla Anthropic — poza ustalonym w tym
// projekcie zakresem testów, ta sama granica co w
// test-generate-recommendation.js).
//
// Uruchomienie: node tests/test-recommendation-hints.js
// ============================================================

const assert = require('assert');

const {
  HINT_LIMIT,
  computeAgeLowerBound,
  classifyHint,
  applyAgeGate,
  isPlayerAudience,
  selectHintsForPrompt,
  formatHintLine,
  buildHintPromptBlock,
  pickShowcaseHint,
  describeHintState,
  isMissingTableError,
  isMissingColumnError,
  fetchComponentHints,
  fetchPlayerBirthYear,
  fetchGoalComponentId,
  loadHintsForRecommendation,
} = require('../lib/recommendation-hints.js');

// ------------------------------------------------------------
// Atrapa Supabase — tylko tyle, ile ta warstwa realnie woła:
// .from().select().eq().eq().or() oraz .maybeSingle().
// ------------------------------------------------------------
function makeFakeSupabase(tables = {}, errors = {}) {
  const state = {};
  for (const [k, v] of Object.entries(tables)) state[k] = v.map((r) => ({ ...r }));
  return {
    _state: state,
    from(table) {
      const filters = [];
      const orFilters = [];
      function rows() {
        const base = (state[table] || []).filter((r) => filters.every((f) => f(r)));
        if (!orFilters.length) return base;
        return base.filter((r) => orFilters.some((f) => f(r)));
      }
      const builder = {
        select() { return builder; },
        eq(col, val) { filters.push((r) => r[col] === val); return builder; },
        or(expr) {
          // Obsługuje dokładnie ten kształt, którego używa fetchComponentHints:
          // "component_id.eq.<v>,component_id.is.null"
          for (const czesc of String(expr).split(',')) {
            const [col, op, val] = czesc.split('.');
            if (op === 'is' && val === 'null') orFilters.push((r) => r[col] == null);
            else if (op === 'eq') orFilters.push((r) => String(r[col]) === String(val));
          }
          return builder;
        },
        maybeSingle() {
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] });
          return Promise.resolve({ data: rows()[0] || null, error: null });
        },
        then(resolve, reject) {
          if (errors[table]) {
            return Promise.resolve({ data: null, error: errors[table] }).then(resolve, reject);
          }
          return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

// ------------------------------------------------------------
// Prawdziwe wiersze z migracji (claude/PODPOWIEDZI_Z_MATERIALOW_A.md,
// sekcja 4.3) — nie wymyślone, żeby testy mierzyły realne długości.
// ------------------------------------------------------------
function h(over = {}) {
  return {
    klucz: 'moc-segment-01', segment_id: 'moc', component_id: null,
    obszar_name: null, element_name: null,
    hint: 'Między sesjami zostaw minimum 48 godzin przerwy, szczególnie po plyometrii. Mecz powinien być co najmniej 48 godzin po sesji plyometrycznej.',
    odbiorca: 'zawodnik', min_age: null, rodzaj: 'zrobic',
    zrodlo: 'Moc — System Gamechange (pełny)', strony: '4', dowody: null,
    pozycja: 1, active: true,
    ...over,
  };
}

const HINT_ELEMENT = h({
  klucz: 'moc-baza-siowa-dolnych-partii-przysiad-martwy-ci-01',
  component_id: 'K-ELEMENT',
  obszar_name: 'Potencjał siłowy (siła maksymalna)',
  element_name: 'Baza siłowa dolnych partii (przysiad/martwy ciąg)',
  hint: 'Jeśli masz mało czasu, trenuj nogi i biodra. To one generują eksplozję w piłce — góra ciała tylko wspiera kontakt. Przy pełnym czasie pracuj nad obiema.',
  strony: '3', pozycja: 1,
});
const HINT_OBSZAR = h({
  klucz: 'moc-recykling-energii-sprezystej-plyometria-ssc-01',
  component_id: 'K-OBSZAR',
  obszar_name: 'Recykling energii sprężystej (plyometria/SSC)',
  element_name: null,
  hint: 'Cykl rozciągnięcie-skurcz ma dwie prędkości: wolną i szybką. W piłce potrzebujesz obu.',
  rodzaj: 'zrozumiec', strony: '13', pozycja: 1,
});
const HINT_SEGMENT = h(); // component_id NULL + obie nazwy NULL = zamierzona reguła
const HINT_NIEDOPASOWANY = h({
  klucz: 'moc-cos-czego-nie-ma-w-bazie-01',
  component_id: null,
  obszar_name: 'Potencjał siłowy (siła maksymalna)',
  element_name: 'Nazwa, której nie ma w segment_components',
  hint: 'Podpowiedź, której migracja nie zdołała przypiąć do komponentu.',
  pozycja: 1,
});
const HINT_INNY_ELEMENT = h({
  klucz: 'moc-trening-jednostronny-unilateralny-01',
  component_id: 'K-INNY',
  obszar_name: 'Potencjał siłowy (siła maksymalna)',
  element_name: 'Trening jednostronny (unilateralny)',
  hint: 'W planie mocy dwa ćwiczenia robisz na jedną stronę.',
  pozycja: 1,
});
const HINT_RODZIC = h({
  klucz: 'regeneracja-segment-08', segment_id: 'regeneracja',
  hint: 'Dawka bazowa dla zawodnika ok. 70 kg: 200–400 mg magnezu elementarnego dziennie, wieczorem przed snem. W okresach dużych obciążeń 300–500 mg.',
  odbiorca: 'rodzic', min_age: 16,
  zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '5, 13', pozycja: 8,
});
const HINT_OBA_Z_WIEKIEM = h({
  klucz: 'test-oba-z-wiekiem', odbiorca: 'oba', min_age: 16,
  hint: 'Treść dla obu odbiorców, ale z dawką — bramka 16 lat.',
});

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

(async () => {
  console.log('recommendation-hints.js — testy jednostkowe (214 podpowiedzi z materiałów -> prompt + ekran)');

  // ==========================================================
  console.log('\n1. computeAgeLowerBound — DOLNA granica wieku z samego rocznika');

  const NOW_2026 = new Date(Date.UTC(2026, 7, 8));

  await scenario('rocznik 2009 w 2026 -> dolna granica 16 (górna 17)', () => {
    assert.strictEqual(computeAgeLowerBound(2009, NOW_2026), 16);
  });

  await scenario('rocznik 2010 w 2026 -> dolna granica 15, mimo że zawodnik MOŻE już mieć 16', () => {
    assert.strictEqual(computeAgeLowerBound(2010, NOW_2026), 15);
  });

  await scenario('brak rocznika (null/undefined/pusty string) -> null, czyli "nie wiem"', () => {
    assert.strictEqual(computeAgeLowerBound(null, NOW_2026), null);
    assert.strictEqual(computeAgeLowerBound(undefined, NOW_2026), null);
    assert.strictEqual(computeAgeLowerBound('', NOW_2026), null);
  });

  await scenario('rocznik nieliczbowy -> null, nie NaN (NaN po cichu przechodziłby porównania)', () => {
    assert.strictEqual(computeAgeLowerBound('nie-rok', NOW_2026), null);
  });

  await scenario('rocznik jako string cyfr -> liczony normalnie (baza może zwrócić text)', () => {
    assert.strictEqual(computeAgeLowerBound('2005', NOW_2026), 20);
  });

  // ==========================================================
  console.log('\n2. classifyHint — R5 pkt 2: odróżnienie zamierzonego NULL od nieudanego dopasowania');

  await scenario('component_id NULL + obie nazwy NULL -> "segment" (zamierzona reguła przekrojowa, 108 z 214)', () => {
    assert.strictEqual(classifyHint(HINT_SEGMENT, 'K-ELEMENT'), 'segment');
  });

  await scenario('component_id NULL + wypełniona nazwa Elementu -> "niedopasowany" (nieudane dopasowanie)', () => {
    assert.strictEqual(classifyHint(HINT_NIEDOPASOWANY, 'K-ELEMENT'), 'niedopasowany');
  });

  await scenario('component_id NULL + wypełniona SAMA nazwa Obszaru -> też "niedopasowany"', () => {
    const x = h({ component_id: null, obszar_name: 'Jakiś Obszar', element_name: null });
    assert.strictEqual(classifyHint(x, null), 'niedopasowany');
  });

  await scenario('te dwa przypadki wyglądają w bazie identycznie (component_id IS NULL) — a dostają różne klasy', () => {
    assert.strictEqual(HINT_SEGMENT.component_id, null);
    assert.strictEqual(HINT_NIEDOPASOWANY.component_id, null);
    assert.notStrictEqual(
      classifyHint(HINT_SEGMENT, null),
      classifyHint(HINT_NIEDOPASOWANY, null)
    );
  });

  await scenario('component_id == Element celu -> "element_celu"', () => {
    assert.strictEqual(classifyHint(HINT_ELEMENT, 'K-ELEMENT'), 'element_celu');
  });

  await scenario('component_id inny niż cel, ale poziom Obszaru -> "obszar" (nadal wartościowe)', () => {
    assert.strictEqual(classifyHint(HINT_OBSZAR, 'K-ELEMENT'), 'obszar');
  });

  await scenario('component_id inny niż cel i to obcy Element -> "inny_element"', () => {
    assert.strictEqual(classifyHint(HINT_INNY_ELEMENT, 'K-ELEMENT'), 'inny_element');
  });

  await scenario('brak Elementu celu (goalComponentId null) -> Element nie awansuje, zostaje "inny_element"', () => {
    assert.strictEqual(classifyHint(HINT_ELEMENT, null), 'inny_element');
  });

  // ==========================================================
  console.log('\n3. Sortowanie po celowaniu — Element celu PRZED Obszarem PRZED segmentowymi');

  await scenario('kolejność dokładnie taka, jak wymaga polecenie', () => {
    const sel = selectHintsForPrompt({
      hints: [HINT_SEGMENT, HINT_NIEDOPASOWANY, HINT_OBSZAR, HINT_ELEMENT],
      goalComponentId: 'K-ELEMENT',
    });
    assert.deepStrictEqual(
      sel.hints.map((x) => x.celowanie),
      ['element_celu', 'obszar', 'segment', 'niedopasowany']
    );
  });

  await scenario('obcy Element domyślnie NIE wchodzi do promptu (nie dotyczy zawodnika)', () => {
    const sel = selectHintsForPrompt({
      hints: [HINT_ELEMENT, HINT_INNY_ELEMENT], goalComponentId: 'K-ELEMENT',
    });
    assert.strictEqual(sel.hints.length, 1);
    assert.strictEqual(sel.hints[0].klucz, HINT_ELEMENT.klucz);
    assert.strictEqual(sel.pominieteObceElementy, 1);
  });

  await scenario('w obrębie tej samej rangi decyduje `pozycja` (kolejność z materiału)', () => {
    const a = h({ klucz: 'a', pozycja: 3 });
    const b = h({ klucz: 'b', pozycja: 1 });
    const c = h({ klucz: 'c', pozycja: 2 });
    const sel = selectHintsForPrompt({ hints: [a, b, c] });
    assert.deepStrictEqual(sel.hints.map((x) => x.klucz), ['b', 'c', 'a']);
  });

  await scenario('przy równej `pozycja` sortowanie jest deterministyczne (po kluczu), nie losowe', () => {
    const x = h({ klucz: 'zzz', pozycja: 1 });
    const y = h({ klucz: 'aaa', pozycja: 1 });
    const s1 = selectHintsForPrompt({ hints: [x, y] });
    const s2 = selectHintsForPrompt({ hints: [y, x] });
    assert.deepStrictEqual(s1.hints.map((k) => k.klucz), s2.hints.map((k) => k.klucz));
    assert.strictEqual(s1.hints[0].klucz, 'aaa');
  });

  await scenario('brak `pozycja` nie wywraca sortowania — ląduje na końcu swojej rangi', () => {
    const bez = h({ klucz: 'bez-pozycji', pozycja: null });
    const z = h({ klucz: 'z-pozycja', pozycja: 5 });
    const sel = selectHintsForPrompt({ hints: [bez, z] });
    assert.deepStrictEqual(sel.hints.map((k) => k.klucz), ['z-pozycja', 'bez-pozycji']);
  });

  // ==========================================================
  console.log('\n4. Bramka wiekowa (decyzja A9) — i R5 pkt 3: nieznany wiek to JAWNY stan');

  await scenario('min_age=NULL -> zawsze przechodzi, niezależnie od wieku', () => {
    const r = applyAgeGate([h({ min_age: null })], 12);
    assert.strictEqual(r.hints.length, 1);
    assert.strictEqual(r.ukryteZPowoduWieku, 0);
  });

  await scenario('min_age=16, dolna granica 16 -> przechodzi', () => {
    const r = applyAgeGate([h({ min_age: 16 })], 16);
    assert.strictEqual(r.hints.length, 1);
  });

  await scenario('min_age=16, dolna granica 15 -> NIE przechodzi (bezpieczna strona błędu)', () => {
    const r = applyAgeGate([h({ min_age: 16 })], 15);
    assert.strictEqual(r.hints.length, 0);
    assert.strictEqual(r.ukryteZPowoduWieku, 1);
  });

  await scenario('WIEK NIEZNANY -> podpowiedzi z dawkami znikają, ale wynik MÓWI o tym wprost', () => {
    const r = applyAgeGate([h({ min_age: 16 }), h({ min_age: null })], null);
    assert.strictEqual(r.wiekNieznany, true);
    assert.strictEqual(r.ukryteZPowoduWieku, 1);
    assert.strictEqual(r.hints.length, 1);
  });

  await scenario('to jest RÓŻNICA wobec "sprawdziłem i nic nie ukryłem" — dwa różne wyniki, nie jeden', () => {
    const nieznany = applyAgeGate([h({ min_age: 16 })], null);
    const doroslyBezUkrytych = applyAgeGate([h({ min_age: 16 })], 20);
    assert.strictEqual(nieznany.wiekNieznany, true);
    assert.strictEqual(doroslyBezUkrytych.wiekNieznany, false);
    assert.notStrictEqual(nieznany.ukryteZPowoduWieku, doroslyBezUkrytych.ukryteZPowoduWieku);
  });

  await scenario('selectHintsForPrompt przenosi oba pola wieku do wyniku, nie gubi ich po drodze', () => {
    const sel = selectHintsForPrompt({ hints: [HINT_OBA_Z_WIEKIEM, HINT_SEGMENT], ageLowerBound: null });
    assert.strictEqual(sel.wiekNieznany, true);
    assert.strictEqual(sel.ukryteZPowoduWieku, 1);
    assert.strictEqual(sel.hints.length, 1);
  });

  // ==========================================================
  console.log('\n5. `odbiorca` — do promptu zawodnika NIGDY nie idzie treść dla rodzica');

  await scenario('isPlayerAudience: zawodnik i oba -> tak; rodzic -> nie', () => {
    assert.strictEqual(isPlayerAudience({ odbiorca: 'zawodnik' }), true);
    assert.strictEqual(isPlayerAudience({ odbiorca: 'oba' }), true);
    assert.strictEqual(isPlayerAudience({ odbiorca: 'rodzic' }), false);
  });

  await scenario('podpowiedź "rodzic" odpada nawet dla 20-latka (to nie jest bramka wiekowa)', () => {
    const sel = selectHintsForPrompt({ hints: [HINT_RODZIC, HINT_SEGMENT], ageLowerBound: 20 });
    assert.strictEqual(sel.hints.length, 1);
    assert.strictEqual(sel.hints[0].odbiorca, 'zawodnik');
    assert.strictEqual(sel.odrzuconePrzezOdbiorce, 1);
  });

  await scenario('żadna podpowiedź w bloku promptu nie ma odbiorcy "rodzic" — sprawdzone na treści', () => {
    const sel = selectHintsForPrompt({ hints: [HINT_RODZIC, HINT_SEGMENT], ageLowerBound: 20 });
    const blok = buildHintPromptBlock(sel);
    assert.ok(!blok.includes('magnezu elementarnego'));
  });

  await scenario('nieznany/pusty odbiorca traktowany jak NIE-zawodnik (bezpieczna strona)', () => {
    const sel = selectHintsForPrompt({ hints: [h({ odbiorca: null }), h({ odbiorca: 'cos' })] });
    assert.strictEqual(sel.hints.length, 0);
    assert.strictEqual(sel.odrzuconePrzezOdbiorce, 2);
  });

  await scenario('active=false odpada i jest liczone osobno (wyłączona podpowiedź != brak danych)', () => {
    const sel = selectHintsForPrompt({ hints: [h({ active: false }), HINT_SEGMENT] });
    assert.strictEqual(sel.hints.length, 1);
    assert.strictEqual(sel.nieaktywne, 1);
  });

  // ==========================================================
  console.log('\n6. Limit 12 — Regeneracja ma 24 podpowiedzi, wszystkie by nie weszły');

  await scenario('domyślny limit to 12', () => {
    assert.strictEqual(HINT_LIMIT, 12);
  });

  await scenario('24 podpowiedzi na wejściu -> 12 na wyjściu, reszta policzona jako przycięta', () => {
    const dwadziesciaCztery = Array.from({ length: 24 }, (_, i) => h({ klucz: `k${String(i).padStart(2, '0')}`, pozycja: i + 1 }));
    const sel = selectHintsForPrompt({ hints: dwadziesciaCztery });
    assert.strictEqual(sel.hints.length, 12);
    assert.strictEqual(sel.przycieteLimitem, 12);
  });

  await scenario('limit tnie DOPIERO po sortowaniu — najlepiej wycelowana zawsze zostaje', () => {
    const balast = Array.from({ length: 20 }, (_, i) => h({ klucz: `balast${i}`, pozycja: i + 1 }));
    const sel = selectHintsForPrompt({
      hints: [...balast, HINT_ELEMENT], goalComponentId: 'K-ELEMENT',
    });
    assert.strictEqual(sel.hints[0].klucz, HINT_ELEMENT.klucz);
    assert.strictEqual(sel.hints.length, 12);
  });

  await scenario('limit 0 / ujemny / niepoprawny -> spada na domyślne 12, nie na pustkę', () => {
    const dwadziescia = Array.from({ length: 20 }, (_, i) => h({ klucz: `k${i}`, pozycja: i }));
    assert.strictEqual(selectHintsForPrompt({ hints: dwadziescia, limit: 0 }).hints.length, 12);
    assert.strictEqual(selectHintsForPrompt({ hints: dwadziescia, limit: -5 }).hints.length, 12);
  });

  // ==========================================================
  console.log('\n7. Blok promptu — nazwana sekcja, numer strony przy KAŻDEJ podpowiedzi');

  await scenario('brak podpowiedzi -> PUSTY string, prompt zostaje dokładnie taki jak dziś', () => {
    assert.strictEqual(buildHintPromptBlock(null), '');
    assert.strictEqual(buildHintPromptBlock({ hints: [] }), '');
    assert.strictEqual(buildHintPromptBlock(selectHintsForPrompt({ hints: [] })), '');
  });

  await scenario('blok jest NAZWANY i nie udaje bazy wiedzy', () => {
    const blok = buildHintPromptBlock(selectHintsForPrompt({ hints: [HINT_SEGMENT] }));
    assert.match(blok, /PODPOWIEDZI Z MATERIAŁÓW GAMECHANGE/);
    assert.ok(!blok.includes('BAZA WIEDZY GAMECHANGE'));
  });

  await scenario('każda linia niesie materiał i numer strony — to odróżnia je od wiedzy modelu', () => {
    const linia = formatHintLine(HINT_SEGMENT);
    assert.match(linia, /Moc — System Gamechange \(pełny\), s\. 4/);
  });

  await scenario('linia niesie klucz — bez niego model nie mógłby wskazać, której użył', () => {
    assert.match(formatHintLine(HINT_SEGMENT), /\(moc-segment-01\)/);
  });

  await scenario('rodzaj tłumaczony na ludzki polski: zrobic -> "zrobić", zrozumiec -> "zrozumieć"', () => {
    assert.match(formatHintLine(h({ rodzaj: 'zrobic' })), /\[zrobić\]/);
    assert.match(formatHintLine(h({ rodzaj: 'zrozumiec' })), /\[zrozumieć\]/);
  });

  await scenario('strony = "—" (podpowiedź systemowa A9, nie z materiału) -> bez fałszywego numeru strony', () => {
    const linia = formatHintLine(h({ strony: '—', zrodlo: 'decyzja A9 (tekst systemowy — nie z materiału)' }));
    assert.ok(!linia.includes('s. —'));
  });

  await scenario('pole `dowody` wchodzi tylko wtedy, gdy materiał SAM deklaruje siłę twierdzenia', () => {
    assert.ok(!formatHintLine(h({ dowody: null })).includes('materiał deklaruje'));
    assert.match(formatHintLine(h({ dowody: 'materiał podaje jako regułę bezwzględną' })), /materiał deklaruje/);
  });

  await scenario('blok zawiera instrukcję zakazu wymyślania stron i tytułów', () => {
    const blok = buildHintPromptBlock(selectHintsForPrompt({ hints: [HINT_SEGMENT] }));
    assert.match(blok, /Nie wymyślaj numerów stron/);
  });

  // ==========================================================
  console.log('\n8. REGUŁA R1 — kontrakt podpowiedzi jadącej na ekran (dla pasa B)');

  await scenario('brak podpowiedzi -> null, nie pusty obiekt udający treść', () => {
    assert.strictEqual(pickShowcaseHint(null), null);
    assert.strictEqual(pickShowcaseHint(selectHintsForPrompt({ hints: [] })), null);
  });

  await scenario('kontrakt niesie treść, materiał i stronę — dokładnie to, co wymaga R1', () => {
    const sel = selectHintsForPrompt({ hints: [HINT_SEGMENT] });
    const s = pickShowcaseHint(sel);
    assert.strictEqual(s.tresc, HINT_SEGMENT.hint);
    assert.strictEqual(s.material, 'Moc — System Gamechange (pełny)');
    assert.strictEqual(s.strona, '4');
  });

  await scenario('kontrakt ma numer wersji — pas B może na nim polegać przy przyszłych zmianach', () => {
    assert.strictEqual(pickShowcaseHint(selectHintsForPrompt({ hints: [HINT_SEGMENT] })).wersja, 1);
  });

  await scenario('gdy AI wskazało klucz z listy -> bierzemy TĘ podpowiedź, nie pierwszą', () => {
    const sel = selectHintsForPrompt({
      hints: [HINT_ELEMENT, HINT_OBSZAR, HINT_SEGMENT], goalComponentId: 'K-ELEMENT',
    });
    const s = pickShowcaseHint(sel, HINT_SEGMENT.klucz);
    assert.strictEqual(s.klucz, HINT_SEGMENT.klucz);
    assert.strictEqual(s.wybor, 'wskazana_przez_ai');
  });

  await scenario('gdy AI podało klucz spoza listy (halucynacja) -> spadamy na najlepiej wycelowaną', () => {
    const sel = selectHintsForPrompt({ hints: [HINT_ELEMENT, HINT_SEGMENT], goalComponentId: 'K-ELEMENT' });
    const s = pickShowcaseHint(sel, 'klucz-ktorego-nie-ma');
    assert.strictEqual(s.klucz, HINT_ELEMENT.klucz);
    assert.strictEqual(s.wybor, 'najlepiej_wycelowana');
  });

  await scenario('gdy AI milczy -> też najlepiej wycelowana; zawodnik ZAWSZE ma co zobaczyć', () => {
    const sel = selectHintsForPrompt({ hints: [HINT_ELEMENT, HINT_SEGMENT], goalComponentId: 'K-ELEMENT' });
    assert.strictEqual(pickShowcaseHint(sel, null).klucz, HINT_ELEMENT.klucz);
    assert.strictEqual(pickShowcaseHint(sel, '').klucz, HINT_ELEMENT.klucz);
  });

  await scenario('strona "—" -> null w kontrakcie, żeby pas B nie wyrenderował "s. —"', () => {
    const sel = selectHintsForPrompt({ hints: [h({ strony: '—' })] });
    assert.strictEqual(pickShowcaseHint(sel).strona, null);
  });

  await scenario('kontrakt jest czystym JSON-em (przechodzi round-trip bez straty)', () => {
    const s = pickShowcaseHint(selectHintsForPrompt({ hints: [HINT_ELEMENT], goalComponentId: 'K-ELEMENT' }));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), s);
  });

  await scenario('kontrakt NIE zawiera treści dla rodzica, bo ta nigdy nie dociera do selekcji', () => {
    const sel = selectHintsForPrompt({ hints: [HINT_RODZIC], ageLowerBound: 20 });
    assert.strictEqual(pickShowcaseHint(sel), null);
  });

  // ==========================================================
  console.log('\n9. R5 — jawne stany w logu (bez tego "cichy brak" wraca tylnymi drzwiami)');

  await scenario('log zawsze mówi, w jakim stanie była tabela', () => {
    assert.match(describeHintState(selectHintsForPrompt({ hints: [] }), 'brak_tabeli'), /tabela=brak_tabeli/);
  });

  await scenario('log rozróżnia "0 podpowiedzi bo brak tabeli" od "0 podpowiedzi bo nic nie pasowało"', () => {
    const pusty = selectHintsForPrompt({ hints: [] });
    assert.notStrictEqual(describeHintState(pusty, 'brak_tabeli'), describeHintState(pusty, 'ok'));
  });

  await scenario('log krzyczy WIEK_NIEZNANY, gdy rocznika nie ma', () => {
    const sel = selectHintsForPrompt({ hints: [HINT_OBA_Z_WIEKIEM], ageLowerBound: null });
    assert.match(describeHintState(sel, 'ok'), /WIEK_NIEZNANY=tak/);
  });

  await scenario('log podaje liczbę NIEDOPASOWANYCH — oczekiwana 0 po poprawnej migracji', () => {
    const sel = selectHintsForPrompt({ hints: [HINT_NIEDOPASOWANY, HINT_SEGMENT] });
    assert.match(describeHintState(sel, 'ok'), /NIEDOPASOWANE=1/);
    assert.match(describeHintState(selectHintsForPrompt({ hints: [HINT_SEGMENT] }), 'ok'), /NIEDOPASOWANE=0/);
  });

  await scenario('isMissingTableError rozpoznaje brak tabeli po kodzie i po treści', () => {
    assert.strictEqual(isMissingTableError({ code: '42P01' }), true);
    assert.strictEqual(isMissingTableError({ code: 'PGRST205' }), true);
    assert.strictEqual(isMissingTableError({ message: 'relation "component_hints" does not exist' }), true);
    assert.strictEqual(isMissingTableError({ code: '23505', message: 'duplicate key' }), false);
    assert.strictEqual(isMissingTableError(null), false);
  });

  await scenario('isMissingColumnError rozpoznaje brak kolumny source_hint', () => {
    assert.strictEqual(isMissingColumnError({ code: 'PGRST204' }), true);
    assert.strictEqual(isMissingColumnError({ code: '42703' }), true);
    assert.strictEqual(isMissingColumnError({ message: "Could not find the 'source_hint' column of 'decision_recommendations'" }), true);
    assert.strictEqual(isMissingColumnError({ code: '23505', message: 'duplicate key' }), false);
  });

  // ==========================================================
  console.log('\n10. Warstwa I/O — brak tabeli/rocznika/Elementu nie wywraca silnika');

  await scenario('fetchComponentHints: tabela nie istnieje -> stanTabeli="brak_tabeli", zero wyjątku', async () => {
    const sb = makeFakeSupabase({}, { component_hints: { code: '42P01', message: 'relation "component_hints" does not exist' } });
    const r = await fetchComponentHints(sb, { segmentId: 'moc' });
    assert.strictEqual(r.stanTabeli, 'brak_tabeli');
    assert.deepStrictEqual(r.rows, []);
  });

  await scenario('fetchComponentHints: inny błąd bazy -> stanTabeli="blad" + treść, nie cicha pustka', async () => {
    const sb = makeFakeSupabase({}, { component_hints: { code: '08006', message: 'connection failure' } });
    const r = await fetchComponentHints(sb, { segmentId: 'moc' });
    assert.strictEqual(r.stanTabeli, 'blad');
    assert.match(r.blad, /connection failure/);
  });

  await scenario('fetchComponentHints: brak segmentu -> jawny stan, nie puste zapytanie do bazy', async () => {
    const r = await fetchComponentHints(makeFakeSupabase({}), { segmentId: null });
    assert.strictEqual(r.stanTabeli, 'brak_segmentu');
  });

  await scenario('fetchComponentHints: filtruje po segmencie i pobiera tylko aktywne', async () => {
    const sb = makeFakeSupabase({ component_hints: [
      h({ klucz: 'a', segment_id: 'moc', active: true }),
      h({ klucz: 'b', segment_id: 'regeneracja', active: true }),
      h({ klucz: 'c', segment_id: 'moc', active: false }),
    ] });
    const r = await fetchComponentHints(sb, { segmentId: 'moc' });
    assert.deepStrictEqual(r.rows.map((x) => x.klucz), ['a']);
  });

  await scenario('fetchComponentHints z Elementem celu: bierze Element celu I segmentowe, pomija obcy Element', async () => {
    const sb = makeFakeSupabase({ component_hints: [HINT_ELEMENT, HINT_INNY_ELEMENT, HINT_SEGMENT] });
    const r = await fetchComponentHints(sb, { segmentId: 'moc', componentId: 'K-ELEMENT' });
    const klucze = r.rows.map((x) => x.klucz).sort();
    assert.deepStrictEqual(klucze, [HINT_ELEMENT.klucz, HINT_SEGMENT.klucz].sort());
  });

  await scenario('fetchPlayerBirthYear: brak wiersza usera -> stan "brak_wiersza", birthYear null', async () => {
    const r = await fetchPlayerBirthYear(makeFakeSupabase({ users: [] }), 'u1');
    assert.strictEqual(r.stan, 'brak_wiersza');
    assert.strictEqual(r.birthYear, null);
  });

  await scenario('fetchPlayerBirthYear: wiersz jest, ale rocznik pusty -> stan "brak_rocznika" (nie "ok")', async () => {
    const r = await fetchPlayerBirthYear(makeFakeSupabase({ users: [{ id: 'u1', birth_year: null }] }), 'u1');
    assert.strictEqual(r.stan, 'brak_rocznika');
  });

  await scenario('fetchGoalComponentId: brak goalId -> "brak_celu"', async () => {
    const r = await fetchGoalComponentId(makeFakeSupabase({}), null);
    assert.strictEqual(r.stanCelowania, 'brak_celu');
  });

  await scenario('fetchGoalComponentId: cel bez ŻADNEJ znanej kolumny Elementu -> "brak_kolumny_elementu"', async () => {
    const sb = makeFakeSupabase({ goals: [{ id: 'g1', segment_id: 'moc', status: 'active' }] });
    const r = await fetchGoalComponentId(sb, 'g1');
    assert.strictEqual(r.stanCelowania, 'brak_kolumny_elementu');
    assert.strictEqual(r.componentId, null);
  });

  await scenario('to NIE to samo co "cel bez Elementu" — dwa różne stany, choć oba dają componentId null', async () => {
    const sbBezKolumny = makeFakeSupabase({ goals: [{ id: 'g1', segment_id: 'moc' }] });
    const sbZKolumnaPusta = makeFakeSupabase({ goals: [{ id: 'g1', segment_id: 'moc', component_id: null }] });
    const a = await fetchGoalComponentId(sbBezKolumny, 'g1');
    const b = await fetchGoalComponentId(sbZKolumnaPusta, 'g1');
    assert.strictEqual(a.componentId, b.componentId);
    assert.notStrictEqual(a.stanCelowania, b.stanCelowania);
    assert.strictEqual(b.stanCelowania, 'cel_bez_elementu');
  });

  await scenario('fetchGoalComponentId: kolumna Elementu wypełniona -> "ok" + nazwa użytej kolumny', async () => {
    const sb = makeFakeSupabase({ goals: [{ id: 'g1', segment_id: 'moc', component_id: 'K-ELEMENT' }] });
    const r = await fetchGoalComponentId(sb, 'g1');
    assert.strictEqual(r.stanCelowania, 'ok');
    assert.strictEqual(r.componentId, 'K-ELEMENT');
    assert.strictEqual(r.kolumna, 'component_id');
  });

  await scenario('fetchGoalComponentId: rozpoznaje też alternatywną nazwę kolumny (segment_component_id)', async () => {
    const sb = makeFakeSupabase({ goals: [{ id: 'g1', segment_component_id: 'K-X' }] });
    const r = await fetchGoalComponentId(sb, 'g1');
    assert.strictEqual(r.componentId, 'K-X');
    assert.strictEqual(r.kolumna, 'segment_component_id');
  });

  // ==========================================================
  console.log('\n11. loadHintsForRecommendation — złożenie wszystkiego, ścieżka końcowa silnika');

  await scenario('pełna ścieżka: 16-latek, cel z Elementem -> Element celu pierwszy, dawki przechodzą', async () => {
    const sb = makeFakeSupabase({
      component_hints: [HINT_SEGMENT, HINT_ELEMENT, HINT_OBA_Z_WIEKIEM],
      users: [{ id: 'u1', birth_year: 2009 }],
      goals: [{ id: 'g1', component_id: 'K-ELEMENT' }],
    });
    const r = await loadHintsForRecommendation(sb, { segmentId: 'moc', userId: 'u1', goalId: 'g1', now: NOW_2026 });
    assert.strictEqual(r.stanTabeli, 'ok');
    assert.strictEqual(r.ageLowerBound, 16);
    assert.strictEqual(r.selection.hints[0].klucz, HINT_ELEMENT.klucz);
    assert.strictEqual(r.selection.ukryteZPowoduWieku, 0);
  });

  await scenario('ten sam zestaw dla 14-latka -> podpowiedź z dawką ukryta i policzona', async () => {
    const sb = makeFakeSupabase({
      component_hints: [HINT_SEGMENT, HINT_OBA_Z_WIEKIEM],
      users: [{ id: 'u1', birth_year: 2012 }],
    });
    const r = await loadHintsForRecommendation(sb, { segmentId: 'moc', userId: 'u1', now: NOW_2026 });
    assert.strictEqual(r.selection.ukryteZPowoduWieku, 1);
    assert.strictEqual(r.selection.wiekNieznany, false);
    assert.strictEqual(r.selection.hints.length, 1);
  });

  await scenario('brak tabeli -> zero podpowiedzi, stan jawny, ZERO wyjątku (silnik jak dziś)', async () => {
    const sb = makeFakeSupabase({ users: [{ id: 'u1', birth_year: 2009 }] },
      { component_hints: { code: '42P01', message: 'does not exist' } });
    const r = await loadHintsForRecommendation(sb, { segmentId: 'moc', userId: 'u1', now: NOW_2026 });
    assert.strictEqual(r.stanTabeli, 'brak_tabeli');
    assert.strictEqual(r.selection.stan, 'brak_podpowiedzi');
    assert.strictEqual(buildHintPromptBlock(r.selection), '');
    assert.strictEqual(pickShowcaseHint(r.selection), null);
  });

  await scenario('brak rocznika -> podpowiedzi bez dawek nadal działają, wiek jawnie nieznany', async () => {
    const sb = makeFakeSupabase({
      component_hints: [HINT_SEGMENT, HINT_OBA_Z_WIEKIEM],
      users: [{ id: 'u1', birth_year: null }],
    });
    const r = await loadHintsForRecommendation(sb, { segmentId: 'moc', userId: 'u1', now: NOW_2026 });
    assert.strictEqual(r.stanWieku, 'brak_rocznika');
    assert.strictEqual(r.selection.wiekNieznany, true);
    assert.strictEqual(r.selection.hints.length, 1);
    assert.match(r.log, /WIEK_NIEZNANY=tak/);
  });

  // ==========================================================
  console.log('\n12. Koszt promptu — mierzony, nie szacowany');

  await scenario('blok dla 12 podpowiedzi mieści się poniżej 4000 znaków', () => {
    const dwanascie = Array.from({ length: 12 }, (_, i) => h({ klucz: `moc-segment-${i}`, pozycja: i + 1 }));
    const blok = buildHintPromptBlock(selectHintsForPrompt({ hints: dwanascie }));
    assert.ok(blok.length < 4000, `blok ma ${blok.length} znaków`);
  });

  await scenario('brak podpowiedzi = DOKŁADNIE zero znaków dopisanych do promptu', () => {
    assert.strictEqual(buildHintPromptBlock(selectHintsForPrompt({ hints: [] })).length, 0);
  });

  await scenario('limit 12 realnie ogranicza koszt: 24 podpowiedzi nie kosztują więcej niż 12', () => {
    const dwadziesciaCztery = Array.from({ length: 24 }, (_, i) => h({ klucz: `k${i}`, pozycja: i + 1 }));
    const dwanascie = dwadziesciaCztery.slice(0, 12);
    assert.strictEqual(
      buildHintPromptBlock(selectHintsForPrompt({ hints: dwadziesciaCztery })).length,
      buildHintPromptBlock(selectHintsForPrompt({ hints: dwanascie })).length
    );
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
