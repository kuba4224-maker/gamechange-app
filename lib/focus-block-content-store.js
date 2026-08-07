// ============================================================
// GAMECHANGE — lib/focus-block-content-store.js
// ============================================================
// PRAKTYKA A5 08.08.2026 — NOWY PLIK.
//
// PO CO TO JEST: Blok Skupienia ma cztery fazy. Faza 2 ("Praca") generuje
// dawkę treści edukacyjnej — konkretną porcję wiedzy pod sesję zawodnika —
// i ją GUBI. `api/generate-focus-block-content.js` zwraca `contentDose`
// z modelu, `api/cron-send-notifications.js` (rytm 6) wstawia wiersz do
// `focus_block_checkins` z SAMYM `question_text`, aktualizuje na
// `focus_blocks` dwa znaczniki kadencji (`last_content_dose_stage`,
// `last_content_dose_at`) — i treść dawki przepada. Audyt nazywa to
// "dawka generowana i gubiona" od bloku 1
// (`claude/MAPA_PRODUKTU.md`, sekcja 2, wiersz "Dawka treści": ❌ ulotna).
//
// Skutek jest podwójny:
//   1. Zawodnik nie może do dawki wrócić — nie ma jej gdzie przeczytać.
//   2. Płacimy modelowi za wygenerowanie tej samej rzeczy drugi raz,
//      bo jedyny sposób na "pokaż mi to jeszcze raz" to nowe wywołanie
//      Anthropic. Pomiar: sekcja 12 `claude/RAPORT_ZWROTNY_A_RUNDA_5.md`.
//
// Ten plik robi trzy rzeczy:
//   A. ZAPIS dawki do bazy (`focus_blocks.content_doses jsonb`).
//   B. ODCZYT dawki ZANIM zawołamy model — `checkContentDoseCadence()`
//      ma DOKŁADNIE ten sam kształt wyniku co `checkTrainingFocusCadence()`
//      w `api/generate-recommendation.js` ({ allowed, reason? }), bo to
//      dokładnie ta sama oszczędność: "już to mamy, nie generuj drugi raz".
//   C. PODPOWIEDZI Z MATERIAŁÓW dla promptu fazy 2 —
//      `loadHintsForFocusBlock()`, zbudowane w całości z funkcji
//      wyeksportowanych przez `lib/recommendation-hints.js` (runda 4).
//      Tamten plik NIE JEST tu zmieniany ani o jedną linię.
//
// ------------------------------------------------------------
// DLACZEGO KOLUMNA NA ISTNIEJĄCEJ TABELI, A NIE NOWA TABELA
// ------------------------------------------------------------
// Sprawdzone przed zaproponowaniem czegokolwiek (tak samo jak w rundzie 4
// przy `decision_recommendations`, znalezisko A21). Trzej kandydaci:
//
//   1. `focus_block_checkins` — semantycznie najbliższy dom (dawka należy
//      do konkretnego pytania kontrolnego). ODRZUCONY: wiersz w tej tabeli
//      wstawia `api/cron-send-notifications.js` (pas C), i to DOPIERO PO
//      wywołaniu `generateCheckin()`. W chwili, gdy dawka powstaje, ten
//      wiersz jeszcze nie istnieje — nie ma do czego jej dopiąć bez
//      zmiany pliku spoza mojego pasa. Zostawiam to jako świadomą
//      propozycję na przyszłość, nie jako cichy brak (raport, sekcja 8).
//
//   2. `focus_blocks` — WYBRANY. Kolumna siada dokładnie obok dwóch
//      znaczników, które już dziś istnieją WYŁĄCZNIE po to, żeby pilnować
//      kadencji dawki (`last_content_dose_stage`, `last_content_dose_at`,
//      migracja SQL #3 z 31.07.2026). `generateCheckin()` ma ten wiersz
//      w ręku, zanim zawoła model — więc zapis i odczyt mieszczą się
//      w całości w moim pasie, bez ani jednej zmiany w `api/cron-*`.
//      RLS jest już na miejscu: zawodnik czyta własne `focus_blocks`
//      (polityka `focus_blocks_owner`), trener przez
//      `focus_blocks_coach_select` (`INTEGRACJA_PETLA_TRENERA_SQL.md`).
//      Nowa tabela wymagałaby nowych polityk — a polityka, o której się
//      zapomni, to dokładnie ten sam "cichy brak" (patrz: brak polityki
//      SELECT na `component_hints`, punkt 5 listy dla Kuby po bloku 4).
//
//   3. Nowa tabela `focus_block_content_doses` — ODRZUCONA jako pierwsza
//      wersja. Wygrywa dopiero wtedy, gdy dawek na blok będzie DUŻO
//      (setki) albo gdy zaczniemy je wyszukiwać po treści. Dziś Blok trwa
//      4–8 tygodni, a dawka wypada przy zmianie etapu albo co 14 dni —
//      czyli realnie 2–6 dawek na blok. Na to tabela jest przerostem.
//
// KSZTAŁT KOLUMNY: `jsonb` z `wersja: 1`, tym samym wzorcem co `source_hint`
// z rundy 4 (decyzja sesji głównej z 08.08.2026: "worek z wersją zamiast
// kolumny na każdą rzecz"). Koperta trzyma LISTĘ dawek, nie jedną —
// zawodnik ma móc wrócić także do dawki sprzed zmiany etapu.
//
// ⚠️ OGRANICZENIE O1: `gamechange-app/api/` ma 12 z 12 plików (twardy limit
// Vercel Hobby). Cała ta logika MUSI mieszkać w `lib/`. To nie jest
// preferencja stylu — trzynasty plik w `api/` blokuje deploy całego repo.
//
// ⚠️ ZASADA R5 (jawny stan "nie wiem"): każda funkcja I/O niżej zwraca
// NAZWANY stan zamiast pustki. Kolumny może jeszcze nie być (Kuba nie
// wkleił migracji), koperta może być z przyszłej wersji, dawki może nie
// być — to trzy różne rzeczy i mają trzy różne nazwy, nigdy jedno ciche
// `null`.
// ============================================================

const {
  // warstwa czysta z rundy 4 — reużyta bez zmian
  computeAgeLowerBound,
  selectHintsForPrompt,
  buildHintPromptBlock,
  pickShowcaseHint,
  describeHintState,
  // warstwa I/O z rundy 4 — reużyta bez zmian
  isMissingColumnError,
  fetchComponentHints,
  fetchPlayerBirthYear,
  HINT_LIMIT,
} = require('./recommendation-hints');

// Wersja koperty. Rośnie, gdy zmieni się kształt — pas B ma to czytać
// i przy `wersja > 1` sprawdzić kontrakt zamiast zgadywać.
const CONTENT_DOSE_VERSION = 1;

// Ta sama liczba, co warunek `daysSinceLastDose >= 14` wpisany dziś wprost
// w `generateCheckin()`. Trzymana tutaj jako STAŁA, żeby dało się ją
// zmienić w jednym miejscu — wartość i zachowanie bez zmian.
const CONTENT_DOSE_CADENCE_DAYS = 14;

// Ile dawek trzymamy w kopercie. Blok trwa 4–8 tygodni, dawka wypada przy
// zmianie etapu albo co 14 dni — realnie 2–6 sztuk. 12 to zapas z górką
// i twarda gwarancja, że wiersz `focus_blocks` nie puchnie bez końca.
const MAX_STORED_DOSES = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================
// A. WARSTWA CZYSTA — zero I/O, w całości testowalna bez bazy
// ============================================================

// Pusta koperta. Jeden kształt dla "kolumny nie ma", "kolumna jest ale
// NULL" i "koperta jest uszkodzona" — RÓŻNICĘ niesie `stan`, nie kształt.
function emptyEnvelope() {
  return { wersja: CONTENT_DOSE_VERSION, dawki: [] };
}

// Czyta surową zawartość kolumny i mówi WPROST, co zastał.
// `stan`: 'ok' | 'pusta' | 'nieznana_wersja' | 'uszkodzona'
function readDoseEnvelope(raw) {
  if (raw == null) return { envelope: emptyEnvelope(), stan: 'pusta' };

  let obj = raw;
  if (typeof raw === 'string') {
    // PostgREST oddaje jsonb jako obiekt, ale niektóre klienty/atrapy
    // podają tekst. Nie zakładamy — próbujemy i mówimy, gdy się nie da.
    try { obj = JSON.parse(raw); } catch (e) {
      return { envelope: emptyEnvelope(), stan: 'uszkodzona', blad: e.message };
    }
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.dawki)) {
    return { envelope: emptyEnvelope(), stan: 'uszkodzona' };
  }
  const wersja = Number(obj.wersja);
  if (!Number.isFinite(wersja) || wersja > CONTENT_DOSE_VERSION) {
    // Koperta z NOWSZEJ wersji niż ta, którą ten kod rozumie. Nie
    // nadpisujemy jej i nie udajemy, że jest pusta — mówimy to wprost.
    return { envelope: { wersja: obj.wersja, dawki: obj.dawki }, stan: 'nieznana_wersja' };
  }
  return { envelope: { wersja, dawki: obj.dawki }, stan: 'ok' };
}

// Deterministyczny klucz dawki. Zero `Math.random()`, zero `Date.now()`
// w środku — czas wchodzi parametrem, żeby test dawał ten sam wynik
// przy każdym uruchomieniu.
function buildDoseKey(focusBlockId, stage, now) {
  const dzien = new Date(now).toISOString().slice(0, 10);
  return `${focusBlockId}:e${stage == null ? 'brak' : stage}:${dzien}`;
}

// Zamienia surową odpowiedź modelu (`{practicalStep, forCurious}`) na
// wiersz koperty. Nazwy pól po polsku, tak jak `source_hint` z rundy 4 —
// jeden język w warstwie danych, którą czyta pas B.
//
// Zwraca `null`, gdy nie ma czego zapisać — dawka bez `practicalStep` to
// nie jest dawka. Nigdy nie zapisujemy pustej skorupy.
function normalizeDose(raw, {
  focusBlockId, stage = null, segmentId = null, componentId = null,
  sourceHint = null, now = new Date(),
} = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const krok = typeof raw.practicalStep === 'string' ? raw.practicalStep.trim() : '';
  if (!krok) return null;
  const chetni = typeof raw.forCurious === 'string' && raw.forCurious.trim()
    ? raw.forCurious.trim()
    : null;

  return {
    wersja: CONTENT_DOSE_VERSION,
    klucz: buildDoseKey(focusBlockId, stage, now),
    etap: stage == null ? null : stage,
    wygenerowano_at: new Date(now).toISOString(),
    krok_praktyczny: krok,
    dla_chetnych: chetni,
    segment_id: segmentId,
    component_id: componentId == null ? null : componentId,
    // Ten sam kształt co `decision_recommendations.source_hint` z rundy 4
    // (sekcja 11 tamtego raportu). Pas B ma już ekran, który to renderuje
    // — świadomie nie wymyślam drugiego kształtu na to samo.
    zrodlo_podpowiedzi: sourceHint || null,
  };
}

// Dawka dla TEGO etapu, najnowsza. `null`, gdy nie ma.
function findDoseForStage(envelope, stage) {
  if (!envelope || !Array.isArray(envelope.dawki)) return null;
  const pasujace = envelope.dawki.filter((d) => d && d.etap === (stage == null ? null : stage));
  if (pasujace.length === 0) return null;
  return pasujace.reduce((a, b) => (
    new Date(a.wygenerowano_at || 0).getTime() >= new Date(b.wygenerowano_at || 0).getTime() ? a : b
  ));
}

// Najnowsza dawka w ogóle, niezależnie od etapu. To jest to, co zawodnik
// ma zobaczyć, gdy wraca do Bloku "pokaż mi tamto jeszcze raz".
function findLatestDose(envelope) {
  if (!envelope || !Array.isArray(envelope.dawki) || envelope.dawki.length === 0) return null;
  return envelope.dawki.reduce((a, b) => (
    new Date(a.wygenerowano_at || 0).getTime() >= new Date(b.wygenerowano_at || 0).getTime() ? a : b
  ));
}

// ------------------------------------------------------------
// SERCE TEJ RUNDY — ten sam wzorzec co checkTrainingFocusCadence()
// w api/generate-recommendation.js (l. 320–337, odczytane 08.08.2026):
//
//   async function checkTrainingFocusCadence(supabase, userId) {
//     ...szuka wiersza z ostatnich 24h...
//     if (data && data.length > 0) return { allowed: false, reason: '...' };
//     return { allowed: true };
//   }
//
// Ten sam kontrakt wyniku ({ allowed, reason? }), to samo znaczenie
// `allowed: false` = "NIE wołaj modelu, mamy to już". Różnica jedna:
// tam blokada kończy pracę, tutaj oddaje jeszcze `dawka` — bo mamy co
// pokazać zamiast generowania. To jest cała oszczędność w złotówkach.
//
// ⚠️ FUNKCJA CZYSTA, nie I/O — w odróżnieniu od pierwowzoru bierze już
// pobraną kopertę zamiast wołać bazę. Powód: `generateCheckin()` i tak
// czyta `focus_blocks` jednym zapytaniem (`fetchFocusBlock`), więc
// drugie zapytanie byłoby marnowanym round-tripem. Testowalne bez atrapy.
// ------------------------------------------------------------
function checkContentDoseCadence({
  envelope, stage, now = new Date(), cadenceDays = CONTENT_DOSE_CADENCE_DAYS,
} = {}) {
  const dawka = findDoseForStage(envelope, stage);
  if (!dawka) {
    return { allowed: true, reason: 'brak_dawki_dla_etapu' };
  }
  const wiekDni = (new Date(now).getTime() - new Date(dawka.wygenerowano_at || 0).getTime()) / DAY_MS;
  if (!Number.isFinite(wiekDni) || wiekDni >= cadenceDays) {
    return { allowed: true, reason: 'dawka_przeterminowana', wiekDni };
  }
  return {
    allowed: false,
    reason: `Dawka dla etapu ${stage} istnieje od ${Math.floor(wiekDni)} dni (próg: ${cadenceDays}) — odczytana z magazynu zamiast wygenerowana.`,
    dawka,
    wiekDni,
  };
}

// Dokłada dawkę do koperty. Idempotentna po `klucz` — dwa przebiegi crona
// tego samego dnia dla tego samego etapu NIE zrobią dwóch wpisów.
// Przycina do MAX_STORED_DOSES, najstarsze wypadają.
function appendDose(envelope, dose, max = MAX_STORED_DOSES) {
  const baza = envelope && Array.isArray(envelope.dawki) ? envelope.dawki : [];
  if (!dose) return { wersja: CONTENT_DOSE_VERSION, dawki: baza };
  const bezDuplikatu = baza.filter((d) => d && d.klucz !== dose.klucz);
  const wszystkie = [dose, ...bezDuplikatu].sort((a, b) => (
    new Date(b.wygenerowano_at || 0).getTime() - new Date(a.wygenerowano_at || 0).getTime()
  ));
  return { wersja: CONTENT_DOSE_VERSION, dawki: wszystkie.slice(0, max) };
}

// Jedna linia do `console.log`. Jawny stan także — a właściwie zwłaszcza —
// gdy nic się nie stało. Bez tego "cichy brak" wraca tylnymi drzwiami.
function describeDoseState({ stanKolumny, stanKoperty, kadencja, zapis, liczbaDawek } = {}) {
  const czesci = [`kolumna=${stanKolumny || 'nieznany'}`, `koperta=${stanKoperty || 'nieznany'}`];
  if (typeof liczbaDawek === 'number') czesci.push(`dawek_w_magazynie=${liczbaDawek}`);
  if (kadencja) {
    czesci.push(kadencja.allowed ? `generujemy=tak (${kadencja.reason})` : 'generujemy=nie ODCZYT_Z_MAGAZYNU');
  }
  if (zapis) czesci.push(`zapis=${zapis}`);
  return `[dawka] ${czesci.join(' ')}`;
}

// ============================================================
// B. WARSTWA I/O — cienka, wszystko powyżej działa bez niej
// ============================================================

// Odczyt koperty z `focus_blocks.content_doses`.
//
// `stanKolumny`: 'ok' | 'brak_kolumny' | 'brak_wiersza' | 'blad'
//
// NIGDY nie rzuca. Brak kolumny (Kuba jeszcze nie wkleił migracji) to NIE
// jest awaria — to stan, w którym Blok Skupienia ma się zachować dokładnie
// tak jak dziś, co do bajta, i powiedzieć o tym jedną linią w logu.
async function fetchDoseEnvelope(supabase, focusBlockId) {
  if (!focusBlockId) {
    return { envelope: emptyEnvelope(), stanKolumny: 'brak_bloku', stanKoperty: 'pusta' };
  }
  const { data, error } = await supabase
    .from('focus_blocks')
    .select('content_doses')
    .eq('id', focusBlockId)
    .maybeSingle();

  if (error) {
    if (isMissingColumnError(error)) {
      return { envelope: emptyEnvelope(), stanKolumny: 'brak_kolumny', stanKoperty: 'pusta' };
    }
    return {
      envelope: emptyEnvelope(), stanKolumny: 'blad', stanKoperty: 'pusta', blad: error.message,
    };
  }
  if (!data) {
    return { envelope: emptyEnvelope(), stanKolumny: 'brak_wiersza', stanKoperty: 'pusta' };
  }
  const odczyt = readDoseEnvelope(data.content_doses);
  return { envelope: odczyt.envelope, stanKolumny: 'ok', stanKoperty: odczyt.stan, blad: odczyt.blad || null };
}

// Zapis dawki. Read-modify-write na kopercie — czyta aktualną, dokłada,
// odsyła całość.
//
// ⚠️ ŚWIADOMY WYBÓR: to NIE jest atomowe. Dwa równoległe przebiegi crona
// dla tego samego bloku mogłyby sobie nadpisać kopertę. Uznane za
// akceptowalne, bo: (a) `vercel.json` ma jeden wpis crona dla tego rytmu,
// (b) rytm 6 ma bramkę godzinową (`FOCUS_BLOCK_CHECKIN_WINDOW_HOUR`) i
// 14-dniowy odstęp na blok, (c) najgorszy skutek to zgubiona JEDNA dawka
// w wyścigu, czyli dzisiejsze zachowanie. Atomowość wymagałaby funkcji
// SQL (`jsonb_set` po stronie bazy) — do rozważenia, jeśli kiedyś ten
// rytm zacznie chodzić częściej. Odnotowane, nie przemilczane.
//
// `stan`: 'zapisano' | 'brak_kolumny' | 'nic_do_zapisania' | 'nieznana_wersja' | 'blad'
async function saveContentDose(supabase, { focusBlockId, dose, max = MAX_STORED_DOSES } = {}) {
  if (!dose) return { stan: 'nic_do_zapisania' };
  if (!focusBlockId) return { stan: 'blad', blad: 'saveContentDose: brak focusBlockId.' };

  const biezaca = await fetchDoseEnvelope(supabase, focusBlockId);
  if (biezaca.stanKolumny === 'brak_kolumny') {
    // Ścieżka odzysku, ten sam wzorzec co przy `source_hint` w rundzie 4:
    // nie wywracamy pytania kontrolnego z powodu braku migracji, ale
    // mówimy WPROST, że zawodnik dawki nie zobaczy.
    console.warn('[dawka] kolumna focus_blocks.content_doses NIE ISTNIEJE — dawka wygenerowana i ZGUBIONA, dokładnie jak przed tą rundą. Zawodnik jej NIE zobaczy i zapłacimy za nią drugi raz, dopóki migracja nie zostanie wklejona (RAPORT_ZWROTNY_A_RUNDA_5.md, sekcja 7).');
    return { stan: 'brak_kolumny' };
  }
  if (biezaca.stanKoperty === 'nieznana_wersja') {
    // Koperta z nowszej wersji — NIE nadpisujemy jej naszym kształtem.
    console.warn(`[dawka] koperta content_doses ma wersję ${biezaca.envelope.wersja}, ten kod rozumie ${CONTENT_DOSE_VERSION} — zapis pominięty, żeby nie zniszczyć nowszych danych.`);
    return { stan: 'nieznana_wersja' };
  }

  const nowa = appendDose(biezaca.envelope, dose, max);
  const { error } = await supabase
    .from('focus_blocks')
    .update({ content_doses: nowa })
    .eq('id', focusBlockId);

  if (error) {
    if (isMissingColumnError(error)) {
      console.warn('[dawka] UPDATE odrzucony — brak kolumny focus_blocks.content_doses. Dawka zgubiona, migracja czeka.');
      return { stan: 'brak_kolumny' };
    }
    console.error('[dawka] błąd zapisu content_doses:', error.message);
    return { stan: 'blad', blad: error.message };
  }
  return { stan: 'zapisano', liczbaDawek: nowa.dawki.length };
}

// Czysty ODCZYT dla appki — zero wywołań modelu, zero kosztu.
// To jest ta funkcja, dzięki której "pokaż mi tę dawkę jeszcze raz"
// przestaje kosztować cokolwiek.
//
// `stage` opcjonalny: podany — dawka dla tego etapu; pominięty —
// najnowsza w ogóle.
async function getDoseForBlock(supabase, focusBlockId, { stage } = {}) {
  const odczyt = await fetchDoseEnvelope(supabase, focusBlockId);
  const dawka = stage === undefined
    ? findLatestDose(odczyt.envelope)
    : findDoseForStage(odczyt.envelope, stage);
  return {
    dawka: dawka || null,
    wszystkie: Array.isArray(odczyt.envelope.dawki) ? odczyt.envelope.dawki : [],
    stanKolumny: odczyt.stanKolumny,
    stanKoperty: odczyt.stanKoperty,
    log: describeDoseState({
      stanKolumny: odczyt.stanKolumny,
      stanKoperty: odczyt.stanKoperty,
      liczbaDawek: (odczyt.envelope.dawki || []).length,
    }),
  };
}

// ============================================================
// C. PODPOWIEDZI Z MATERIAŁÓW DLA BLOKU SKUPIENIA
// ============================================================
// `lib/recommendation-hints.js` (runda 4) jest tu reużyty BEZ ANI JEDNEJ
// ZMIANY — importowany wyżej, nie edytowany.
//
// ⚠️ DLACZEGO NIE `loadHintsForRecommendation()` WPROST (odstąpienie od
// polecenia, uzasadnione — raport, sekcja 5):
// tamta funkcja przyjmuje `goalId` i sama wyprowadza z niego Element,
// czytając `goals`. Blok Skupienia nie ma `goal_id` (sprawdzone na
// `fetchFocusBlock` — kolumny to id, user_id, segment_id, component_id,
// custom_description, pillar, status, stage, sessions_per_week,
// target_weeks, started_at, closed_at, last_content_dose_stage,
// last_content_dose_at), a `goals` do dziś NIE ZAPISUJE wybranego Elementu
// (znalezisko A22 z rundy 4, potwierdzone przez sesję główną odczytem
// `information_schema`; naprawa to pozycja M1, pas B, runda 5).
//
// Blok Skupienia ma za to `focus_blocks.component_id` — konkretny Element,
// zapisany, żywy. Przejście przez `goals` ODEBRAŁOBY tę przewagę i
// sprowadziło celowanie z powrotem do segmentu, czyli dokładnie
// unieważniło powód, dla którego to zadanie w ogóle istnieje: to tutaj po
// raz pierwszy zadziała 63 podpowiedzi przypiętych do Elementu, które
// w rundzie 4 nie miały jak trafić do zawodnika (znalezisko B24).
//
// Dlatego składam to samo, co robi `loadHintsForRecommendation()`,
// z tych samych, wyeksportowanych klocków — biorąc `componentId` wprost.
// Jedna różnica w kroku pobrania Elementu, zero różnic w filtrach:
// bramka wiekowa A9, filtr odbiorcy, sortowanie po celowaniu i limit 12
// to TE SAME funkcje, nie kopie.
async function loadHintsForFocusBlock(supabase, {
  segmentId, componentId = null, userId, limit = HINT_LIMIT, now = new Date(),
} = {}) {
  const { rows, stanTabeli, blad } = await fetchComponentHints(supabase, { segmentId, componentId });
  const wiek = await fetchPlayerBirthYear(supabase, userId);
  const ageLowerBound = computeAgeLowerBound(wiek.birthYear, now);

  const selection = selectHintsForPrompt({
    hints: rows,
    goalComponentId: componentId,
    ageLowerBound,
    limit,
  });

  // `stanCelowania` mówi WPROST, skąd wziął się Element — inaczej niż
  // w rundzie 4, gdzie mógł być 'brak_kolumny_elementu'. Tutaj kolumna
  // istnieje na pewno (czyta ją `fetchFocusBlock`), więc stany są dwa.
  const stanCelowania = componentId == null ? 'blok_bez_elementu' : 'element_bloku';

  return {
    selection,
    stanTabeli,
    blad: blad || null,
    stanCelowania,
    stanWieku: wiek.stan,
    ageLowerBound,
    log: describeHintState(selection, stanTabeli, stanCelowania),
  };
}

module.exports = {
  CONTENT_DOSE_VERSION,
  CONTENT_DOSE_CADENCE_DAYS,
  MAX_STORED_DOSES,
  // warstwa czysta
  emptyEnvelope,
  readDoseEnvelope,
  buildDoseKey,
  normalizeDose,
  findDoseForStage,
  findLatestDose,
  checkContentDoseCadence,
  appendDose,
  describeDoseState,
  // warstwa I/O
  fetchDoseEnvelope,
  saveContentDose,
  getDoseForBlock,
  // podpowiedzi
  loadHintsForFocusBlock,
  // reeksport, żeby konsument nie musiał importować dwóch plików
  buildHintPromptBlock,
  pickShowcaseHint,
};
