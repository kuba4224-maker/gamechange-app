// ============================================================
// GAMECHANGE — lib/recommendation-hints.js
// ============================================================
// PODPOWIEDZI SILNIK A4 08.08.2026 — NOWY PLIK.
//
// PO CO TO JEST: silnik rekomendacji ma dziś bazę wiedzy
// (`knowledge_base_entries`, 13 wpisów — jeden akapit na segment) i
// taksonomię (`segment_components`, 99 wierszy), ale taksonomia karmi
// wyłącznie UI, nie prompt AI. To jest luka 4e z
// `claude/AUDYT_BAZY_WIEDZY_REKOMENDACJI.md`.
//
// Od rundy 3 istnieje trzecia warstwa: `component_hints` — 214 atomowych
// podpowiedzi wyciągniętych ze 152 stron materiałów Kuby, każda z numerem
// strony (`claude/PODPOWIEDZI_Z_MATERIALOW_A.md`). Nikt ich dotąd nie
// czytał. Ten plik je czyta, filtruje i podaje silnikowi w postaci gotowej
// do wstrzyknięcia w prompt — oraz wybiera JEDNĄ, którą rekomendacja
// niesie ze sobą do zapisu, żeby zawodnik zobaczył ją na ekranie
// (reguła R1: zadanie nie jest skończone, dopóki człowiek tego nie widzi).
//
// WZORZEC: ten sam podział co `lib/coach-digest-signals.js` (logika) +
// `lib/coach-digest.js` (I/O) — warstwa czysta niżej nie dotyka Supabase
// i jest w całości testowalna bez atrapy bazy; warstwa I/O to cienka
// otoczka na końcu pliku.
//
// OGRANICZENIE O1: `gamechange-app/api/` ma 12 z 12 plików (limit Vercel
// Hobby) — cała nowa logika MUSI mieszkać w `lib/`, tak jak
// `lib/coach-tip-feedback.js` i `lib/coach-digest.js`. To nie jest
// preferencja stylu.
//
// ------------------------------------------------------------
// REGUŁA R5 — JAWNY STAN "NIE WIEM" (wzorzec "cichy brak" z bloku 3)
// ------------------------------------------------------------
// Funkcja, która przy braku danych albo braku uprawnień zwraca pustkę
// zamiast błędu, musi mieć jawny stan "nie wiem". W tym pliku dotyczy to
// TRZECH rzeczy, każda ma własne pole w wyniku — nigdy ciche pominięcie:
//
//   1. `component_hints` może jeszcze nie istnieć (Kuba może nie zdążyć
//      wkleić migracji). -> `stanTabeli: 'brak_tabeli'`. Silnik zachowuje
//      się DOKŁADNIE tak jak dziś i zapisuje to w logu jako jawny stan.
//      Nigdy nie udajemy, że tabela była i nic ciekawego w niej nie było.
//
//   2. `component_id = NULL` znaczy DWIE RÓŻNE RZECZY, a w bazie wygląda
//      identycznie:
//        - przy 108 z 214 podpowiedzi to ZAMIERZONE — reguła przekrojowa
//          całego segmentu, która nigdy nie miała Obszaru ani Elementu;
//        - przy pozostałych 106 oznaczałoby NIEUDANE dopasowanie nazwy
//          komponentu w migracji (podpowiedź działa, ale straciła
//          celowanie — dokładnie ten defekt, który audyt bloku 3 nazwał
//          "cichym brakiem" po stronie pasa A).
//      ODRÓŻNIAMY JE PO KOLUMNACH NAZW, nie po `component_id`:
//        component_id IS NULL AND obszar_name IS NULL AND element_name IS NULL
//          -> zamierzona reguła segmentowa (`celowanie: 'segment'`)
//        component_id IS NULL AND (obszar_name lub element_name NIE JEST NULL)
//          -> NIEUDANE dopasowanie (`celowanie: 'niedopasowany'`)
//      Migracja wypełnia `obszar_name`/`element_name` ZAWSZE, gdy
//      podpowiedź miała celować w komponent — więc obecność nazwy przy
//      pustym `component_id` jest jednoznacznym dowodem nieudanego
//      dopasowania. Liczba takich podpowiedzi wychodzi w wyniku jako
//      `niedopasowane` i trafia do logu. Oczekiwana wartość: 0.
//
//   3. Nieznany wiek zawodnika (`users.birth_year` puste). Warunek
//      `wiek >= min_age` w SQL wyłożyłby się wtedy na NULL i podpowiedzi
//      z dawkami nie pokazałyby się NIKOMU — po cichu. To jest bezpieczna
//      strona błędu (decyzja A9) i MA taka zostać, ale musi być jawna:
//      `wiekNieznany: true` + `ukryteZPowoduWieku: n`.
//
// ------------------------------------------------------------
// WIEK — dlaczego dolna, nie górna granica
// ------------------------------------------------------------
// Appka zbiera wyłącznie ROCZNIK (`users.birth_year`), nie pełną datę
// urodzenia — patrz `lib/parental-payment-consent.js`, gdzie ta sama
// niepewność jest już obsłużona. `rokBiezacy - birth_year` to GÓRNA
// granica prawdziwego wieku (kto nie miał jeszcze urodzin, ma realnie o
// rok mniej). Bramka A9 ma przepuszczać dawki dopiero, gdy mamy PEWNOŚĆ
// wieku 16+, więc liczymy DOLNĄ granicę: `(rokBiezacy - birth_year) - 1`.
// Rocznik 2009 w 2026 daje górną 17, dolną 16 -> przechodzi. Rocznik 2010
// daje dolną 15 -> nie przechodzi, choć zawodnik może już mieć 16.
// To jest świadomie konserwatywne w tę samą stronę co reszta projektu.
// ============================================================

// Limit podpowiedzi na jedno wywołanie. Regeneracja ma ich 24 (najwięcej
// z 13 segmentów) — wstrzyknięcie wszystkiego dokłada kilka tysięcy znaków
// do KAŻDEGO wywołania Anthropic. Pomiar w znakach: patrz sekcja 12
// raportu `claude/RAPORT_ZWROTNY_A_RUNDA_4.md`.
const HINT_LIMIT = 12;

// Do promptu zawodnika idą WYŁĄCZNIE te dwie wartości. Nigdy 'rodzic' —
// warstwa rodzica (raport rodzica, decyzja A3 + B4) to osobna robota,
// pas C tej rundy. Ta stała jest jedynym miejscem, w którym ta reguła
// żyje — nie powtarzaj jej w zapytaniu.
const PLAYER_AUDIENCES = Object.freeze(['zawodnik', 'oba']);

// Rangi celowania, od najlepszej. Zawodnik pracujący nad konkretnym
// Elementem ma najpierw dostać to, co jego dotyczy.
const CELOWANIE_RANK = Object.freeze({
  element_celu: 0,   // przypięta dokładnie do komponentu, który zawodnik wybrał w Bloku Skupienia
  obszar: 1,         // przypięta do Obszaru (component_id jest, element_name puste)
  segment: 2,        // zamierzona reguła przekrojowa całego segmentu (component_id IS NULL)
  niedopasowany: 3,  // R5 pkt 2 — nieudane dopasowanie nazwy, działa ale bez celowania
  inny_element: 4,   // Element INNY niż cel zawodnika — domyślnie odfiltrowany
});

// Kolumny `goals`, pod którymi w tym projekcie mógł wylądować wybrany
// Element Bloku Skupienia. Nazwa nie jest potwierdzona na żywym schemacie
// (dokumentacja projektu sama sobie przeczy — patrz `FILTR JAKOSCI
// POLECENIE NOWA SESJA.md`, "SPRZECZNOŚĆ W DOKUMENTACJI"), więc zamiast
// zgadywać jedną, sprawdzamy listę kandydatów na realnym wierszu i gdy
// żadnej nie ma — mówimy to wprost (`stanCelowania`), zamiast po cichu
// zachować się jak przy celu bez Elementu.
const GOAL_COMPONENT_COLUMN_CANDIDATES = Object.freeze([
  'component_id',
  'segment_component_id',
  'focus_component_id',
  'element_component_id',
]);

// ============================================================
// WARSTWA CZYSTA — zero I/O, w całości testowalna bez bazy
// ============================================================

// Dolna granica wieku z samego rocznika. null = nie wiemy (R5 pkt 3).
function computeAgeLowerBound(birthYear, now = new Date()) {
  if (birthYear == null || birthYear === '') return null;
  const yr = Number(birthYear);
  if (!Number.isFinite(yr)) return null;
  return now.getUTCFullYear() - yr - 1;
}

// Rozstrzyga, CZYM jest dana podpowiedź — to jest serce R5 punkt 2.
function classifyHint(hint, goalComponentId) {
  if (!hint) return 'niedopasowany';
  const hasComponent = hint.component_id != null;
  const hasNames = hint.obszar_name != null || hint.element_name != null;

  if (!hasComponent) {
    // Brak component_id: albo zamierzona reguła segmentowa, albo nieudane
    // dopasowanie nazwy. Rozróżniamy po tym, czy migracja zapisała nazwy.
    return hasNames ? 'niedopasowany' : 'segment';
  }
  if (goalComponentId != null && hint.component_id === goalComponentId) {
    return 'element_celu';
  }
  // Component jest, ale nie ten, o który chodzi. Poziom Obszaru
  // (element_name puste) jest nadal wartościowy dla całego Obszaru;
  // obcy Element — nie.
  return hint.element_name == null ? 'obszar' : 'inny_element';
}

function rankHint(hint, goalComponentId) {
  return CELOWANIE_RANK[classifyHint(hint, goalComponentId)];
}

// Bramka wiekowa (decyzja A9). NIGDY nie filtruje po cichu — zawsze
// zwraca, ile i dlaczego zniknęło.
function applyAgeGate(hints, ageLowerBound) {
  const wiekNieznany = ageLowerBound == null;
  const przepuszczone = [];
  let ukryteZPowoduWieku = 0;
  for (const h of hints) {
    if (h.min_age == null) { przepuszczone.push(h); continue; }
    if (wiekNieznany) { ukryteZPowoduWieku++; continue; }
    if (ageLowerBound >= Number(h.min_age)) przepuszczone.push(h);
    else ukryteZPowoduWieku++;
  }
  return { hints: przepuszczone, wiekNieznany, ukryteZPowoduWieku };
}

function isPlayerAudience(hint) {
  return PLAYER_AUDIENCES.includes(hint && hint.odbiorca);
}

// ------------------------------------------------------------
// DOROSŁY R11 08.08.2026 — „18+ = własny rodzic"
// ------------------------------------------------------------
// Routing `odbiorca='rodzic'` (W1 z audytu ograniczeń wiekowych) istnieje po
// to, żeby liczbowe dawki suplementów szły do osoby, która u NIELETNIEGO
// kupuje i pilnuje dawki. U zawodnika pełnoletniego tą osobą jest on sam —
// a dotąd nie widział tej warstwy wcale, bo dorosły amator nie ma konta
// rodzica. Dwie reguły, obie na DOLNEJ granicy wieku (ten sam konserwatyzm
// co bramka A9 — rocznik 2008 w 2026 daje dolną 17, warstwa wejdzie dopiero
// przy PEWNEJ pełnoletności; nieznany wiek NIGDY jej nie włącza):
//   1. wiersze `rodzic` WCHODZĄ do promptu zawodnika,
//   2. odesłania do rodzica (teksty systemowe decyzji A9, `zrodlo` zawiera
//      „decyzja A9") WYCHODZĄ — „ustal z rodzicem, on pilnuje dawki" jest
//      u dorosłego zdaniem fałszywym i stałoby w promptcie obok samej dawki.
// Bramka A9 (`applyAgeGate`) działa na wpuszczonych wierszach dalej, bez
// zmian. Lustrzana implementacja po stronie TS appki:
// `audienceAllowsPlayer` w `Asystent Gamechange/lib/componentHints.ts`.
const ADULT_MIN_AGE = 18;

function isAdultLowerBound(ageLowerBound) {
  return ageLowerBound != null && Number(ageLowerBound) >= ADULT_MIN_AGE;
}

function isParentReferralHint(hint) {
  return String((hint && hint.zrodlo) || '').toLowerCase().includes('decyzja a9');
}

// Filtr odbiorcy Z WIEKIEM. Nieletni i nieznany wiek: dokładnie dawne
// `isPlayerAudience` (bajt w bajt). Dorosły: dodatkowo `rodzic`.
function isAudienceForPlayer(hint, ageLowerBound) {
  if (isPlayerAudience(hint)) return true;
  return !!hint && hint.odbiorca === 'rodzic' && isAdultLowerBound(ageLowerBound);
}

// GŁÓWNA FUNKCJA CZYSTA. Wejście: surowe wiersze `component_hints`.
// Wyjście: lista gotowa do wstrzyknięcia + komplet jawnych stanów.
function selectHintsForPrompt({
  hints,
  goalComponentId = null,
  ageLowerBound = null,
  limit = HINT_LIMIT,
  includeOtherElements = false,
} = {}) {
  const wejscie = Array.isArray(hints) ? hints : [];

  // 1. Odbiorca — do promptu NIELETNIEGO nigdy nie idzie treść 'rodzic'.
  //    DOROSŁY R11: przy pewnej pełnoletności (dolna granica ≥18) wiersze
  //    'rodzic' wchodzą — zawodnik jest własnym rodzicem. Oba liczniki jawne.
  const dorosly = isAdultLowerBound(ageLowerBound);
  const poOdbiorcy = wejscie.filter((h) => isAudienceForPlayer(h, ageLowerBound));
  const odrzuconePrzezOdbiorce = wejscie.length - poOdbiorcy.length;
  const wlaczoneZWarstwyRodzica = dorosly
    ? poOdbiorcy.filter((h) => h && h.odbiorca === 'rodzic').length
    : 0;

  // 1b. DOROSŁY R11: odesłania „ustal z rodzicem" (teksty systemowe A9) są
  //     u dorosłego fałszywe i stałyby obok samej dawki — wychodzą, jawnie.
  const poOdeslaniach = dorosly
    ? poOdbiorcy.filter((h) => !isParentReferralHint(h))
    : poOdbiorcy;
  const pominieteOdeslaniaDoRodzica = poOdbiorcy.length - poOdeslaniach.length;

  // 2. Aktywność — `active=false` to wyłączona podpowiedź, nie brak danych.
  const poAktywnosci = poOdeslaniach.filter((h) => h.active !== false);
  const nieaktywne = poOdeslaniach.length - poAktywnosci.length;

  // 3. Bramka wiekowa (A9 + R5 pkt 3).
  const brama = applyAgeGate(poAktywnosci, ageLowerBound);

  // 4. Klasyfikacja i celowanie.
  const zRangami = brama.hints.map((h) => {
    const celowanie = classifyHint(h, goalComponentId);
    return { hint: h, celowanie, rank: CELOWANIE_RANK[celowanie] };
  });

  const niedopasowane = zRangami.filter((x) => x.celowanie === 'niedopasowany').length;
  const celowoSegmentowe = zRangami.filter((x) => x.celowanie === 'segment').length;
  const wycelowaneWCel = zRangami.filter((x) => x.celowanie === 'element_celu').length;

  const doSortu = includeOtherElements
    ? zRangami
    : zRangami.filter((x) => x.celowanie !== 'inny_element');
  const pominieteObceElementy = zRangami.length - doSortu.length;

  // 5. Sortowanie: najpierw celowanie, potem `pozycja` z materiału
  // (kolejność, w jakiej podpowiedzi występują w książce), potem klucz —
  // żeby wynik był deterministyczny także przy równych `pozycja`.
  doSortu.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const pa = a.hint.pozycja == null ? 9999 : Number(a.hint.pozycja);
    const pb = b.hint.pozycja == null ? 9999 : Number(b.hint.pozycja);
    if (pa !== pb) return pa - pb;
    return String(a.hint.klucz || '').localeCompare(String(b.hint.klucz || ''));
  });

  const efektywnyLimit = Number.isFinite(limit) && limit > 0 ? limit : HINT_LIMIT;
  const wybrane = doSortu.slice(0, efektywnyLimit);
  const przycieteLimitem = Math.max(0, doSortu.length - wybrane.length);

  return {
    hints: wybrane.map((x) => ({ ...x.hint, celowanie: x.celowanie })),
    stan: wybrane.length > 0 ? 'ok' : 'brak_podpowiedzi',
    // --- jawne stany "nie wiem" i "coś odpadło" (R5) ---
    wiekNieznany: brama.wiekNieznany,
    ukryteZPowoduWieku: brama.ukryteZPowoduWieku,
    niedopasowane,
    celowoSegmentowe,
    wycelowaneWCel,
    odrzuconePrzezOdbiorce,
    // DOROSŁY R11 — jawne liczniki routingu 18+:
    dorosly,
    wlaczoneZWarstwyRodzica,
    pominieteOdeslaniaDoRodzica,
    nieaktywne,
    pominieteObceElementy,
    przycieteLimitem,
    wszystkieWejsciowe: wejscie.length,
    limit: efektywnyLimit,
  };
}

// Jedna linia podpowiedzi w promptcie. Numer strony i nazwa materiału to
// dokładnie to, co odróżnia tę treść od ogólnej wiedzy modelu — dlatego
// są w KAŻDEJ linii, nie w nagłówku sekcji.
function formatHintLine(hint) {
  const rodzaj = hint.rodzaj === 'zrozumiec' ? 'zrozumieć' : 'zrobić';
  const material = hint.zrodlo || 'materiał Gamechange';
  const strony = hint.strony && hint.strony !== '—' ? `, s. ${hint.strony}` : '';
  const dowody = hint.dowody ? ` [materiał deklaruje: ${hint.dowody}]` : '';
  return `- (${hint.klucz}) [${rodzaj}] ${hint.hint} (${material}${strony})${dowody}`;
}

// Nazwana sekcja promptu — OBOK bazy wiedzy, nigdy zamiast niej.
// Pusty string, gdy nie ma czego wstrzyknąć: prompt wtedy wygląda
// dokładnie jak dziś, co do bajta.
function buildHintPromptBlock(selection) {
  if (!selection || !selection.hints || selection.hints.length === 0) return '';
  const linie = selection.hints.map(formatHintLine).join('\n');
  return [
    'PODPOWIEDZI Z MATERIAŁÓW GAMECHANGE (konkretne zdania wyciągnięte z materiałów autora, każde z numerem strony — to jest treść, której nie ma w Twojej ogólnej wiedzy, i to ona ma być podstawą rekomendacji):',
    linie,
    'JAK ICH UŻYĆ: oprzyj rekomendację na CO NAJMNIEJ JEDNEJ z powyższych podpowiedzi — najlepiej pierwszej, która pasuje do sytuacji zawodnika. Nie cytuj ich hurtem i nie wypisuj listy. Nie wymyślaj numerów stron ani tytułów materiałów, których nie ma powyżej. Jeśli żadna nie pasuje do danych zawodnika, powiedz to wprost zamiast naciągać.',
    '',
  ].join('\n');
}

// Wybór JEDNEJ podpowiedzi, którą rekomendacja poniesie ze sobą do zapisu
// i którą zawodnik zobaczy na ekranie (reguła R1).
//
// `uzytyKlucz` to `used_hint_klucz` z odpowiedzi AI — model mówi, na
// której podpowiedzi faktycznie oparł rekomendację. Gdy poda klucz z
// listy, bierzemy TEN. Gdy poda śmieci albo nic nie poda, bierzemy
// najlepiej wycelowaną. Dzięki temu to, co widzi zawodnik, zgadza się
// z tym, co model naprawdę wykorzystał — a przy milczeniu modelu i tak
// mamy co pokazać.
function pickShowcaseHint(selection, uzytyKlucz = null) {
  if (!selection || !selection.hints || selection.hints.length === 0) return null;
  const dopasowana = uzytyKlucz
    ? selection.hints.find((h) => h.klucz === uzytyKlucz)
    : null;
  const wybrana = dopasowana || selection.hints[0];
  return {
    wersja: 1,
    klucz: wybrana.klucz || null,
    tresc: wybrana.hint,
    material: wybrana.zrodlo || null,
    strona: wybrana.strony && wybrana.strony !== '—' ? String(wybrana.strony) : null,
    rodzaj: wybrana.rodzaj === 'zrozumiec' ? 'zrozumiec' : 'zrobic',
    celowanie: wybrana.celowanie || null,
    segment_id: wybrana.segment_id || null,
    component_id: wybrana.component_id == null ? null : wybrana.component_id,
    wybor: dopasowana ? 'wskazana_przez_ai' : 'najlepiej_wycelowana',
    wszystkie_w_promptcie: selection.hints.length,
  };
}

// Jedna linia do `console.log` — jawny stan, także (a właściwie zwłaszcza)
// gdy podpowiedzi nie było. Bez tego "cichy brak" wraca tylnymi drzwiami.
function describeHintState(selection, stanTabeli, stanCelowania) {
  const czesci = [`tabela=${stanTabeli}`];
  if (stanCelowania) czesci.push(`celowanie=${stanCelowania}`);
  if (!selection) return `[podpowiedzi] ${czesci.join(' ')} wynik=brak`;
  czesci.push(
    `wejscie=${selection.wszystkieWejsciowe}`,
    `wstrzykniete=${selection.hints.length}`,
    `wycelowane_w_cel=${selection.wycelowaneWCel}`,
    `segmentowe=${selection.celowoSegmentowe}`,
    `NIEDOPASOWANE=${selection.niedopasowane}`,
    `odrzucone_odbiorca=${selection.odrzuconePrzezOdbiorce}`,
    `przyciete_limitem=${selection.przycieteLimitem}`
  );
  if (selection.wiekNieznany) {
    czesci.push(`WIEK_NIEZNANY=tak ukryte_z_powodu_wieku=${selection.ukryteZPowoduWieku}`);
  } else if (selection.ukryteZPowoduWieku > 0) {
    czesci.push(`ukryte_z_powodu_wieku=${selection.ukryteZPowoduWieku}`);
  }
  // DOROSŁY R11 — jawny ślad routingu 18+ w każdym logu, w którym zadziałał.
  if (selection.dorosly) {
    czesci.push(`DOROSLY=tak wlaczone_z_warstwy_rodzica=${selection.wlaczoneZWarstwyRodzica}`
      + ` pominiete_odeslania=${selection.pominieteOdeslaniaDoRodzica}`);
  }
  return `[podpowiedzi] ${czesci.join(' ')}`;
}

// ============================================================
// WARSTWA I/O — cienka, wszystko powyżej działa bez niej
// ============================================================

// PostgREST/Postgres: tabela nie istnieje albo nie ma jej w cache schematu.
// To NIE jest awaria silnika — to stan "Kuba jeszcze nie wkleił migracji".
function isMissingTableError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST202') return true;
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('could not find the table')
    || msg.includes('schema cache');
}

// PostgREST: kolumna nie istnieje (przy INSERT z `source_hint`, zanim
// migracja doda kolumnę). Ten sam charakter co wyżej — brak, nie awaria.
function isMissingColumnError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === '42703' || code === 'PGRST204') return true;
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('could not find the') && msg.includes('column');
}

async function fetchComponentHints(supabase, { segmentId, componentId = null } = {}) {
  if (!segmentId) return { rows: [], stanTabeli: 'brak_segmentu' };
  let query = supabase
    .from('component_hints')
    .select('klucz, segment_id, component_id, obszar_name, element_name, hint, odbiorca, min_age, rodzaj, zrodlo, strony, dowody, pozycja, active')
    .eq('segment_id', segmentId)
    .eq('active', true);
  // To samo zawężenie co w propozycji 4.5 dokumentu podpowiedzi: obce
  // Elementy nie mają po co jechać przez sieć. Gdy Element celu jest
  // nieznany, bierzemy wszystko i sortujemy w warstwie czystej.
  //
  // Wartość wchodzi do składni `or()` PostgREST jako tekst, więc wpuszczamy
  // wyłącznie kształt uuid/liczby (przecinek albo nawias w wartości
  // rozwaliłby filtr i po cichu poszerzył wynik). Gdy kształt jest inny,
  // rezygnujemy z zawężenia w bazie — warstwa czysta i tak posortuje
  // i odfiltruje obce Elementy.
  const bezpiecznyId = componentId != null && /^[A-Za-z0-9_-]+$/.test(String(componentId));
  if (bezpiecznyId) {
    query = query.or(`component_id.eq.${componentId},component_id.is.null`);
  }
  const { data, error } = await query;
  if (error) {
    if (isMissingTableError(error)) return { rows: [], stanTabeli: 'brak_tabeli' };
    return { rows: [], stanTabeli: 'blad', blad: error.message };
  }
  return { rows: data || [], stanTabeli: 'ok' };
}

// Rocznik zawodnika. `users.birth_year` to jedyne, co appka zbiera.
async function fetchPlayerBirthYear(supabase, userId) {
  if (!userId) return { birthYear: null, stan: 'brak_uzytkownika' };
  const { data, error } = await supabase
    .from('users').select('birth_year').eq('id', userId).maybeSingle();
  if (error) return { birthYear: null, stan: 'blad', blad: error.message };
  if (!data) return { birthYear: null, stan: 'brak_wiersza' };
  return { birthYear: data.birth_year, stan: data.birth_year == null ? 'brak_rocznika' : 'ok' };
}

// Element Bloku Skupienia wybrany przy celu. Nazwa kolumny NIE jest
// potwierdzona na żywym schemacie — patrz komentarz przy
// GOAL_COMPONENT_COLUMN_CANDIDATES. Zwracany `stanCelowania` mówi wprost,
// czy celujemy w Element, czy tylko w segment i dlaczego.
async function fetchGoalComponentId(supabase, goalId) {
  if (!goalId) return { componentId: null, stanCelowania: 'brak_celu' };
  const { data, error } = await supabase
    .from('goals').select('*').eq('id', goalId).maybeSingle();
  if (error) return { componentId: null, stanCelowania: 'blad', blad: error.message };
  if (!data) return { componentId: null, stanCelowania: 'brak_wiersza' };
  for (const kol of GOAL_COMPONENT_COLUMN_CANDIDATES) {
    if (Object.prototype.hasOwnProperty.call(data, kol)) {
      return data[kol] == null
        ? { componentId: null, stanCelowania: 'cel_bez_elementu', kolumna: kol }
        : { componentId: data[kol], stanCelowania: 'ok', kolumna: kol };
    }
  }
  // Żadnej z kandydujących kolumn nie ma w schemacie — mówimy to wprost
  // zamiast udawać, że cel po prostu nie ma Elementu.
  return { componentId: null, stanCelowania: 'brak_kolumny_elementu' };
}

// Jedno wywołanie do użycia z silnika. Nigdy nie rzuca — brak podpowiedzi
// z jakiegokolwiek powodu ma zostawić silnik dokładnie w dzisiejszym
// zachowaniu, ale ZAWSZE z nazwanym stanem w wyniku.
async function loadHintsForRecommendation(supabase, {
  segmentId, userId, goalId = null, limit = HINT_LIMIT, now = new Date(),
} = {}) {
  const celowanie = await fetchGoalComponentId(supabase, goalId);
  const { rows, stanTabeli, blad } = await fetchComponentHints(supabase, {
    segmentId, componentId: celowanie.componentId,
  });
  const wiek = await fetchPlayerBirthYear(supabase, userId);
  const ageLowerBound = computeAgeLowerBound(wiek.birthYear, now);

  const selection = selectHintsForPrompt({
    hints: rows, goalComponentId: celowanie.componentId, ageLowerBound, limit,
  });

  return {
    selection,
    stanTabeli,
    blad: blad || null,
    stanCelowania: celowanie.stanCelowania,
    stanWieku: wiek.stan,
    ageLowerBound,
    log: describeHintState(selection, stanTabeli, celowanie.stanCelowania),
  };
}

module.exports = {
  HINT_LIMIT,
  PLAYER_AUDIENCES,
  CELOWANIE_RANK,
  GOAL_COMPONENT_COLUMN_CANDIDATES,
  // warstwa czysta
  computeAgeLowerBound,
  classifyHint,
  rankHint,
  applyAgeGate,
  isPlayerAudience,
  // DOROSŁY R11 — „18+ = własny rodzic"
  ADULT_MIN_AGE,
  isAdultLowerBound,
  isParentReferralHint,
  isAudienceForPlayer,
  selectHintsForPrompt,
  formatHintLine,
  buildHintPromptBlock,
  pickShowcaseHint,
  describeHintState,
  // warstwa I/O
  isMissingTableError,
  isMissingColumnError,
  fetchComponentHints,
  fetchPlayerBirthYear,
  fetchGoalComponentId,
  loadHintsForRecommendation,
};
