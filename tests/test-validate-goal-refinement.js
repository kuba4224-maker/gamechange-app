// ============================================================
// GAMECHANGE — tests/test-validate-goal-refinement.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, piąta runda — kontynuacja "Pracuj dalej").
// validate-goal-refinement.js to miękka bramka jakości dla celu zawodnika
// (appka mobilna, cele.tsx) — świadomie NIGDY nie blokuje zapisu (patrz
// FILOZOFIA w promptcie systemowym), ale walidacja WEJŚCIA (segmentId/text/
// długość) MUSI działać poprawnie, bo to ostatnia linia obrony przed
// pustym/zbyt długim tekstem trafiającym do promptu Anthropic. Zero testu
// dotąd, zero zależności do stubowania (brak Supabase w tym pliku w ogóle
// — jedyny endpoint w projekcie, który go nie potrzebuje, patrz komentarz
// "RÓŻNICA" na górze pliku).
//
// `stripMarkdownJsonFence` dopisane dziś do `_internal` (istniała już w
// pliku) — czysto addytywne, żeby dało się ją przetestować.
//
// Świadomie NIE testujemy `callAnthropic`/ścieżki sukcesu
// `validateGoalRefinement()` (wymagałoby prawdziwego ANTHROPIC_API_KEY albo
// atrapy `fetch` — ten sam, ustalony w tym projekcie zakres) — ALE ścieżki
// walidacji wejścia (segmentId/text/długość) rzucają PRZED jakimkolwiek
// wywołaniem sieciowym, więc dają się przetestować bez żadnej atrapy.
//
// Uruchomienie: node tests/test-validate-goal-refinement.js
// ============================================================

const assert = require('assert');
const {
  validateGoalRefinement,
  _internal: { SEG_NAMES, buildSystemPrompt, buildUserPrompt, stripMarkdownJsonFence },
} = require('../api/validate-goal-refinement.js');

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
  console.log('validate-goal-refinement.js — testy jednostkowe');

  console.log('\n1. stripMarkdownJsonFence');

  await scenario('czysty JSON -> bez zmian', () => {
    assert.strictEqual(stripMarkdownJsonFence('{"passes":true}'), '{"passes":true}');
  });

  await scenario('owinięty w ```json ... ``` -> wyciągnięty', () => {
    assert.strictEqual(stripMarkdownJsonFence('```json\n{"passes":false,"hint":"x"}\n```'), '{"passes":false,"hint":"x"}');
  });

  await scenario('owinięty w ``` ... ``` (bez "json") -> wyciągnięty', () => {
    assert.strictEqual(stripMarkdownJsonFence('```\n{"passes":true}\n```'), '{"passes":true}');
  });

  console.log('\n2. buildSystemPrompt / buildUserPrompt');

  await scenario('buildSystemPrompt: wymusza filozofię "nawigator nie sędzia", NIGDY twardy blok', () => {
    const p = buildSystemPrompt();
    assert.match(p, /NAWIGATOREM, nie sędzią/);
    assert.match(p, /nigdy twardy blok/);
  });

  await scenario('buildSystemPrompt: wymienia dokładnie trzy kryteria (konkretność/dopasowanie/jedna rzecz)', () => {
    const p = buildSystemPrompt();
    assert.match(p, /KONKRETNOŚĆ/);
    assert.match(p, /DOPASOWANIE DO SEGMENTU/);
    assert.match(p, /JEDNA RZECZ/);
  });

  await scenario('buildSystemPrompt: format JSON z polami passes/hint, hint null gdy passes=true', () => {
    const p = buildSystemPrompt();
    assert.match(p, /"passes"/);
    assert.match(p, /"hint"/);
    assert.match(p, /w przeciwnym razie null/);
  });

  await scenario('buildSystemPrompt: ton NIGDY oceniający/karcący (nastoletni zawodnik)', () => {
    const p = buildSystemPrompt();
    assert.match(p, /nigdy oceniający\/karcący/);
    assert.match(p, /nastoletni zawodnik/);
  });

  await scenario('buildUserPrompt: wstrzykuje segmentName i text dosłownie', () => {
    const p = buildUserPrompt({ segmentName: 'Moc', text: 'Podciągnięcia 10 razy' });
    assert.match(p, /Segment: Moc\./);
    assert.match(p, /Podciągnięcia 10 razy/);
  });

  console.log('\n3. SEG_NAMES — kompletność słownika (13 segmentów)');

  await scenario('zawiera dokładnie 13 znanych segmentów z niepustymi polskimi etykietami', () => {
    const expected = ['moc', 'wytrzymalosc', 'fizycznosc', 'techFund', 'techSpec', 'regeneracja', 'odpornosc', 'odzywianie', 'tolerancja', 'koncentracja', 'mental', 'percepcja', 'decyzja'];
    assert.strictEqual(Object.keys(SEG_NAMES).length, 13);
    expected.forEach((id) => {
      assert.ok(SEG_NAMES[id] && SEG_NAMES[id].length > 0, `brak etykiety dla segmentu "${id}"`);
    });
  });

  console.log('\n4. validateGoalRefinement — walidacja wejścia (rzuca PRZED jakimkolwiek wywołaniem sieciowym)');

  await scenario('brak segmentId -> rzuca "Brak wymaganego segmentId"', async () => {
    await assert.rejects(() => validateGoalRefinement({ segmentId: null, text: 'Coś konkretnego' }), /Brak wymaganego segmentId/);
  });

  await scenario('segmentId niebędący stringiem (np. liczba) -> rzuca', async () => {
    await assert.rejects(() => validateGoalRefinement({ segmentId: 123, text: 'Coś konkretnego' }), /Brak wymaganego segmentId/);
  });

  await scenario('brak text -> rzuca "Brak wymaganego tekstu"', async () => {
    await assert.rejects(() => validateGoalRefinement({ segmentId: 'moc', text: null }), /Brak wymaganego tekstu/);
  });

  await scenario('text sam ze spacji (po trim pusty) -> rzuca tak samo jak brak text', async () => {
    await assert.rejects(() => validateGoalRefinement({ segmentId: 'moc', text: '   ' }), /Brak wymaganego tekstu/);
  });

  await scenario('text pusty string -> rzuca', async () => {
    await assert.rejects(() => validateGoalRefinement({ segmentId: 'moc', text: '' }), /Brak wymaganego tekstu/);
  });

  await scenario('text dokładnie 300 znaków (limit) -> PRZECHODZI walidację długości (rzuca dopiero na braku klucza API, nie na długości)', async () => {
    const text300 = 'x'.repeat(300);
    await assert.rejects(
      () => validateGoalRefinement({ segmentId: 'moc', text: text300 }),
      (err) => !/zbyt długi/.test(err.message),
      'dokładnie 300 znaków nie powinno być odrzucone jako "zbyt długi"'
    );
  });

  await scenario('text 301 znaków (o jeden za długi) -> rzuca "Tekst zbyt długi"', async () => {
    const text301 = 'x'.repeat(301);
    await assert.rejects(() => validateGoalRefinement({ segmentId: 'moc', text: text301 }), /Tekst zbyt długi \(max 300 znaków\)/);
  });

  await scenario('text z białymi znakami na brzegach, po przycięciu w limicie -> nie odrzucony za długość', async () => {
    // 300 znaków treści + otaczające spacje, które i tak zostaną przycięte przed sprawdzeniem długości.
    const text = '  ' + 'x'.repeat(300) + '  ';
    await assert.rejects(
      () => validateGoalRefinement({ segmentId: 'moc', text }),
      (err) => !/zbyt długi/.test(err.message)
    );
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();
