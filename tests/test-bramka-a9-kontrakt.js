// ============================================================
// GAMECHANGE — tests/test-bramka-a9-kontrakt.js
// ============================================================
// DOZOWANIE A6 08.08.2026 — NOWY PLIK.
//
// PO CO TO JEST: bramka wiekowa A9 ("podpowiedzi z dawkami suplementacyjnymi
// idą do zawodnika dopiero od 16 lat, wcześniej wyłącznie do rodzica") żyje
// dziś w TRZECH niezależnych implementacjach:
//
//   1. JS backendu — `lib/recommendation-hints.js`
//      (`computeAgeLowerBound` + `applyAgeGate` w `selectHintsForPrompt`),
//   2. TS appki — strona pasa B,
//   3. SQL raportu rodzica.
//
// I NIC nie pilnowało ich zgodności. Rozjazd nie rzuca błędem — po prostu
// czternastolatek dostaje na ekranie dawkę suplementu albo (w drugą stronę)
// szesnastolatek nie dostaje niczego, a wygląda to jak "nie ma podpowiedzi".
// Dokładnie ten wzorzec "cichego braku", który audyt bloku 3 nazwał po
// imieniu.
//
// TEN PLIK JEST DOWODEM DLA STRONY (1). Fixture
// `tests/fixtures/bramka-a9-fixture.json` jest KANONICZNY i WSPÓLNY: te same
// 11 wierszy i ta sama tabela oczekiwań idą do pasa B na stronę TS. Jeśli
// któraś strona przestanie się zgadzać, jeden z dwóch testów spadnie na
// czerwono — i to jest cała wartość tego pliku.
//
// ⚠️ WŁASNOŚĆ BEZPIECZEŃSTWA, KTÓRĄ TEN TEST NAZYWA WPROST (grupa 4):
// przy NIEZNANYM wieku zawodnika wiersze z `min_age` są UKRYWANE — bezpiecznie
// domyślnie — a `wiekNieznany: true` jest JAWNIE raportowane. "Nie wiem, ile
// ma lat" i "sprawdziłem i nic nie było" to dwie różne rzeczy i produkt musi
// je rozróżniać (reguła R5).
//
// `lib/recommendation-hints.js` jest tu WYŁĄCZNIE IMPORTOWANY — ani jednej
// zmiany. To jedyne źródło reguły A9 dla trzech konsumentów (silnik
// rekomendacji, faza 2 Bloku, faza 1 Bloku).
//
// Zero atrap: testowane funkcje są czyste i nie dotykają ani Supabase, ani
// `@supabase/supabase-js`.
//
// Uruchomienie: node tests/test-bramka-a9-kontrakt.js
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  computeAgeLowerBound,
  selectHintsForPrompt,
  HINT_LIMIT,
  PLAYER_AUDIENCES,
} = require('../lib/recommendation-hints.js');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'bramka-a9-fixture.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

const NOW = new Date(fixture.now);

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

// Jedno przejście fixture'u przez DOKŁADNIE tę drogę, którą opisuje
// polecenie: computeAgeLowerBound -> selectHintsForPrompt.
function przepusc(birthYear, wiersze = fixture.wiersze) {
  const ageLowerBound = computeAgeLowerBound(birthYear, NOW);
  const wynik = selectHintsForPrompt({
    hints: wiersze,
    goalComponentId: fixture.goalComponentId,
    ageLowerBound,
    limit: fixture.limit,
  });
  return { ageLowerBound, wynik };
}

// TERMINARZ A7 08.08.2026 — fixture v2 nosi już PRAWDZIWE nazwy kolumn
// (`hint`/`strony`, znalezisko A32 zamknięte). Ten helper przemianowuje
// wiersze z powrotem na STARE nazwy z v1 (`tresc`/`strona`) — grupa 5
// dowodzi nim, że bramka A9 tych pól nie czyta, więc wyniki v1 == v2.
function naStareNazwy(wiersze) {
  return wiersze.map((w) => {
    const kopia = { ...w, tresc: w.hint, strona: w.strony };
    delete kopia.hint;
    delete kopia.strony;
    return kopia;
  });
}

// Zbierane w trakcie testów, wypisywane na końcu jako gotowa tabela do
// sekcji 11 raportu. WYGENEROWANA PRZEZ TEST, nie przepisana ręcznie —
// to jest wyjście tego samego kodu, który filtruje podpowiedzi w produkcji.
const wiersze_tabeli = [];

console.log('bramka wiekowa A9 — test kontraktowy (fixture kanoniczny, wspólny z pasem B)');

// ------------------------------------------------------------
console.log('\n1. Fixture — integralność wejścia (skrót klucza cicho psuje dopasowanie)');

scenario('fixture ma dokładnie 11 wierszy wejściowych', () => {
  assert.strictEqual(fixture.wiersze.length, 11);
});

scenario('wszystkie klucze są unikalne i w pełnym brzmieniu (fx-NN-...)', () => {
  const klucze = fixture.wiersze.map((w) => w.klucz);
  assert.strictEqual(new Set(klucze).size, 11, 'klucze muszą być unikalne');
  for (const k of klucze) {
    assert.match(k, /^fx-\d{2}-[a-z0-9-]+$/, `klucz "${k}" nie ma pełnego brzmienia z fixture'u`);
  }
});

scenario('każdy wiersz niesie komplet pól, od których zależy bramka A9', () => {
  const wymagane = ['klucz', 'odbiorca', 'min_age', 'active', 'component_id', 'obszar_name', 'element_name', 'pozycja'];
  for (const w of fixture.wiersze) {
    for (const pole of wymagane) {
      assert.ok(Object.prototype.hasOwnProperty.call(w, pole), `wiersz ${w.klucz} nie ma pola ${pole}`);
    }
  }
});

scenario('fixture zakłada limit 12 — ten sam co HINT_LIMIT w lib/recommendation-hints.js', () => {
  assert.strictEqual(fixture.limit, HINT_LIMIT);
});

scenario('fixture v3 ma 4 przypadki oczekiwane (14 lat / 16 lat / 18 lat DOROSŁY R11 / wiek nieznany)', () => {
  assert.strictEqual(fixture.oczekiwane.length, 4);
});

// ------------------------------------------------------------
console.log('\n2. computeAgeLowerBound — DOLNA granica wieku z samego rocznika');

scenario('rocznik 2011 przy NOW=2026 -> 14 (nie 15: liczymy dolną granicę, urodziny mogły nie być)', () => {
  assert.strictEqual(computeAgeLowerBound(2011, NOW), 14);
});

scenario('rocznik 2009 przy NOW=2026 -> 16 (pewność 16+, bramka przepuszcza)', () => {
  assert.strictEqual(computeAgeLowerBound(2009, NOW), 16);
});

scenario('rocznik 2010 przy NOW=2026 -> 15 — NIE przechodzi, choć zawodnik może już mieć 16', () => {
  assert.strictEqual(computeAgeLowerBound(2010, NOW), 15);
});

scenario('brak rocznika (null / pusty string / śmieci) -> null, nigdy NaN i nigdy 0', () => {
  assert.strictEqual(computeAgeLowerBound(null, NOW), null);
  assert.strictEqual(computeAgeLowerBound('', NOW), null);
  assert.strictEqual(computeAgeLowerBound('nie-rocznik', NOW), null);
  assert.strictEqual(computeAgeLowerBound(undefined, NOW), null);
});

// ------------------------------------------------------------
console.log('\n3. selectHintsForPrompt — trzy przypadki z tabeli fixture\'u');

for (const oczekiwany of fixture.oczekiwane) {
  const { ageLowerBound, wynik } = przepusc(oczekiwany.birthYear);
  const klucze = wynik.hints.map((h) => h.klucz);
  const celowania = wynik.hints.map((h) => h.celowanie);

  wiersze_tabeli.push({
    przypadek: oczekiwany.przypadek,
    ageLowerBound,
    wynik: wynik.hints.map((h) => `${h.klucz} [${h.celowanie}]`).join(' · '),
    ukryteZPowoduWieku: wynik.ukryteZPowoduWieku,
    odrzuconePrzezOdbiorce: wynik.odrzuconePrzezOdbiorce,
    nieaktywne: wynik.nieaktywne,
    pominieteObceElementy: wynik.pominieteObceElementy,
    wiekNieznany: wynik.wiekNieznany,
  });

  scenario(`${oczekiwany.przypadek}: ageLowerBound = ${oczekiwany.ageLowerBound}`, () => {
    assert.strictEqual(ageLowerBound, oczekiwany.ageLowerBound);
  });

  scenario(`${oczekiwany.przypadek}: KOLEJNOŚĆ kluczy w wyniku zgodna co do sztuki`, () => {
    assert.deepStrictEqual(klucze, oczekiwany.kolejnoscKluczy);
  });

  scenario(`${oczekiwany.przypadek}: celowanie każdego wiersza zgodne`, () => {
    assert.deepStrictEqual(celowania, oczekiwany.celowanie);
  });

  scenario(`${oczekiwany.przypadek}: ukryteZPowoduWieku = ${oczekiwany.ukryteZPowoduWieku}`, () => {
    assert.strictEqual(wynik.ukryteZPowoduWieku, oczekiwany.ukryteZPowoduWieku);
  });

  scenario(`${oczekiwany.przypadek}: odrzuconePrzezOdbiorce = ${oczekiwany.odrzuconePrzezOdbiorce}`, () => {
    assert.strictEqual(wynik.odrzuconePrzezOdbiorce, oczekiwany.odrzuconePrzezOdbiorce);
  });

  scenario(`${oczekiwany.przypadek}: nieaktywne = ${oczekiwany.nieaktywne}`, () => {
    assert.strictEqual(wynik.nieaktywne, oczekiwany.nieaktywne);
  });

  scenario(`${oczekiwany.przypadek}: pominieteObceElementy = ${oczekiwany.pominieteObceElementy}`, () => {
    assert.strictEqual(wynik.pominieteObceElementy, oczekiwany.pominieteObceElementy);
  });

  scenario(`${oczekiwany.przypadek}: wiekNieznany = ${oczekiwany.wiekNieznany}`, () => {
    assert.strictEqual(wynik.wiekNieznany, oczekiwany.wiekNieznany);
  });

  // DOROSŁY R11: u nieletniego/nieznanego wieku 'rodzic' nadal NIGDY nie
  // przechodzi; u dorosłego przechodzi CELOWO i jest jawnie policzony.
  scenario(`${oczekiwany.przypadek}: dorosly = ${oczekiwany.dorosly}, wlaczoneZWarstwyRodzica = ${oczekiwany.wlaczoneZWarstwyRodzica}`, () => {
    assert.strictEqual(wynik.dorosly, oczekiwany.dorosly);
    assert.strictEqual(wynik.wlaczoneZWarstwyRodzica, oczekiwany.wlaczoneZWarstwyRodzica);
  });

  scenario(oczekiwany.dorosly
    ? `${oczekiwany.przypadek}: wiersze 'rodzic' przeszły WYŁĄCZNIE przez routing dorosłego (R11)`
    : `${oczekiwany.przypadek}: ani jeden wiersz 'rodzic' nie przeszedł do zawodnika`, () => {
    for (const h of wynik.hints) {
      if (oczekiwany.dorosly) {
        assert.ok(PLAYER_AUDIENCES.includes(h.odbiorca) || h.odbiorca === 'rodzic',
          `wiersz ${h.klucz} ma odbiorca=${h.odbiorca}`);
      } else {
        assert.ok(PLAYER_AUDIENCES.includes(h.odbiorca), `wiersz ${h.klucz} ma odbiorca=${h.odbiorca}`);
      }
    }
  });

  scenario(`${oczekiwany.przypadek}: żaden wiersz active=false nie przeszedł`, () => {
    for (const h of wynik.hints) assert.notStrictEqual(h.active, false);
  });
}

// ------------------------------------------------------------
console.log('\n4. WŁASNOŚĆ BEZPIECZEŃSTWA — nieznany wiek UKRYWA, i mówi o tym wprost');

scenario('nieznany wiek: ŻADEN wiersz z min_age nie trafia do zawodnika', () => {
  const { wynik } = przepusc(null);
  const zWiekiem = wynik.hints.filter((h) => h.min_age != null);
  assert.deepStrictEqual(zWiekiem.map((h) => h.klucz), [],
    'przy nieznanym wieku wiersz z min_age NIE MA prawa przejść — to jest bezpieczna strona błędu (decyzja A9)');
});

scenario('nieznany wiek: wiekNieznany=true JEST raportowane (pustka bez nazwy to cichy brak)', () => {
  const { wynik } = przepusc(null);
  assert.strictEqual(wynik.wiekNieznany, true);
  assert.strictEqual(wynik.ukryteZPowoduWieku, 3);
});

scenario('nieznany wiek daje DOKŁADNIE ten sam wynik co 14-latek — brak wiedzy traktujemy jak brak uprawnienia', () => {
  const nieznany = przepusc(null).wynik;
  const czternastolatek = przepusc(2011).wynik;
  assert.deepStrictEqual(nieznany.hints.map((h) => h.klucz), czternastolatek.hints.map((h) => h.klucz));
  assert.strictEqual(nieznany.ukryteZPowoduWieku, czternastolatek.ukryteZPowoduWieku);
});

scenario('ale NIE są nieodróżnialne: 14-latek ma wiekNieznany=false, nieznany ma true', () => {
  assert.strictEqual(przepusc(2011).wynik.wiekNieznany, false);
  assert.strictEqual(przepusc(null).wynik.wiekNieznany, true);
});

scenario('16-latek dostaje DOKŁADNIE trzy wiersze więcej — i to są te trzy z min_age', () => {
  const czternascie = new Set(przepusc(2011).wynik.hints.map((h) => h.klucz));
  const szesnascie = przepusc(2009).wynik.hints;
  const roznica = szesnascie.filter((h) => !czternascie.has(h.klucz)).map((h) => h.klucz).sort();
  assert.deepStrictEqual(roznica, ['fx-02-zawodnik-16plus', 'fx-03-oba-16plus', 'fx-11-zawodnik-16plus-el']);
  for (const k of roznica) {
    const w = fixture.wiersze.find((x) => x.klucz === k);
    assert.strictEqual(w.min_age, 16);
  }
});

scenario('granica jest ostra: rocznik 2010 (dolna 15) zachowuje się jak 14-latek, nie jak 16-latek', () => {
  const pietnascie = przepusc(2010).wynik;
  assert.strictEqual(pietnascie.ukryteZPowoduWieku, 3);
  assert.deepStrictEqual(
    pietnascie.hints.map((h) => h.klucz),
    fixture.oczekiwane.find((o) => o.birthYear === 2011).kolejnoscKluczy
  );
});

// ------------------------------------------------------------
console.log('\n4b. DOROSŁY R11 — „18+ = własny rodzic": warstwa rodzica wchodzi dopiero przy PEWNEJ pełnoletności');

scenario('dorosły (rocznik 2007) dostaje DOKŁADNIE dwa wiersze więcej niż 16-latek — i to są te z odbiorca=rodzic', () => {
  const szesnascie = new Set(przepusc(2009).wynik.hints.map((h) => h.klucz));
  const dorosly = przepusc(2007).wynik;
  const roznica = dorosly.hints.filter((h) => !szesnascie.has(h.klucz)).map((h) => h.klucz).sort();
  assert.deepStrictEqual(roznica, ['fx-04-rodzic-16plus', 'fx-05-rodzic-bez-wieku']);
  for (const k of roznica) {
    assert.strictEqual(fixture.wiersze.find((x) => x.klucz === k).odbiorca, 'rodzic');
  }
});

scenario('granica dorosłości KONSERWATYWNA: rocznik 2008 (dolna 17) NIE dostaje warstwy rodzica', () => {
  const siedemnascie = przepusc(2008).wynik;
  assert.strictEqual(siedemnascie.dorosly, false);
  assert.strictEqual(siedemnascie.wlaczoneZWarstwyRodzica, 0);
  assert.deepStrictEqual(
    siedemnascie.hints.map((h) => h.klucz),
    fixture.oczekiwane.find((o) => o.birthYear === 2009).kolejnoscKluczy
  );
});

scenario('nieznany wiek NIGDY nie włącza warstwy rodzica (fail-closed, ta sama strona błędu co A9)', () => {
  const nieznany = przepusc(null).wynik;
  assert.strictEqual(nieznany.dorosly, false);
  assert.strictEqual(nieznany.wlaczoneZWarstwyRodzica, 0);
  assert.ok(!nieznany.hints.some((h) => h.odbiorca === 'rodzic'));
});

scenario('bramka A9 działa na wierszach z warstwy rodzica dalej: min_age=21 przytrzymałoby 18-latka', () => {
  const podniesione = fixture.wiersze.map((w) =>
    w.klucz === 'fx-04-rodzic-16plus' ? { ...w, min_age: 21 } : w);
  const wynik = przepusc(2007, podniesione).wynik;
  assert.ok(!wynik.hints.some((h) => h.klucz === 'fx-04-rodzic-16plus'));
  assert.strictEqual(wynik.ukryteZPowoduWieku, 1);
});

// ------------------------------------------------------------
console.log('\n5. Nazwy pól — czy fixture jest wierny kolumnom component_hints');

scenario('fixture v3 używa PRAWDZIWYCH nazw kolumn component_hints ("hint"/"strony") — A32 zamknięte', () => {
  assert.ok(fixture._uwaga_o_nazwach_pol, 'fixture musi nazywać historię tej zmiany wprost');
  assert.ok(fixture._dorosly_r11, 'fixture v3 musi nazywać routing dorosłego wprost');
  assert.strictEqual(fixture.wersja, 3, 'to musi być fixture v3 (DOROSŁY R11)');
  assert.ok(fixture.wiersze.every((w) => 'hint' in w && 'strony' in w));
  assert.ok(fixture.wiersze.every((w) => !('tresc' in w) && !('strona' in w)),
    'stare nazwy v1 nie mają prawa wrócić — cichy rozjazd z bazą');
});

scenario('zmiana nazw v1→v2 NIE zmienia ANI JEDNEGO wyniku bramki A9 — sprawdzone, nie założone', () => {
  for (const oczekiwany of fixture.oczekiwane) {
    const surowy = przepusc(oczekiwany.birthYear).wynik;
    const przemianowany = przepusc(oczekiwany.birthYear, naStareNazwy(fixture.wiersze)).wynik;
    assert.deepStrictEqual(
      przemianowany.hints.map((h) => h.klucz),
      surowy.hints.map((h) => h.klucz),
      `rozjazd przy: ${oczekiwany.przypadek}`
    );
    assert.strictEqual(przemianowany.ukryteZPowoduWieku, surowy.ukryteZPowoduWieku);
    assert.strictEqual(przemianowany.odrzuconePrzezOdbiorce, surowy.odrzuconePrzezOdbiorce);
  }
});

scenario('od v2 fixture NADAJE SIĘ też do funkcji czytających treść (formatHintLine widzi hint/strony/zrodlo)', () => {
  // W v1 ten scenariusz BLOKOWAŁ użycie fixture'u do renderowania (undefined
  // w promptcie). Po przemianowaniu pól blokada jest zbędna — pilnujemy
  // teraz tego, że pola treści faktycznie SĄ i mają niepuste wartości.
  const w = fixture.wiersze[0];
  assert.ok(typeof w.hint === 'string' && w.hint.length > 0);
  assert.ok(typeof w.strony === 'string' && w.strony.length > 0);
  assert.ok(typeof w.zrodlo === 'string' && w.zrodlo.length > 0);
});

// ------------------------------------------------------------
console.log('\n6. Determinizm — ten sam wsad daje ten sam wynik przy każdym uruchomieniu');

scenario('trzy kolejne przebiegi tego samego przypadku dają identyczny wynik', () => {
  const a = przepusc(2009).wynik.hints.map((h) => h.klucz);
  const b = przepusc(2009).wynik.hints.map((h) => h.klucz);
  const c = przepusc(2009).wynik.hints.map((h) => h.klucz);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(b, c);
});

scenario('kolejność wierszy NA WEJŚCIU nie wpływa na wynik (sortowanie jest deterministyczne)', () => {
  const odwrocone = [...fixture.wiersze].reverse();
  const normalnie = przepusc(2009).wynik.hints.map((h) => h.klucz);
  const odwrotnie = przepusc(2009, odwrocone).wynik.hints.map((h) => h.klucz);
  assert.deepStrictEqual(odwrotnie, normalnie);
});

// ------------------------------------------------------------
// TABELA DO SEKCJI 11 RAPORTU — wygenerowana przez ten test, nie ręcznie.
// ------------------------------------------------------------
console.log('\n--- TABELA PRZEJŚĆ/ODRZUCEŃ (do sekcji 11 raportu, generowana) ---\n');
console.log('| przypadek | ageLowerBound | kolejność kluczy w wyniku | ukryteZPowoduWieku | odrzuconePrzezOdbiorce | nieaktywne | pominieteObceElementy |');
console.log('|---|---:|---|---:|---:|---:|---:|');
for (const w of wiersze_tabeli) {
  console.log(`| ${w.przypadek} | ${w.ageLowerBound === null ? 'null' : w.ageLowerBound} | ${w.wynik} | ${w.ukryteZPowoduWieku} | ${w.odrzuconePrzezOdbiorce} | ${w.nieaktywne} | ${w.pominieteObceElementy} |`);
}
console.log('');

console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
process.exit(failed === 0 ? 0 : 1);
