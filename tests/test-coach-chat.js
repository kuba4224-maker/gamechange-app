// ============================================================
// GAMECHANGE — tests/test-coach-chat.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, druga runda po "Wracaj do kolejki i pracuj" /
// "Pracuj dalej") — api/coach-chat.js eksportuje `_internal = {
// buildChatSystemPrompt, buildChatUserPrompt, checkCoachChatSoftCap }`
// dokładnie po to, żeby dało się je testować w izolacji (ten sam wzorzec co
// `_internal` w generate-recommendation.js) — ale nikt wcześniej testu nie
// napisał. Testuje TYLKO te trzy funkcje, świadomie NIE `runCoachChat()`
// całościowo — to wymagałoby atrapy `fetchAndAuthorizeTeam`/
// `resolveGrowthSpurtContext`/`callAnthropic` z generate-coach-tip.js, czyli
// w praktyce ponownego testowania TAMTEGO pliku, nie coach-chat.js. Trzy
// przetestowane funkcje to za to dokładnie GRANICA BEZPIECZEŃSTWA tego
// kanału (system prompt wymuszający przekierowanie medyczne) i logikę,
// którą najłatwiej byłoby przypadkiem zepsuć przy przyszłej edycji
// (kontekst skoku wzrostowego, siatka bezpieczeństwa 50/dobę).
//
// DLACZEGO Module._resolveFilename tak jak w test-submit-recommendation-
// feedback.js: samo `require('../api/coach-chat.js')` na starcie tego
// pliku ładuje na górze `require('./generate-coach-tip')._internal` — a
// generate-coach-tip.js samo importuje `@supabase/supabase-js`
// (niezainstalowane w tym środowisku). Ładujemy PRAWDZIWY
// generate-coach-tip.js (nie atrapę) — jego kod na poziomie modułu jest
// bezpieczny do wykonania (same definicje funkcji/stałych), więc
// wystarczy podstawić TYLKO pakiet supabase-js, żeby require się nie
// wywalił.
//
// Uruchomienie: node tests/test-coach-chat.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_2__.js');
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

const { buildChatSystemPrompt, buildChatUserPrompt, checkCoachChatSoftCap } =
  require('../api/coach-chat.js')._internal;

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

(async () => {
  console.log('coach-chat.js _internal — testy jednostkowe (buildChatSystemPrompt / buildChatUserPrompt / checkCoachChatSoftCap)');

  console.log('\n1. buildChatSystemPrompt — granica bezpieczeństwa medycznego');

  await scenario('zawiera wymuszenie is_medical_redirect + zakaz porady medycznej', () => {
    const prompt = buildChatSystemPrompt({ knowledgeBlock: '' });
    assert.match(prompt, /is_medical_redirect/);
    assert.match(prompt, /NIE udzielaj porady medycznej/);
  });

  await scenario('zawiera zasadę "tylko sygnalizuj, nigdy nie rankinguj"', () => {
    const prompt = buildChatSystemPrompt({ knowledgeBlock: '' });
    assert.match(prompt, /TYLKO SYGNALIZUJESZ/);
    assert.match(prompt, /NIGDY nie wskazuj konkretnego zawodnika/);
  });

  await scenario('knowledgeBlock wstrzyknięty dosłownie do promptu', () => {
    const marker = '###ZNACZNIK-BAZY-WIEDZY-TESTOWEJ###';
    const prompt = buildChatSystemPrompt({ knowledgeBlock: marker });
    assert.ok(prompt.includes(marker), 'prompt powinien zawierać przekazany knowledgeBlock bez zmian');
  });

  await scenario('wymusza format czystego JSON (bez markdown)', () => {
    const prompt = buildChatSystemPrompt({ knowledgeBlock: '' });
    assert.match(prompt, /WYŁĄCZNIE poprawny JSON/);
    assert.match(prompt, /answer_text/);
    assert.match(prompt, /redirect_note/);
  });

  console.log('\n2. buildChatUserPrompt — kontekst pytania trenera');

  await scenario('samo pytanie, bez fazy sezonu i bez kontekstu skoku wzrostowego -> jedna linia', () => {
    const prompt = buildChatUserPrompt({ questionText: 'Jak zaplanować tydzień przed meczem?', seasonPhase: null, growthSpurtContext: null });
    assert.strictEqual(prompt, 'Pytanie trenera: Jak zaplanować tydzień przed meczem?');
  });

  await scenario('seasonPhase="sezon_rozgrywkowy" -> dokładna etykieta "Sezon rozgrywkowy"', () => {
    const prompt = buildChatUserPrompt({ questionText: 'Q', seasonPhase: 'sezon_rozgrywkowy', growthSpurtContext: null });
    assert.match(prompt, /Sezon rozgrywkowy/);
    assert.ok(!prompt.includes('Faza przygotowawcza'));
  });

  await scenario('seasonPhase="przygotowawcza" (cokolwiek innego niż sezon_rozgrywkowy) -> "Faza przygotowawcza"', () => {
    const prompt = buildChatUserPrompt({ questionText: 'Q', seasonPhase: 'przygotowawcza', growthSpurtContext: null });
    assert.match(prompt, /Faza przygotowawcza/);
  });

  await scenario('growthSpurtContext.inGrowthSpurtAgeRange=false -> brak wzmianki o skoku wzrostowym', () => {
    const prompt = buildChatUserPrompt({ questionText: 'Q', seasonPhase: null, growthSpurtContext: { inGrowthSpurtAgeRange: false } });
    assert.ok(!prompt.includes('szczytowego tempa wzrostu'));
  });

  await scenario('growthSpurtContext.inGrowthSpurtAgeRange=true, heightGrowthRateElevated=false -> wzmianka BEZ frazy o podwyższonym tempie', () => {
    const prompt = buildChatUserPrompt({
      questionText: 'Q',
      seasonPhase: null,
      growthSpurtContext: { inGrowthSpurtAgeRange: true, heightGrowthRateElevated: false },
    });
    assert.match(prompt, /szczytowego tempa wzrostu/);
    assert.ok(!prompt.includes('podwyższone'));
  });

  await scenario('growthSpurtContext.heightGrowthRateElevated=true -> wzmianka Z frazą o podwyższonym tempie (>7,2 cm/rok)', () => {
    const prompt = buildChatUserPrompt({
      questionText: 'Q',
      seasonPhase: null,
      growthSpurtContext: { inGrowthSpurtAgeRange: true, heightGrowthRateElevated: true },
    });
    assert.match(prompt, /tempo wzrostu jest podwyższone/);
    assert.match(prompt, /7,2 cm\/rok/);
  });

  await scenario('wszystkie trzy elementy naraz -> trzy linie w kolejności pytanie/sezon/wzrost', () => {
    const prompt = buildChatUserPrompt({
      questionText: 'Czy mogę dziś dać plyometrię?',
      seasonPhase: 'sezon_rozgrywkowy',
      growthSpurtContext: { inGrowthSpurtAgeRange: true, heightGrowthRateElevated: true },
    });
    const lines = prompt.split('\n');
    assert.strictEqual(lines.length, 3);
    assert.match(lines[0], /^Pytanie trenera:/);
    assert.match(lines[1], /Sezon rozgrywkowy/);
    assert.match(lines[2], /szczytowego tempa wzrostu/);
  });

  console.log('\n3. checkCoachChatSoftCap — siatka bezpieczeństwa 50/dobę (atrapa Supabase)');

  function makeFakeSupabase(count) {
    return {
      from() {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          gte() { return builder; },
          then(resolve, reject) {
            Promise.resolve({ count, error: null }).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  }

  await scenario('count=0 -> allowed:true', async () => {
    const r = await checkCoachChatSoftCap(makeFakeSupabase(0), 'coach-1');
    assert.strictEqual(r.allowed, true);
  });

  await scenario('count=49 (tuż pod progiem 50) -> allowed:true', async () => {
    const r = await checkCoachChatSoftCap(makeFakeSupabase(49), 'coach-1');
    assert.strictEqual(r.allowed, true);
  });

  await scenario('count=50 (dokładnie na progu) -> allowed:false', async () => {
    const r = await checkCoachChatSoftCap(makeFakeSupabase(50), 'coach-1');
    assert.strictEqual(r.allowed, false);
    assert.match(r.reason, /50/);
  });

  await scenario('count=51 (powyżej progu) -> allowed:false', async () => {
    const r = await checkCoachChatSoftCap(makeFakeSupabase(51), 'coach-1');
    assert.strictEqual(r.allowed, false);
  });

  await scenario('count=null (Supabase czasem zwraca null zamiast 0) -> traktowane jak 0, allowed:true', async () => {
    const r = await checkCoachChatSoftCap(makeFakeSupabase(null), 'coach-1');
    assert.strictEqual(r.allowed, true);
  });

  await scenario('błąd z Supabase -> funkcja rzuca (nie połyka błędu po cichu)', async () => {
    const supabase = {
      from() {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          gte() { return builder; },
          then(resolve, reject) {
            Promise.resolve({ count: null, error: { message: 'connection lost' } }).then(resolve, reject);
          },
        };
        return builder;
      },
    };
    await assert.rejects(() => checkCoachChatSoftCap(supabase, 'coach-1'), /connection lost/);
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
