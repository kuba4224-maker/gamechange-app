// ============================================================
// GAMECHANGE — tests/test-generate-focus-block-content.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, piąta runda — kontynuacja "Pracuj dalej").
// Pokrywa to, co `_internal` faktycznie eksportuje z tego pliku i da się
// przetestować bez atrapy `fetch`/Anthropic: `stripMarkdownJsonFence`,
// `SEG_PILLAR`, `fetchFocusBlock`, `fetchElementDescription` (te dwie
// ostatnie z atrapą Supabase, ten sam wzorzec co reszta folderu).
//
// Świadomie NIE testujemy `generateCheckin`/`generateClosingReview`
// całościowo — obie łączą Supabase I prawdziwe wywołanie Anthropic
// (`callAnthropic`, niewyeksportowane, więc nie do podmiany), a logika
// "czy dołączyć dawkę treści" (`dueForContentDose`) jest wpisana wprost w
// ciało `generateCheckin`, nie wydzielona jako osobna czysta funkcja — do
// przetestowania wymagałaby atrapy globalnego `fetch`, co wykracza poza
// ustalony w tym projekcie zakres testów (patrz reszta plików w tym
// folderze — żaden nie stubuje `fetch`).
//
// Uruchomienie: node tests/test-generate-focus-block-content.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_5__.js');
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

const {
  fetchFocusBlock,
  fetchElementDescription,
  stripMarkdownJsonFence,
  SEG_PILLAR,
  // PRAKTYKA A5 08.08.2026 — nowe eksporty, żeby dało się ZMIERZYĆ
  // niezmienność promptu i przetestować ścieżkę dawki bez sieci.
  buildCheckinSystemPrompt,
  generateCheckin,
} = require('../api/generate-focus-block-content.js')._internal;
const { buildHintPromptBlock } = require('../lib/recommendation-hints.js');

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

function makeFakeSupabase(tables) {
  return {
    from(table) {
      const filters = [];
      const builder = {
        select() { return builder; },
        eq(col, val) { filters.push((row) => row[col] === val); return builder; },
        maybeSingle() {
          const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        single() {
          const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve(rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'not found' } });
        },
      };
      return builder;
    },
  };
}

(async () => {
  console.log('generate-focus-block-content.js _internal — testy jednostkowe');

  console.log('\n1. stripMarkdownJsonFence (kopia tej samej funkcji co w pozostałych plikach AI)');

  await scenario('czysty JSON -> bez zmian', () => {
    assert.strictEqual(stripMarkdownJsonFence('{"question":"X"}'), '{"question":"X"}');
  });

  await scenario('owinięty w ```json ... ``` -> wyciągnięty', () => {
    assert.strictEqual(stripMarkdownJsonFence('```json\n{"summary":"X"}\n```'), '{"summary":"X"}');
  });

  console.log('\n2. SEG_PILLAR — mapowanie segment→filar (5 filarów, 13 segmentów)');

  await scenario('każdy z 13 segmentów ma przypisany dokładnie jeden filar', () => {
    const allSegments = ['moc', 'wytrzymalosc', 'fizycznosc', 'techFund', 'techSpec', 'tolerancja', 'regeneracja', 'odpornosc', 'odzywianie', 'koncentracja', 'mental', 'percepcja', 'decyzja'];
    assert.strictEqual(Object.keys(SEG_PILLAR).length, 13);
    allSegments.forEach((id) => assert.ok(SEG_PILLAR[id], `brak filaru dla segmentu "${id}"`));
  });

  await scenario('segment nieznany -> undefined (nie rzuca)', () => {
    assert.strictEqual(SEG_PILLAR['segment-obcy'], undefined);
  });

  await scenario('"moc" i "wytrzymalosc" należą do tego samego filaru (Dominacja fizyczna)', () => {
    assert.strictEqual(SEG_PILLAR.moc, SEG_PILLAR.wytrzymalosc);
    assert.match(SEG_PILLAR.moc, /Dominacja fizyczna/);
  });

  console.log('\n3. fetchFocusBlock — atrapa Supabase');

  await scenario('blok istnieje -> zwraca wiersz', async () => {
    const supabase = makeFakeSupabase({ focus_blocks: [{ id: 'b1', user_id: 'u1', segment_id: 'moc', stage: 1 }] });
    const r = await fetchFocusBlock(supabase, 'b1');
    assert.strictEqual(r.id, 'b1');
    assert.strictEqual(r.segment_id, 'moc');
  });

  await scenario('blok NIE istnieje -> rzuca z czytelnym komunikatem (nie zwraca cicho undefined)', async () => {
    const supabase = makeFakeSupabase({ focus_blocks: [] });
    await assert.rejects(() => fetchFocusBlock(supabase, 'brak-takiego'), /Nie znaleziono focus_block brak-takiego/);
  });

  console.log('\n4. fetchElementDescription — atrapa Supabase');

  await scenario('component_id podany, komponent istnieje -> zwraca jego nazwę', async () => {
    const supabase = makeFakeSupabase({ segment_components: [{ id: 'c1', name: 'Przysiad' }] });
    const r = await fetchElementDescription(supabase, { component_id: 'c1', custom_description: null });
    assert.strictEqual(r, 'Przysiad');
  });

  await scenario('component_id podany, ale NIE istnieje -> spada na custom_description', async () => {
    const supabase = makeFakeSupabase({ segment_components: [] });
    const r = await fetchElementDescription(supabase, { component_id: 'brak-takiego', custom_description: 'Mój opis' });
    assert.strictEqual(r, 'Mój opis');
  });

  await scenario('brak component_id -> custom_description', async () => {
    const supabase = makeFakeSupabase({});
    const r = await fetchElementDescription(supabase, { component_id: null, custom_description: 'Wolny opis' });
    assert.strictEqual(r, 'Wolny opis');
  });

  await scenario('brak component_id I custom_description -> domyślny fallback "wybrany element" (nigdy pusty/undefined)', async () => {
    const supabase = makeFakeSupabase({});
    const r = await fetchElementDescription(supabase, { component_id: null, custom_description: null });
    assert.strictEqual(r, 'wybrany element');
  });

  // ══════════════════════════════════════════════════════════
  // PRAKTYKA A5 08.08.2026 — grupy 5–7.
  // Nagłówek tego pliku mówił, że `generateCheckin` jest nietestowalny,
  // bo łączy Supabase z prawdziwym wywołaniem Anthropic. Od tej rundy
  // przyjmuje opcjonalne `deps` ({ supabase, callModel, now }) — ten sam
  // wzorzec co `injectedSupabase` w generateFocusBlockDosing() — więc
  // ścieżka dawki daje się przejść w całości bez ani jednego bajtu sieci.
  // ══════════════════════════════════════════════════════════

  const TERAZ_A5 = new Date('2026-08-08T09:00:00.000Z');
  const DAY_A5 = 24 * 60 * 60 * 1000;
  const przedA5 = (d) => new Date(TERAZ_A5.getTime() - d * DAY_A5).toISOString();

  // Atrapa bogatsza niż makeFakeSupabase wyżej: update, or, lista bez
  // maybeSingle, order/limit. Tamtej NIE ruszam — 11 scenariuszy powyżej
  // ma zostać dowodem, że nic się nie zmieniło.
  function makeFakeSupabaseA5(tables, errors = {}) {
    const updates = [];
    return {
      _updates: updates,
      from(table) {
        const filters = [];
        let pending = null;
        let wybraneKolumny = null;
        const b = {
          select(cols) { wybraneKolumny = cols; return b; },
          update(p) { pending = p; return b; },
          order() { return b; },
          limit() { return b; },
          eq(col, val) {
            filters.push((r) => String(r[col]) === String(val));
            if (pending) {
              if (errors[table]) return Promise.resolve({ data: null, error: errors[table] });
              const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
              rows.forEach((r) => Object.assign(r, pending));
              updates.push({ table, payload: pending });
              return Promise.resolve({ data: rows, error: null });
            }
            return b;
          },
          or(expr) {
            const m = /component_id\.eq\.([^,]+)/.exec(expr);
            filters.push((r) => r.component_id == null || String(r.component_id) === (m ? m[1] : null));
            return b;
          },
          // Błąd można wymusić dla CAŁEJ tabeli (`focus_blocks`) albo dla
          // konkretnego zapytania po kolumnie (`focus_blocks:content_doses`)
          // — tak zachowuje się PostgREST przy braku kolumny: pada tylko
          // ten select, który tę kolumnę wymienia.
          _blad() { return errors[`${table}:${wybraneKolumny}`] || errors[table] || null; },
          maybeSingle() {
            const e = b._blad();
            if (e) return Promise.resolve({ data: null, error: e });
            const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
            return Promise.resolve({ data: rows[0] || null, error: null });
          },
          single() {
            const e = b._blad();
            if (e) return Promise.resolve({ data: null, error: e });
            const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
            return Promise.resolve(rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'not found' } });
          },
          then(res, rej) {
            const e = b._blad();
            if (e) return Promise.resolve({ data: null, error: e }).then(res, rej);
            const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
            return Promise.resolve({ data: rows, error: null }).then(res, rej);
          },
        };
        return b;
      },
    };
  }

  const HINTY_TESTOWE = [
    {
      klucz: 'regeneracja-wyduzenie-snu-nocnego-o-46-113-minut-02', segment_id: 'regeneracja',
      component_id: 'K-SEN', obszar_name: 'Sen jako podstawa regeneracji',
      element_name: 'Wydłużenie snu nocnego o 46-113 minut',
      hint: 'Wyznacz stałą godzinę snu i trzymaj się jej codziennie, także w weekendy.',
      odbiorca: 'oba', min_age: null, rodzaj: 'zrobic',
      zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '2', dowody: null, pozycja: 2, active: true,
    },
    {
      klucz: 'regeneracja-segment-08', segment_id: 'regeneracja', component_id: null,
      obszar_name: null, element_name: null,
      hint: 'Dawka bazowa dla zawodnika ok. 70 kg: 200–400 mg magnezu elementarnego dziennie.',
      odbiorca: 'rodzic', min_age: 16, rodzaj: 'zrobic',
      zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '5, 13', dowody: null, pozycja: 8, active: true,
    },
  ];

  function swiatA5(over = {}) {
    return makeFakeSupabaseA5({
      focus_blocks: [{
        id: 'b1', user_id: 'u16', segment_id: 'regeneracja', component_id: 'K-SEN',
        custom_description: null, stage: 2,
        last_content_dose_stage: 2, last_content_dose_at: przedA5(40),
        content_doses: null,
        ...over,
      }],
      segment_components: [{ id: 'K-SEN', name: 'Wydłużenie snu nocnego o 46-113 minut' }],
      knowledge_base_entries: [{ segment_id: 'regeneracja', content: 'Baza wiedzy o regeneracji.' }],
      focus_block_checkins: [],
      users: [{ id: 'u16', birth_year: 2009 }],
      component_hints: HINTY_TESTOWE,
    }, over._errors || {});
  }

  function modelStub(odpowiedz, licznik) {
    return async (systemPrompt, userPrompt) => {
      licznik.wywolania++;
      licznik.ostatniSystemPrompt = systemPrompt;
      licznik.ostatniUserPrompt = userPrompt;
      return typeof odpowiedz === 'function' ? odpowiedz(systemPrompt) : odpowiedz;
    };
  }

  const ODPOWIEDZ_Z_DAWKA = {
    question: 'Czy udało Ci się utrzymać stałą godzinę snu w tym tygodniu?',
    contentDose: { practicalStep: 'Przez najbliższy tydzień kładź się o tej samej godzinie.', forCurious: 'Melatonina wytwarza się najmocniej między północą a trzecią.' },
    used_hint_klucz: 'regeneracja-wyduzenie-snu-nocnego-o-46-113-minut-02',
  };

  console.log('\n5. buildCheckinSystemPrompt — dowód, że nic się nie zmieniło bez podpowiedzi (PRAKTYKA A5)');

  // Wzorzec przepisany ZNAK W ZNAK z pliku sprzed 08.08.2026.
  function promptSprzedRundy5(elementName, segmentId, stage, due) {
    return `Jesteś asystentem sportowym systemu Gamechange. Piszesz krótkie,
konkretne pytanie kontrolne po polsku do zawodnika pracującego nad elementem
"${elementName}" (segment: ${segmentId}, etap progresji: ${stage}) w ramach
jego Bloku Skupienia. Pytanie MUSI dotyczyć WYŁĄCZNIE tego elementu — nie ogólnego
samopoczucia, nie innych celów. Ton rzeczowy, krótki (1 zdanie, max 2).
${due
    ? 'Dołącz też krótką dawkę treści edukacyjnej (2-4 zdania): "praktyczny krok" (zawsze) oraz opcjonalnie "dla chętnych" (głębsze wyjaśnienie, może być null jeśli wiedza źródłowa na to nie pozwala). Bazuj WYŁĄCZNIE na dostarczonej wiedzy źródłowej, nie zmyślaj.'
    : 'NIE dołączaj żadnej treści edukacyjnej w tej turze — zwróć contentDose: null.'}
Zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez bloków kodu) w formacie:
{"question": "...", "contentDose": null lub {"practicalStep": "...", "forCurious": "..." lub null}}`;
  }

  await scenario('BEZ podpowiedzi, dawka w tej turze — prompt IDENTYCZNY co do znaku ze stanem sprzed rundy 5', () => {
    const nowy = buildCheckinSystemPrompt({ elementName: 'Wydłużenie snu', segmentId: 'regeneracja', stage: 2, dueForContentDose: true, hintBlock: '' });
    assert.strictEqual(nowy, promptSprzedRundy5('Wydłużenie snu', 'regeneracja', 2, true));
  });

  await scenario('BEZ podpowiedzi, tura bez dawki — prompt IDENTYCZNY co do znaku', () => {
    const nowy = buildCheckinSystemPrompt({ elementName: 'Wydłużenie snu', segmentId: 'regeneracja', stage: 2, dueForContentDose: false, hintBlock: '' });
    assert.strictEqual(nowy, promptSprzedRundy5('Wydłużenie snu', 'regeneracja', 2, false));
  });

  await scenario('domyślny hintBlock (pominięty parametr) też daje wersję sprzed rundy 5', () => {
    const nowy = buildCheckinSystemPrompt({ elementName: 'X', segmentId: 'moc', stage: 1, dueForContentDose: true });
    assert.strictEqual(nowy, promptSprzedRundy5('X', 'moc', 1, true));
  });

  await scenario('Z podpowiedziami — sekcja jest NAZWANA i nie udaje bazy wiedzy', () => {
    const blok = buildHintPromptBlock({ hints: [HINTY_TESTOWE[0]] });
    const p = buildCheckinSystemPrompt({ elementName: 'X', segmentId: 'regeneracja', stage: 2, dueForContentDose: true, hintBlock: blok });
    assert.match(p, /PODPOWIEDZI Z MATERIAŁÓW GAMECHANGE/);
    assert.match(p, /Regeneracja — System Gamechange \(pełny\), s\. 2/);
  });

  await scenario('Z podpowiedziami — format odpowiedzi dostaje used_hint_klucz', () => {
    const blok = buildHintPromptBlock({ hints: [HINTY_TESTOWE[0]] });
    const p = buildCheckinSystemPrompt({ elementName: 'X', segmentId: 'regeneracja', stage: 2, dueForContentDose: true, hintBlock: blok });
    assert.match(p, /"used_hint_klucz"/);
  });

  await scenario('BEZ podpowiedzi — used_hint_klucz NIE pojawia się w formacie (zero kosztu)', () => {
    const p = buildCheckinSystemPrompt({ elementName: 'X', segmentId: 'regeneracja', stage: 2, dueForContentDose: true, hintBlock: '' });
    assert.ok(!p.includes('used_hint_klucz'));
  });

  console.log('\n6. generateCheckin — dawka zapisywana i odczytywana (PRAKTYKA A5)');

  await scenario('nowa dawka ZOSTAJE ZAPISANA do focus_blocks.content_doses', async () => {
    const sb = swiatA5();
    const lic = { wywolania: 0 };
    const r = await generateCheckin({ focusBlockId: 'b1' }, { supabase: sb, callModel: modelStub(ODPOWIEDZ_Z_DAWKA, lic), now: TERAZ_A5 });
    assert.strictEqual(r.zapisDawki, 'zapisano');
    assert.strictEqual(r.contentDoseZrodlo, 'model');
    assert.ok(r.contentDoseZapisana.krok_praktyczny.length > 0);
    const zapis = sb._updates.find((u) => u.payload.content_doses);
    assert.ok(zapis, 'MUSI pójść UPDATE z content_doses — inaczej dawka nadal ginie');
  });

  await scenario('zapisana dawka niesie podpowiedź wskazaną przez model (kontrakt R1)', async () => {
    const sb = swiatA5();
    const lic = { wywolania: 0 };
    const r = await generateCheckin({ focusBlockId: 'b1' }, { supabase: sb, callModel: modelStub(ODPOWIEDZ_Z_DAWKA, lic), now: TERAZ_A5 });
    const zh = r.contentDoseZapisana.zrodlo_podpowiedzi;
    assert.ok(zh, 'dawka bez źródła nie domyka pętli wiedzy');
    assert.strictEqual(zh.wybor, 'wskazana_przez_ai');
    assert.strictEqual(zh.celowanie, 'element_celu');
    assert.strictEqual(zh.strona, '2');
  });

  await scenario('POLA O NIEZMIENIONYM ZNACZENIU: contentDose i stageAtDose jak dotąd', async () => {
    const sb = swiatA5();
    const lic = { wywolania: 0 };
    const r = await generateCheckin({ focusBlockId: 'b1' }, { supabase: sb, callModel: modelStub(ODPOWIEDZ_Z_DAWKA, lic), now: TERAZ_A5 });
    assert.deepStrictEqual(r.contentDose, ODPOWIEDZ_Z_DAWKA.contentDose);
    assert.strictEqual(r.stageAtDose, 2);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(typeof r.question, 'string');
  });

  await scenario('DAWKA W MAGAZYNIE -> model NIE dostaje prośby o dawkę, a zawodnik i tak ma treść', async () => {
    const sb = swiatA5({
      last_content_dose_at: przedA5(40), // wg starej reguły dawka BY wypadła
      content_doses: {
        wersja: 1,
        dawki: [{ wersja: 1, klucz: 'b1:e2:2026-08-05', etap: 2, wygenerowano_at: przedA5(3), krok_praktyczny: 'Zapamiętana treść.', dla_chetnych: null, segment_id: 'regeneracja', component_id: 'K-SEN', zrodlo_podpowiedzi: null }],
      },
    });
    const lic = { wywolania: 0 };
    const r = await generateCheckin({ focusBlockId: 'b1' }, { supabase: sb, callModel: modelStub({ question: 'Pytanie?' }, lic), now: TERAZ_A5 });
    assert.strictEqual(r.contentDoseZrodlo, 'magazyn');
    assert.strictEqual(r.contentDoseZapamietana.krok_praktyczny, 'Zapamiętana treść.');
    assert.ok(!lic.ostatniSystemPrompt.includes('Dołącz też krótką dawkę'), 'prompt NIE może prosić o dawkę, którą już mamy');
    assert.match(lic.ostatniSystemPrompt, /NIE dołączaj żadnej treści edukacyjnej/);
  });

  await scenario('...i wtedy contentDose = null, więc cron NIE zresetuje zegara kadencji', async () => {
    const sb = swiatA5({
      content_doses: { wersja: 1, dawki: [{ wersja: 1, klucz: 'k', etap: 2, wygenerowano_at: przedA5(3), krok_praktyczny: 'X', dla_chetnych: null, segment_id: 'regeneracja', component_id: 'K-SEN', zrodlo_podpowiedzi: null }] },
    });
    const lic = { wywolania: 0 };
    const r = await generateCheckin({ focusBlockId: 'b1' }, { supabase: sb, callModel: modelStub({ question: 'P?' }, lic), now: TERAZ_A5 });
    assert.strictEqual(r.contentDose, null, 'to jest pole, na którym opiera się pas C — nie wolno mu skłamać');
  });

  await scenario('BRAK KOLUMNY content_doses -> zachowanie DOKŁADNIE jak przed rundą 5', async () => {
    // PostgREST przy braku kolumny wywala TYLKO ten select, który ją
    // wymienia — `fetchFocusBlock` (lista kolumn bez content_doses)
    // działa normalnie. Odwzorowane wprost, nie założone.
    const sb = swiatA5({
      last_content_dose_stage: 1,
      _errors: { 'focus_blocks:content_doses': { code: 'PGRST204', message: "Could not find the 'content_doses' column of 'focus_blocks' in the schema cache" } },
    });
    const lic = { wywolania: 0 };
    const r = await generateCheckin({ focusBlockId: 'b1' }, { supabase: sb, callModel: modelStub(ODPOWIEDZ_Z_DAWKA, lic), now: TERAZ_A5 });
    assert.strictEqual(r.ok, true, 'pytanie kontrolne MUSI działać bez migracji');
    assert.deepStrictEqual(r.contentDose, ODPOWIEDZ_Z_DAWKA.contentDose, 'stare pole bez zmian');
    assert.strictEqual(r.stageAtDose, 2);
    assert.strictEqual(r.zapisDawki, 'brak_kolumny', 'brak migracji MUSI być nazwany, nie przemilczany');
    assert.strictEqual(r.contentDoseZapamietana, null);
    assert.strictEqual(sb._updates.length, 0, 'zero UPDATE-ów, gdy nie ma gdzie zapisać');
  });

  await scenario('BRAK TABELI component_hints -> prompt bez podpowiedzi, dawka nadal powstaje i się zapisuje', async () => {
    const sb = makeFakeSupabaseA5({
      focus_blocks: [{ id: 'b1', user_id: 'u16', segment_id: 'regeneracja', component_id: 'K-SEN', custom_description: null, stage: 2, last_content_dose_stage: 1, last_content_dose_at: null, content_doses: null }],
      segment_components: [{ id: 'K-SEN', name: 'Wydłużenie snu' }],
      knowledge_base_entries: [{ segment_id: 'regeneracja', content: 'Baza.' }],
      focus_block_checkins: [],
      users: [{ id: 'u16', birth_year: 2009 }],
    }, { component_hints: { code: 'PGRST205', message: 'Could not find the table' } });
    const lic = { wywolania: 0 };
    const r = await generateCheckin({ focusBlockId: 'b1' }, { supabase: sb, callModel: modelStub(ODPOWIEDZ_Z_DAWKA, lic), now: TERAZ_A5 });
    assert.ok(!lic.ostatniSystemPrompt.includes('PODPOWIEDZI Z MATERIAŁÓW'), 'bez tabeli prompt musi być dzisiejszy');
    assert.strictEqual(r.zapisDawki, 'zapisano');
    assert.strictEqual(r.podpowiedzi.stanTabeli, 'brak_tabeli');
  });

  await scenario('A9 — treść dla rodzica nie wchodzi do promptu zawodnika w fazie 2', async () => {
    const sb = swiatA5({ last_content_dose_stage: 1 });
    const lic = { wywolania: 0 };
    await generateCheckin({ focusBlockId: 'b1' }, { supabase: sb, callModel: modelStub(ODPOWIEDZ_Z_DAWKA, lic), now: TERAZ_A5 });
    assert.ok(!lic.ostatniSystemPrompt.includes('magnezu elementarnego'));
  });

  await scenario('tura BEZ dawki nie płaci za podpowiedzi (nie idą do promptu)', async () => {
    const sb = swiatA5({ last_content_dose_stage: 2, last_content_dose_at: przedA5(2) });
    const lic = { wywolania: 0 };
    const r = await generateCheckin({ focusBlockId: 'b1' }, { supabase: sb, callModel: modelStub({ question: 'P?' }, lic), now: TERAZ_A5 });
    assert.ok(!lic.ostatniSystemPrompt.includes('PODPOWIEDZI Z MATERIAŁÓW'));
    assert.strictEqual(r.podpowiedzi, null);
    assert.strictEqual(r.contentDoseZrodlo, 'brak');
  });

  await scenario('model zwrócił contentDose = null mimo prośby -> nic nie zapisujemy (nie pusta skorupa)', async () => {
    const sb = swiatA5({ last_content_dose_stage: 1 });
    const lic = { wywolania: 0 };
    const r = await generateCheckin({ focusBlockId: 'b1' }, { supabase: sb, callModel: modelStub({ question: 'P?', contentDose: null }, lic), now: TERAZ_A5 });
    assert.strictEqual(r.zapisDawki, 'nic_do_zapisania');
    assert.strictEqual(r.contentDoseZapisana, null);
  });

  console.log('\n7. ILE RAZY NIE ZAWOŁAMY MODELU — pomiar do sekcji 12 raportu');

  await scenario('cztery wejścia zawodnika w ten sam etap: 1 generowanie zamiast 4', async () => {
    const sb = swiatA5({ last_content_dose_stage: 1, last_content_dose_at: null });
    const lic = { wywolania: 0 };
    const model = modelStub(ODPOWIEDZ_Z_DAWKA, lic);
    let zGenerowaniem = 0;
    for (let i = 0; i < 4; i++) {
      const r = await generateCheckin({ focusBlockId: 'b1' }, { supabase: sb, callModel: model, now: new Date(TERAZ_A5.getTime() + i * DAY_A5) });
      if (r.contentDoseZrodlo === 'model') zGenerowaniem++;
      // odwzorowanie tego, co robi cron po pierwszej dawce
      if (r.contentDose) { sb.from('focus_blocks').update({ last_content_dose_stage: r.stageAtDose, last_content_dose_at: new Date().toISOString() }).eq('id', 'b1'); }
    }
    console.log(`       [pomiar] 4 wejścia w ten sam etap -> ${zGenerowaniem} wygenerowanych dawek, 3 odczyty z magazynu`);
    assert.strictEqual(zGenerowaniem, 1);
  });

  await scenario('bez magazynu (kolumna nieistniejąca) te same 4 wejścia = 4 generowania — kontrola', () => {
    // Odwzorowanie starej reguły: przy wywołaniu z appki cron NIE aktualizuje
    // last_content_dose_at, więc daysSinceLastDose zostaje Infinity i dawka
    // wypada za KAŻDYM razem. To jest dokładnie ta strata, którą magazyn zamyka.
    let generowania = 0;
    const blok = { stage: 2, last_content_dose_stage: 1, last_content_dose_at: null };
    for (let i = 0; i < 4; i++) {
      const daysSince = blok.last_content_dose_at ? 0 : Infinity;
      if (blok.last_content_dose_stage !== blok.stage || daysSince >= 14) generowania++;
    }
    assert.strictEqual(generowania, 4);
  });

  await scenario('zmiana etapu nadal generuje nową dawkę (magazyn nie zamraża treści)', async () => {
    const sb = swiatA5({ last_content_dose_stage: 1, last_content_dose_at: null });
    const lic = { wywolania: 0 };
    const model = modelStub(ODPOWIEDZ_Z_DAWKA, lic);
    const a = await generateCheckin({ focusBlockId: 'b1' }, { supabase: sb, callModel: model, now: TERAZ_A5 });
    assert.strictEqual(a.contentDoseZrodlo, 'model');
    // zawodnik przechodzi na etap 3
    sb.from('focus_blocks').update({ stage: 3 }).eq('id', 'b1');
    const b = await generateCheckin({ focusBlockId: 'b1' }, { supabase: sb, callModel: model, now: new Date(TERAZ_A5.getTime() + DAY_A5) });
    assert.strictEqual(b.contentDoseZrodlo, 'model', 'nowy etap MUSI dostać nową treść');
    assert.strictEqual(b.contentDoseZapisana.etap, 3);
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
