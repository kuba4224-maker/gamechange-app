// ============================================================
// GAMECHANGE — /api/generate-focus-block-dosing.js
// ============================================================
// NOWY PLIK (31.07.2026) — Tor 7, Krok 5a (Blok Skupienia — Start).
// Punkt startowy: claude/SESJA_START_UX_MOBILE_BLOK_SKUPIENIA.md.
//
// CO TEN PLIK ROBI:
// Zawodnik w appce mobilnej (app/(tabs)/cele.tsx), po wybraniu Elementu
// (albo wolnego opisu) do zaplanowania jako Blok Skupienia, podaje ile
// razy w tygodniu realistycznie może na to poświęcić czas. Ten endpoint
// generuje sugestię dozowania (dni tygodnia, czas trwania, liczba tygodni)
// na bazie: sygnałów gotowości (jak Centrum Decyzji), dostępu do sprzętu
// (Profil), i baz wiedzy Domeny 17 dla wybranego segmentu.
//
// KROK 0 tej sesji (zweryfikowane żywym zapytaniem do Supabase, nie z
// dokumentacji — patrz PLAN_ORKIESTRACJI_WIELOSESYJNEJ.md dla pełnej
// listy incydentów tego typu w projekcie):
// 1. Silnik sygnałów gotowości NIE jest w recommendation_engine.js (ten
//    plik to wyłącznie mapowanie segment→kategoria specjalisty Marketplace)
//    — jest w generate-recommendation.js (computeReadinessSignals/
//    buildReadinessNarrative/fetchReadinessWindowLogs). Skopiowane stąd
//    1:1 poniżej (ta sama, świadoma duplikacja co SEG_NAMES w całym
//    projekcie — utrzymanie małej logiki w dwóch miejscach jest tańsze
//    niż sprzęganie dwóch osobnych plików/wdrożeń).
// 2. calendar_events.recurrence_rule to JEDEN wiersz = wzorzec BEZ KOŃCA
//    (constraint chk_recurrence_xor_date wymusza dokładnie jedno z
//    recurrence_rule/scheduled_date, bez pola "liczba wystąpień"). Blok
//    Skupienia potrzebuje ograniczonej liczby sesji (target_weeks
//    tygodni) — appka mobilna (nie ten endpoint) tworzy więc
//    sessions_per_week × target_weeks OSOBNYCH wierszy ze scheduled_date,
//    nie jeden wiersz z recurrence_rule. Ten endpoint tylko sugeruje
//    liczby, nie zapisuje nic do kalendarza.
// 3. segment_components.id to TEXT, nie uuid — migracja focus_blocks
//    (component_id) użyła poprawnego typu (patrz komentarz w migracji).
//
// WZOROWANY na generate-recommendation.js (dostęp do Supabase przez
// service role, bo trzeba czytać daily_logs/player_profiles innego
// użytkownika) I na validate-goal-refinement.js (wywoływany bezpośrednio
// z appki, bez DECISION_ENGINE_SECRET — ten sam, już zaakceptowany w tym
// projekcie wzorzec "trust boundary" co tamten endpoint).
//
// CO ŚWIADOMIE NIE JEST TU ZROBIONE:
// - Zapis do bazy (ani focus_blocks, ani calendar_events) — appka mobilna
//   robi to sama PO zatwierdzeniu sugestii przez zawodnika (patrz UI w
//   cele.tsx). Ten endpoint jest czystą funkcją sugestii.
// - Egzekwowanie limitu "jeden aktywny Blok na filar" — to robi baza
//   (unique index w migracji) + UI appki PRZED wywołaniem tego endpointu.
// - Kontrola kosztów / rate-limiting — od rundy 13 CZĘŚCIOWO ZROBIONA:
//   patrz sekcja "LIMIT R13" niżej (M24/A35). Świadomie best-effort.
//
// ------------------------------------------------------------
// DOZOWANIE A6 08.08.2026 — FAZA 1 WIDZI PODPOWIEDZI Z MATERIAŁÓW
// ------------------------------------------------------------
// PROBLEM, KTÓRY TO ZAMYKA: ten endpoint decyduje o DOZOWANIU — ile dni
// w tygodniu, ile minut, ile tygodni — a do dziś nie widział ani jednego
// zdania z materiałów Kuby. Tymczasem `component_hints` (214 podpowiedzi
// z 152 stron, migracja rundy 3) zawiera zdania, które są DOKŁADNIE o tym,
// co ten endpoint rozstrzyga, w tym oznaczone w materiale jako REGUŁY
// BEZWZGLĘDNE:
//
//   moc-segment-01 · "Między sesjami zostaw minimum 48 godzin przerwy,
//   szczególnie po plyometrii. Mecz powinien być co najmniej 48 godzin po
//   sesji plyometrycznej." · dowody: "materiał podaje jako regułę bezwzględną"
//
//   moc-segment-02 · "Tygodnie 1–2 to adaptacja: 1–2 sesje… Od tygodnia 3
//   do 6: 2–3 sesje…" — wprost o `weeks` i `sessionsPerWeek`.
//
// Bez tego model mógł zaproponować MON/TUE/WED dla segmentu `moc` i nikt
// by się nie dowiedział, że właśnie złamał regułę z materiału, na którym
// stoi cały system. Propozycja pochodzi z sekcji 8.5
// `claude/RAPORT_ZWROTNY_A_RUNDA_5.md` (moja własna z rundy 5).
//
// JAK: `loadHintsForFocusBlock()` z `lib/focus-block-content-store.js` —
// TA SAMA funkcja, której używa faza 2 (runda 5). Ani jednej kopii reguł:
// bramka wiekowa A9, filtr odbiorcy, sortowanie po celowaniu i limit 12
// mieszkają w `lib/recommendation-hints.js` (runda 4) i są tu wyłącznie
// IMPORTOWANE. Żaden z tych dwóch plików nie jest w tej rundzie zmieniany
// ani o linię — są wspólnym źródłem reguł dla TRZECH konsumentów (silnik
// rekomendacji, faza 2 Bloku, faza 1 Bloku) i zmiana tutaj wymagałaby
// ponownego dowodu w dwóch pozostałych.
//
// CZEGO TA ZMIANA NIE RUSZA (kontrakt odpowiedzi — pas B ma ekran planera,
// który go czyta): `ok`, `suggestion.{sessionsPerWeek,days,durationMinutes,
// weeks,reasoning}` i `pillar` znaczą DOKŁADNIE to samo co wczoraj i mają
// dokładnie ten sam kształt. Wszystko nowe jedzie w NOWYCH polach
// najwyższego poziomu (`sourceHint`, `podpowiedzi`, `rytm`), które
// dzisiejszy konsument po prostu ignoruje. To ten sam wzorzec, który
// w rundzie 5 pozwolił `test-cron-send-notifications.js` przejść 60/60 bez
// jednej modyfikacji.
//
// ⚠️ ŚCIEŻKA BEZ PODPOWIEDZI JEST IDENTYCZNA CO DO ZNAKU ze stanem sprzed
// tej rundy — brak tabeli `component_hints`, brak segmentu, nic nie
// przeszło filtrów: prompt wychodzi bajt w bajt dzisiejszy. Zmierzone
// programowo, scenariusze w `tests/test-generate-focus-block-dosing.js`,
// grupa 12.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

// DOZOWANIE A6 08.08.2026 — jeden import, trzy funkcje. `lib/focus-block-
// content-store.js` reeksportuje `buildHintPromptBlock`/`pickShowcaseHint`
// z `lib/recommendation-hints.js` właśnie po to, żeby konsument nie musiał
// importować dwóch plików (patrz komentarz przy jego `module.exports`).
const {
  loadHintsForFocusBlock,
  buildHintPromptBlock,
  pickShowcaseHint,
} = require('../lib/focus-block-content-store.js');

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych.');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ------------------------------------------------------------
// FILARY — świadoma duplikacja SEGMENTS_BY_PILLAR z app/(tabs)/cele.tsx
// (ten sam wzorzec i uzasadnienie co SEG_NAMES w całym projekcie).
// Jeśli kiedyś podział filar→segment w cele.tsx się zmieni, pamiętać o
// ręcznej synchronizacji tutaj.
// ------------------------------------------------------------
const SEGMENTS_BY_PILLAR = [
  ['Filar 1 — Dominacja fizyczna', ['moc', 'wytrzymalosc', 'fizycznosc']],
  ['Filar 2 — Efektywność techniczna', ['techFund', 'techSpec']],
  ['Filar 3 — Trwałość organizmu', ['tolerancja', 'regeneracja', 'odpornosc', 'odzywianie']],
  ['Filar 4 — Mentalność', ['koncentracja', 'mental']],
  ['Filar 5 — Boiskowa mądrość', ['percepcja', 'decyzja']],
];
const SEG_PILLAR = Object.fromEntries(
  SEGMENTS_BY_PILLAR.flatMap(([pillar, segs]) => segs.map((id) => [id, pillar]))
);
const SEG_NAMES = {
  moc: 'MOC',
  wytrzymalosc: 'WYTRZYMAŁOŚĆ',
  fizycznosc: 'FIZYCZNOŚĆ',
  techFund: 'TECHNIKA FUND.',
  techSpec: 'TECHNIKA SPEC.',
  regeneracja: 'REGENERACJA',
  odpornosc: 'ODPORNOŚĆ',
  odzywianie: 'ODŻYWIENIE',
  tolerancja: 'TOL. OBCIĄŻEŃ',
  koncentracja: 'KONCENTRACJA',
  mental: 'ODWAGA W GRZE',
  percepcja: 'PERCEPCJA',
  decyzja: 'SZYBK. DECYZJI',
};

function resolvePillar(segmentId) {
  return SEG_PILLAR[segmentId] || null;
}

// ------------------------------------------------------------
// GOTOWOŚĆ — skopiowane 1:1 z generate-recommendation.js
// (computeReadinessSignals/buildReadinessNarrative/fetchReadinessWindowLogs)
// — patrz nagłówek pliku, punkt 1 Kroku 0. Bez zmian logiki, żeby "top
// deficyt"/"zmęczenie" znaczyło to samo w obu miejscach systemu.
// ------------------------------------------------------------
const READINESS_WINDOW_DAYS = 30;
const BASELINE_MIN_MORNING_ENTRIES = 14;
const BASELINE_WINDOW_DAYS = 21;
const DAY_MS = 24 * 60 * 60 * 1000;

async function fetchReadinessWindowLogs(supabase, userId) {
  const since = new Date(Date.now() - READINESS_WINDOW_DAYS * DAY_MS).toISOString();
  const { data, error } = await supabase
    .from('daily_logs')
    .select('entry_type, payload, created_at')
    .eq('user_id', userId)
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`fetchReadinessWindowLogs: ${error.message}`);
  return data || [];
}

function dateKeyUTC(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

function daysBetweenKeys(keyA, keyB) {
  return Math.round((new Date(keyB + 'T00:00:00Z').getTime() - new Date(keyA + 'T00:00:00Z').getTime()) / DAY_MS);
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[(n - 1) / 2];
}

function lastConsecutiveMorningDays(morningByDay, n) {
  const daysSorted = Object.keys(morningByDay).sort();
  if (daysSorted.length < n) return null;
  const lastN = daysSorted.slice(-n);
  for (let i = 1; i < lastN.length; i++) {
    if (daysBetweenKeys(lastN[i - 1], lastN[i]) !== 1) return null;
  }
  return lastN.map((k) => morningByDay[k]);
}

function computeReadinessSignals(windowLogs, now) {
  const nowIso = (now || new Date()).toISOString();
  const todayKey = dateKeyUTC(nowIso);

  const morningByDay = {};
  for (const log of windowLogs) {
    if (log.entry_type !== 'morning' || !log.payload) continue;
    morningByDay[dateKeyUTC(log.created_at)] = log.payload;
  }

  const trainingLogs = windowLogs.filter((l) => l.entry_type === 'post_training' && l.payload
    && typeof l.payload.rpe === 'number' && typeof l.payload.duration_minutes === 'number');
  const dailyLoad = {};
  for (const log of trainingLogs) {
    const key = dateKeyUTC(log.created_at);
    dailyLoad[key] = (dailyLoad[key] || 0) + log.payload.rpe * log.payload.duration_minutes;
  }
  function loadOnDay(key) { return dailyLoad[key] || 0; }
  function weekLoadEndingAt(endKey) {
    let sum = 0;
    const endMs = new Date(endKey + 'T00:00:00Z').getTime();
    for (let i = 0; i < 7; i++) {
      sum += loadOnDay(new Date(endMs - i * DAY_MS).toISOString().slice(0, 10));
    }
    return sum;
  }

  let weeklyLoadSpike = null;
  const allDateKeys = windowLogs.map((l) => dateKeyUTC(l.created_at));
  if (allDateKeys.length) {
    const earliestKey = allDateKeys.reduce((a, b) => (a < b ? a : b));
    const spanDays = daysBetweenKeys(earliestKey, todayKey);
    if (spanDays >= 13) {
      const currentWeek = weekLoadEndingAt(todayKey);
      const prevWeekEndKey = new Date(new Date(todayKey + 'T00:00:00Z').getTime() - 7 * DAY_MS).toISOString().slice(0, 10);
      const prevWeek = weekLoadEndingAt(prevWeekEndKey);
      if (prevWeek > 0) {
        const changePct = (currentWeek - prevWeek) / prevWeek;
        weeklyLoadSpike = { active: changePct >= 0.15, changePct, currentWeek, prevWeek };
      }
    }
  }

  let sleepFlag = { active: false };
  {
    const lastTwo = lastConsecutiveMorningDays(morningByDay, 2);
    if (lastTwo && lastTwo.every((p) => typeof p.sleep_hours === 'number' && p.sleep_hours < 7)) {
      sleepFlag = { active: true, consecutiveDays: 2 };
    }
  }

  let coldStartOrBaseline;
  {
    const morningDaysInBaselineWindow = Object.keys(morningByDay)
      .filter((k) => daysBetweenKeys(k, todayKey) <= BASELINE_WINDOW_DAYS);
    const useBaseline = morningDaysInBaselineWindow.length >= BASELINE_MIN_MORNING_ENTRIES;

    const lastThreeTrainings = trainingLogs.slice(-3);
    const avgRpe = lastThreeTrainings.length === 3
      ? lastThreeTrainings.reduce((s, l) => s + l.payload.rpe, 0) / 3
      : null;
    const lastTwoMornings = lastConsecutiveMorningDays(morningByDay, 2);

    if (avgRpe === null || !lastTwoMornings) {
      coldStartOrBaseline = { mode: useBaseline ? 'baseline' : 'cold_start', tired: false, insufficientData: true };
    } else if (useBaseline) {
      const rpeHistory = trainingLogs.map((l) => l.payload.rpe);
      const sleepQHistory = morningDaysInBaselineWindow
        .map((k) => morningByDay[k].sleep_quality).filter((v) => typeof v === 'number');
      const fatigueHistory = morningDaysInBaselineWindow
        .map((k) => morningByDay[k].morning_fatigue).filter((v) => typeof v === 'number');
      const medRpe = medianOf(rpeHistory);
      const medSleepQ = medianOf(sleepQHistory);
      const medFatigue = medianOf(fatigueHistory);

      const rpeTired = medRpe !== null && avgRpe > medRpe + 1;
      const sleepTired = lastTwoMornings.every((p) =>
        (typeof p.sleep_quality === 'number' && medSleepQ !== null && p.sleep_quality < medSleepQ - 2) ||
        (typeof p.morning_fatigue === 'number' && medFatigue !== null && p.morning_fatigue > medFatigue + 2));
      coldStartOrBaseline = { mode: 'baseline', tired: rpeTired && sleepTired, avgRpe, medRpe, medSleepQ, medFatigue };
    } else {
      const rpeTired = avgRpe >= 7;
      const sleepTired = lastTwoMornings.every((p) =>
        (typeof p.sleep_quality === 'number' && p.sleep_quality <= 4) ||
        (typeof p.morning_fatigue === 'number' && p.morning_fatigue >= 7));
      coldStartOrBaseline = { mode: 'cold_start', tired: rpeTired && sleepTired, avgRpe };
    }
  }

  let moodFlag = { active: false };
  {
    const lastTwo = lastConsecutiveMorningDays(morningByDay, 2);
    if (lastTwo && lastTwo.every((p) => typeof p.mood_motivation === 'number' && p.mood_motivation <= 4)) {
      moodFlag = { active: true, consecutiveDays: 2, requiresGentleTone: true };
    }
  }

  return { weeklyLoadSpike, sleepFlag, coldStartOrBaseline, moodFlag };
}

function buildReadinessNarrative(signals) {
  if (!signals) return [];
  const lines = [];

  if (signals.weeklyLoadSpike && signals.weeklyLoadSpike.active) {
    const pct = Math.round(signals.weeklyLoadSpike.changePct * 100);
    lines.push(`SYGNAŁ GOTOWOŚCI (fizyczny, główny): tygodniowe obciążenie treningowe wzrosło o ${pct}% względem poprzedniego tygodnia (próg ryzyka: >=15%) — przy tak szybkiej progresji ryzyko kontuzji rośnie, zaproponuj ostrożniejsze dozowanie (mniej sesji/tydzień albo krótszy czas trwania).`);
  }
  if (signals.sleepFlag && signals.sleepFlag.active) {
    lines.push('SYGNAŁ GOTOWOŚCI (fizyczny): sen poniżej 7h przez 2 kolejne noce z rzędu — uwzględnij to w dozowaniu.');
  }
  if (signals.coldStartOrBaseline && signals.coldStartOrBaseline.tired) {
    lines.push('SYGNAŁ GOTOWOŚCI (fizyczny): wysokie obciążenie ostatnich sesji w połączeniu ze słabym snem/zmęczeniem porannym — wskazuje na zmęczenie, zaproponuj bezpieczniejszy zakres.');
  }
  if (signals.moodFlag && signals.moodFlag.active) {
    lines.push('SYGNAŁ GOTOWOŚCI (mentalny — TON WYŁĄCZNIE łagodny, to nastoletni zawodnik): nastrój/motywacja niska przez 2 kolejne dni. Nie wspominaj o tym wprost w uzasadnieniu dozowania (to nie miejsce na temat wrażliwy), ale rozważ nieco łagodniejszy zakres.');
  }
  return lines;
}

async function fetchKnowledgeBase(supabase, segmentId) {
  const { data, error } = await supabase
    .from('knowledge_base_entries')
    .select('content')
    .eq('segment_id', segmentId)
    .maybeSingle();
  if (error) throw new Error(`fetchKnowledgeBase: ${error.message}`);
  return data ? data.content : null;
}

async function fetchEquipment(supabase, userId) {
  const { data, error } = await supabase
    .from('player_profiles')
    .select('equipment_access')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`fetchEquipment: ${error.message}`);
  return (data && data.equipment_access) || [];
}

async function fetchComponentOrCustom(supabase, componentId, customDescription) {
  if (customDescription) return customDescription;
  if (!componentId) return null;
  const { data, error } = await supabase
    .from('segment_components')
    .select('name, description')
    .eq('id', componentId)
    .maybeSingle();
  if (error) throw new Error(`fetchComponentOrCustom: ${error.message}`);
  if (!data) return null;
  return `${data.name}: ${data.description}`;
}

// ------------------------------------------------------------
// TERMINARZ A7 08.08.2026 — MECZE ZAWODNIKA (znalezisko A34 / M21)
// ------------------------------------------------------------
// Reguła bezwzględna `moc-segment-01` mówi TAKŻE: „Mecz powinien być co
// najmniej 48 godzin po sesji plyometrycznej" — a faza 1 proponowała dni
// tygodnia, nie wiedząc nic o meczach. Połowa reguły była niewykonalna
// niezależnie od tego, jak dobrze model czytał prompt. `calendar_events`
// z `event_type='match'` istnieje i czyta z niego rytm pre_match dyspozytora
// — bierzemy DOKŁADNIE ten sam filtr (user_id + event_type + status +
// scheduled_date), żeby „mecz" znaczył w obu miejscach to samo.
//
// Do promptu idą wyłącznie DATY i dni tygodnia — zero nazw przeciwników,
// zero danych osobowych. Horyzont 14 dni: plan dotyczy powtarzalnych dni
// tygodnia, więc dalsze mecze nic nie zmieniają w decyzji o `days`.
async function fetchUpcomingMatches(supabase, userId, now = new Date()) {
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 13 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('calendar_events')
    .select('scheduled_date')
    .eq('user_id', userId)
    .eq('event_type', 'match')
    .eq('status', 'scheduled')
    .gte('scheduled_date', from)
    .lte('scheduled_date', to)
    .order('scheduled_date', { ascending: true });
  if (error) throw new Error(`fetchUpcomingMatches: ${error.message}`);
  return (data ?? []).map((r) => r.scheduled_date).filter((d) => typeof d === 'string');
}

const DAY_CODES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const DAY_NAMES_PL = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela'];

/** `YYYY-MM-DD` → indeks 0=MON…6=SUN (UTC — data bez czasu, więc strefa nie gra roli). */
function dayIndexOfDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return (d.getUTCDay() + 6) % 7;
}

/**
 * Linie terminarza do promptu użytkownika + zbiór kodów dni meczowych.
 * Pusta lista meczów → `lines: []` i prompt IDENTYCZNY z dzisiejszym
 * (pilnowane testem przez md5, jak przy podpowiedziach).
 */
function buildMatchScheduleLines(matchDates) {
  const dates = Array.isArray(matchDates) ? matchDates : [];
  const valid = dates.filter((d) => dayIndexOfDate(d) !== null);
  if (valid.length === 0) return { lines: [], matchDayCodes: [] };
  const codes = [...new Set(valid.map((d) => DAY_CODES[dayIndexOfDate(d)]))];
  const opis = valid
    .map((d) => `${DAY_NAMES_PL[dayIndexOfDate(d)]} (${DAY_CODES[dayIndexOfDate(d)]}) ${d}`)
    .join('; ');
  return {
    lines: [`Zaplanowane mecze w najbliższych dwóch tygodniach: ${opis}.`],
    matchDayCodes: codes,
  };
}

// ------------------------------------------------------------
// PROMPT
// ------------------------------------------------------------
function buildSystemPrompt({ knowledgeBaseContent, segmentId, hintSelection, matchDayCodes }) {
  const kbBlock = knowledgeBaseContent
    ? `BAZA WIEDZY GAMECHANGE dla tego segmentu (źródło prawdy — nigdy jej nie neguj):\n${knowledgeBaseContent}\n\n`
    : '';
  const techSpecNote = segmentId === 'techSpec'
    ? 'UWAGA: baza wiedzy dla segmentu Technika Specjalistyczna jest słabiej ugruntowana naukowo niż pozostałe (więcej praktyki trenerskiej niż twardych badań) — sformułuj reasoning z odrobiną większej ostrożności/mniejszą pewnością, ale NIE odmawiaj sugestii.\n\n'
    : '';

  // DOZOWANIE A6 08.08.2026 — osobna, NAZWANA sekcja promptu, OBOK bazy
  // wiedzy, nigdy zamiast niej. Ta sama funkcja i ten sam kształt sekcji co
  // w silniku rekomendacji (runda 4) i w fazie 2 Bloku (runda 5) — trzy
  // konsumenty, jeden format, zero kopii.
  // Pusty string, gdy nie ma czego wstrzyknąć — wtedy CAŁY prompt jest
  // identyczny z dzisiejszym, co do znaku.
  const hintsBlock = buildHintPromptBlock(hintSelection);
  const hasHints = hintsBlock.length > 0;

  // Instrukcja SPECYFICZNA DLA FAZY 1 — dołączana wyłącznie razem
  // z podpowiedziami. Sekcja ogólna (`buildHintPromptBlock`) mówi "oprzyj
  // REKOMENDACJĘ na podpowiedzi"; tutaj rozstrzygamy liczby, więc trzeba
  // powiedzieć wprost, że podpowiedź o odstępach albo o długości cyklu
  // WIĄŻE wynik, a nie tylko go inspiruje. Zdanie o regule bezwzględnej
  // jest tu dlatego, że `moc-segment-01` ("minimum 48 godzin przerwy")
  // jest w materiale tak właśnie oznaczona i model ma to widzieć w tym
  // samym miejscu, w którym podejmuje decyzję o `days`.
  const hintsDosingNote = hasHints
    ? 'JAK ICH UŻYĆ PRZY DOZOWANIU (to jest faza planowania, nie porada treściowa): jeżeli którakolwiek z powyższych podpowiedzi mówi o ODSTĘPACH między sesjami, LICZBIE sesji w tygodniu, DŁUGOŚCI sesji albo LICZBIE tygodni — potraktuj ją jako ograniczenie WIĄŻĄCE dla pól "days", "durationMinutes" i "weeks", nie jako inspirację. Podpowiedź opatrzona dopiskiem [materiał deklaruje: … regułę bezwzględną] NIE MOŻE zostać złamana przez Twoją propozycję — jeśli zadeklarowana przez zawodnika liczba sesji nie da się z nią pogodzić, rozłóż dni tak, żeby odstęp był największy z możliwych, i napisz o tym w "reasoning". Podpowiedzi, które nie dotyczą dozowania, po prostu pomiń — nie streszczaj ich w uzasadnieniu.\n\n'
    : '';

  // Pole `used_hint_klucz` wchodzi do formatu odpowiedzi WYŁĄCZNIE wtedy,
  // gdy podpowiedzi faktycznie poszły — ten sam warunek i ta sama treść co
  // w rundzie 4 i 5. Dzięki temu ścieżka bez podpowiedzi zostaje bajt
  // w bajt dzisiejsza, a przy podpowiedziach zawodnik zobaczy na ekranie
  // planera dokładnie to zdanie z materiału, na którym model się oparł.
  const usedHintField = hasHints
    ? ', "used_hint_klucz": "klucz podpowiedzi z sekcji PODPOWIEDZI, na której oparłeś dozowanie (dokładnie ten ciąg z nawiasu, np. moc-segment-01) — albo pusty string, jeśli żadna nie dotyczyła dozowania"'
    : '';

  // TERMINARZ A7 08.08.2026 (M21) — sekcja wchodzi WYŁĄCZNIE, gdy zawodnik
  // ma zaplanowane mecze; bez nich prompt jest identyczny co do znaku
  // z dzisiejszym (ten sam wzorzec co hintsBlock, pilnowany testem md5).
  // Dwie reguły, obie o `days`: (1) dzień meczu nie jest dniem sesji Bloku —
  // zdrowy rozsądek planowania, nie nowa wiedza; (2) reguła bezwzględna
  // o odstępie od meczu (jeśli jest w podpowiedziach — u `moc` jest) ma
  // TERMINARZ jako dane, względem których się ją egzekwuje.
  const matchNote = Array.isArray(matchDayCodes) && matchDayCodes.length > 0
    ? `TERMINARZ MECZÓW (dane zawodnika niżej wymieniają daty): dni meczowe w najbliższych dwóch tygodniach to: ${matchDayCodes.join(', ')}. Reguła WIĄŻĄCA dla "days": dzień meczu NIE jest dniem sesji Bloku. Jeżeli którakolwiek podpowiedź z materiałów mówi o odstępie sesji od MECZU (np. mecz co najmniej 48 godzin po sesji plyometrycznej), egzekwuj ją względem tych dni — a jeśli zadeklarowana liczba sesji nie da się z tym pogodzić, odsuń sesje możliwie najdalej od dni meczowych i napisz o tym w "reasoning".\n\n`
    : '';

  return `Jesteś silnikiem dozowania w module "Blok Skupienia" aplikacji Gamechange dla młodych piłkarzy.

FILOZOFIA (nienaruszalna): jesteś NAWIGATOREM, nie planistą — sugerujesz rozsądne dozowanie (dni tygodnia, czas trwania, liczba tygodni), zawodnik może je edytować przed zatwierdzeniem. Bierz pod uwagę zadeklarowaną liczbę sesji/tydzień zawodnika jako punkt wyjścia (nie zwiększaj jej samodzielnie), sygnały gotowości (jeśli wskazują na zmęczenie/ryzyko — bądź ostrożniejszy z czasem trwania, nie z liczbą dni), i dostępny sprzęt (nie proponuj ćwiczeń wymagających sprzętu, którego zawodnik nie ma — jeśli baza wiedzy sugeruje coś sprzętowego, a sprzętu brak, wspomnij o alternatywie bez sprzętu w reasoning).

${kbBlock}${hintsBlock}${hintsDosingNote}${matchNote}${techSpecNote}JĘZYK: wyłącznie polski, zwięźle, zwracaj się do zawodnika bezpośrednio ("Ty"), ton ciepły i konkretny — to nastoletni zawodnik, nie profesjonalny sportowiec.

DOMYŚLNY CZAS TRWANIA: 15-20 minut na sesję, chyba że baza wiedzy albo sygnały gotowości sugerują inaczej.
DOMYŚLNA LICZBA TYGODNI: 4, chyba że baza wiedzy sugeruje inny sensowny okres (2-8 tygodni).

FORMAT ODPOWIEDZI: zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez bloków kodu, bez komentarzy) dokładnie w tym kształcie:
{"days": ["MON","WED","FRI" - dokładnie tyle kodów dni ile zadeklarowanej liczby sesji/tydzień, z angielskich skrótów MON/TUE/WED/THU/FRI/SAT/SUN, rozłożone możliwie równomiernie w tygodniu], "durationMinutes": liczba, "weeks": liczba, "reasoning": "krótkie uzasadnienie po polsku, 1-2 zdania, w stylu przykładu z dokumentacji Gamechange (np. Twój sen i obciążenie są w normie, więc to bezpieczny zakres.)"${usedHintField}}`;
}

function buildUserPrompt({ segmentId, elementDescription, sessionsPerWeek, equipment, readinessLines, matchLines }) {
  const lines = [];
  lines.push(`Segment: ${SEG_NAMES[segmentId] || segmentId}.`);
  lines.push(`Co zawodnik chce trenować: ${elementDescription}.`);
  lines.push(`Zadeklarowana liczba sesji w tygodniu (punkt wyjścia, nie zwiększaj): ${sessionsPerWeek}.`);
  lines.push(`Dostęp do sprzętu: ${equipment && equipment.length ? equipment.join(', ') : 'brak zadeklarowanego dodatkowego sprzętu (zakładaj tylko piłkę/ciało własne)'}.`);
  if (readinessLines && readinessLines.length) lines.push(...readinessLines);
  else lines.push('Brak aktywnych sygnałów zmęczenia/ryzyka w danych zawodnika — możesz zaproponować standardowy zakres.');
  // TERMINARZ A7 08.08.2026 (M21) — daty meczów jako FAKTY w danych zawodnika.
  // Pusta lista → ani jednej dodatkowej linii (prompt co do znaku dzisiejszy).
  if (matchLines && matchLines.length) lines.push(...matchLines);
  return lines.join('\n');
}

// ------------------------------------------------------------
// DOZOWANIE A6 08.08.2026 — CZY MODEL FAKTYCZNIE TRZYMA ODSTĘP
// ------------------------------------------------------------
// Instrukcja w promptcie to prośba, nie gwarancja. Ta funkcja liczy realny,
// NAJMNIEJSZY odstęp między zaproponowanymi dniami — cyklicznie, bo tydzień
// się zawija (PON + PIĄ to 3 dni w przód, ale tylko 3 w tył; PON + NIE to
// odstęp 1 dnia przez granicę tygodnia, co przy regule 48 h jest złamaniem,
// a przy patrzeniu "po kolei" wygląda na 6 dni).
//
// ⚠️ ŚWIADOMIE DIAGNOSTYCZNA, NIE BLOKUJĄCA. Nie zmienia ani odpowiedzi
// endpointu, ani propozycji modelu — wypisuje jawny stan do logu (reguła
// R5). Powód: reguła "48 h" jest zdaniem w materiale, nie polem w bazie;
// wyprowadzanie progu z treści podpowiedzi byłoby zgadywaniem, a odrzucanie
// odpowiedzi modelu na podstawie zgadywanego progu wywróciłoby działający
// endpoint. Tak zbudowane — po pierwszym prawdziwym wywołaniu z ustawionym
// ANTHROPIC_API_KEY w logu Vercela widać WPROST, czy model regułę trzyma,
// zamiast żeby nikt się nigdy nie dowiedział.
const DAY_INDEX = { MON: 0, TUE: 1, WED: 2, THU: 3, FRI: 4, SAT: 5, SUN: 6 };

function describeDayGaps(days) {
  const lista = Array.isArray(days) ? days : [];
  const nieznane = lista.filter((d) => !(String(d).toUpperCase() in DAY_INDEX));
  const indeksy = [...new Set(
    lista.filter((d) => String(d).toUpperCase() in DAY_INDEX)
      .map((d) => DAY_INDEX[String(d).toUpperCase()])
  )].sort((a, b) => a - b);

  if (indeksy.length === 0) {
    return { minOdstepGodzin: null, stan: 'brak_rozpoznanych_dni', nieznaneKody: nieznane, dni: indeksy.length };
  }
  if (indeksy.length === 1) {
    // Jedna sesja w tygodniu — odstęp do niej samej za tydzień.
    return { minOdstepGodzin: 168, stan: 'jedna_sesja', nieznaneKody: nieznane, dni: 1 };
  }
  let min = Infinity;
  for (let i = 0; i < indeksy.length; i++) {
    const nastepny = indeksy[(i + 1) % indeksy.length];
    const roznica = i === indeksy.length - 1
      ? (nastepny + 7) - indeksy[i]   // zawinięcie tygodnia
      : nastepny - indeksy[i];
    if (roznica < min) min = roznica;
  }
  return { minOdstepGodzin: min * 24, stan: 'ok', nieznaneKody: nieznane, dni: indeksy.length };
}

// TERMINARZ A7 08.08.2026 (M21) — najmniejszy odstęp SESJA → NAJBLIŻSZY MECZ,
// w przód, cyklicznie po tygodniu (sesja SUN, mecz MON = 24 h). Sesja w dzień
// meczu = 0 h. Ta sama filozofia co `describeDayGaps`: DIAGNOSTYKA, nie
// blokada — po pierwszym prawdziwym wywołaniu log Vercela powie wprost, czy
// model uszanował terminarz. Przybliżenie dni-tygodnia (mecze mają daty,
// sesje są wzorcem tygodniowym) — wystarczające do diagnostyki, oznaczone.
function describeMatchGap(days, matchDayCodes) {
  const sesje = [...new Set((Array.isArray(days) ? days : [])
    .map((d) => DAY_INDEX[String(d).toUpperCase()])
    .filter((i) => i !== undefined))];
  const mecze = [...new Set((Array.isArray(matchDayCodes) ? matchDayCodes : [])
    .map((d) => DAY_INDEX[String(d).toUpperCase()])
    .filter((i) => i !== undefined))];
  if (mecze.length === 0) return { minOdstepDoMeczuGodzin: null, stan: 'brak_meczow', dniMeczowe: 0 };
  if (sesje.length === 0) return { minOdstepDoMeczuGodzin: null, stan: 'brak_rozpoznanych_dni', dniMeczowe: mecze.length };
  let min = Infinity;
  for (const s of sesje) for (const m of mecze) {
    const gap = ((m - s) + 7) % 7; // 0 = sesja w dzień meczu
    if (gap < min) min = gap;
  }
  return { minOdstepDoMeczuGodzin: min * 24, stan: 'ok', dniMeczowe: mecze.length };
}

// Jedna linia do `console.log` — także (a właściwie zwłaszcza) gdy nic
// podejrzanego się nie stało. Ten sam wzorzec co `describeHintState`
// i `describeDoseState`.
function describeDosingState({ gaps, hintsWeszly, kluczPodpowiedzi, matchGap } = {}) {
  const czesci = [];
  if (gaps) {
    czesci.push(`min_odstep_h=${gaps.minOdstepGodzin == null ? 'nieznany' : gaps.minOdstepGodzin}`);
    czesci.push(`dni=${gaps.dni}`);
    if (gaps.nieznaneKody && gaps.nieznaneKody.length) {
      czesci.push(`NIEZNANE_KODY_DNI=${gaps.nieznaneKody.join('/')}`);
    }
    if (gaps.minOdstepGodzin != null && gaps.minOdstepGodzin < 48) {
      czesci.push('UWAGA_ODSTEP_PONIZEJ_48H=tak');
    }
  }
  // TERMINARZ A7 08.08.2026 (M21) — odstęp od meczu, tym samym wzorcem.
  if (matchGap && matchGap.stan !== 'brak_meczow') {
    czesci.push(`min_odstep_do_meczu_h=${matchGap.minOdstepDoMeczuGodzin == null ? 'nieznany' : matchGap.minOdstepDoMeczuGodzin}`);
    czesci.push(`dni_meczowe=${matchGap.dniMeczowe}`);
    if (matchGap.minOdstepDoMeczuGodzin != null && matchGap.minOdstepDoMeczuGodzin < 48) {
      czesci.push('UWAGA_MECZ_PONIZEJ_48H_PO_SESJI=tak');
    }
    if (matchGap.minOdstepDoMeczuGodzin === 0) {
      czesci.push('UWAGA_SESJA_W_DZIEN_MECZU=tak');
    }
  }
  czesci.push(`podpowiedzi_w_promptcie=${hintsWeszly ? 'tak' : 'nie'}`);
  if (kluczPodpowiedzi) czesci.push(`uzyta=${kluczPodpowiedzi}`);
  return `[dozowanie] ${czesci.join(' ')}`;
}

function stripMarkdownJsonFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : trimmed;
}

async function callAnthropic(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY nie skonfigurowany — endpoint jest gotowy, brakuje tylko klucza.');
  }
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'; // fallback zaktualizowany
  // 04.08.2026 (ten sam placeholder co w generate-coach-tip.js/generate-recommendation.js,
  // Pakiet 10 — przeoczony tam, poprawiony teraz przy okazji budowania testów dla tego pliku).
  // Używany tylko, gdy ANTHROPIC_MODEL nie jest ustawiony w Vercel.
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Odpowiedź Anthropic bez bloku tekstowego.');
  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownJsonFence(textBlock.text));
  } catch (e) {
    throw new Error(`Nie udało się sparsować JSON z odpowiedzi AI: ${e.message}. Surowa odpowiedź (pierwsze 500 znaków): ${textBlock.text.slice(0, 500)}`);
  }
  return parsed;
}

// ------------------------------------------------------------
// ORKIESTRATOR
// ------------------------------------------------------------
async function generateFocusBlockDosing(params, injectedSupabase) {
  const { userId, segmentId, componentId, customDescription, sessionsPerWeek } = params || {};

  if (!userId) throw new Error('generateFocusBlockDosing: brak userId.');
  if (!segmentId || !SEG_PILLAR[segmentId]) throw new Error(`generateFocusBlockDosing: nieprawidłowy segmentId "${segmentId}".`);
  if (!componentId && !customDescription) throw new Error('generateFocusBlockDosing: wymagane componentId albo customDescription.');
  if (!Number.isInteger(sessionsPerWeek) || sessionsPerWeek < 1 || sessionsPerWeek > 7) {
    throw new Error('generateFocusBlockDosing: sessionsPerWeek musi być liczbą całkowitą 1-7.');
  }

  const supabase = injectedSupabase || getAdminClient();

  const [elementDescription, knowledgeBaseContent, equipment, readinessLogs] = await Promise.all([
    fetchComponentOrCustom(supabase, componentId, customDescription),
    fetchKnowledgeBase(supabase, segmentId),
    fetchEquipment(supabase, userId),
    fetchReadinessWindowLogs(supabase, userId),
  ]);
  if (!elementDescription) throw new Error('generateFocusBlockDosing: nie znaleziono opisu elementu (componentId nieistniejący?).');

  const readinessSignals = computeReadinessSignals(readinessLogs);
  const readinessLines = buildReadinessNarrative(readinessSignals);

  // --- DOZOWANIE A6 08.08.2026 — podpowiedzi z materiałów ---
  // NIGDY nie przerywa generowania. Brak tabeli (Kuba nie wkleił jeszcze
  // migracji rundy 3), brak rocznika, Blok bez Elementu — każdy z tych
  // stanów zostawia endpoint w DZISIEJSZYM zachowaniu, co do znaku, ale
  // ZAWSZE ląduje w logu pod własną nazwą (reguła R5 — żadnej cichej
  // pustki). Ten sam `try/catch` i ta sama kolejność co w
  // `generateRecommendation()` (runda 4) i `generateCheckin()` (runda 5).
  let hintLoad = null;
  try {
    hintLoad = await loadHintsForFocusBlock(supabase, {
      segmentId,
      componentId: componentId || null,
      userId,
    });
    console.log(hintLoad.log);
    if (hintLoad.stanTabeli === 'brak_tabeli') {
      console.log('[podpowiedzi] tabela component_hints nie istnieje — faza 1 dozowania pracuje jak przed rundą 6. To NIE znaczy "sprawdziłem i nic nie znalazłem".');
    } else if (hintLoad.stanTabeli === 'blad') {
      console.error(`[podpowiedzi] BŁĄD odczytu component_hints (dozowanie jedzie dalej bez nich): ${hintLoad.blad}`);
    }
    if (hintLoad.selection && hintLoad.selection.niedopasowane > 0) {
      console.error(`[podpowiedzi] UWAGA: ${hintLoad.selection.niedopasowane} podpowiedzi ma component_id=NULL mimo wypełnionej nazwy Obszaru/Elementu — to NIEUDANE dopasowanie w migracji, nie zamierzona reguła segmentowa.`);
    }
  } catch (e) {
    // Warstwa podpowiedzi nie ma prawa wywrócić endpointu, który działa
    // od 31.07.2026 i stoi na drodze zawodnika do założenia Bloku.
    console.error(`[podpowiedzi] nieoczekiwany wyjątek, dozowanie jedzie dalej bez podpowiedzi: ${e.message}`);
    hintLoad = null;
  }
  const hintSelection = hintLoad ? hintLoad.selection : null;

  // --- TERMINARZ A7 08.08.2026 — mecze zawodnika (M21) ---
  // Ten sam kontrakt bezpieczeństwa co podpowiedzi: NIGDY nie przerywa
  // generowania; błąd odczytu = dozowanie jak przed tą rundą + jawny log.
  let matchDates = null;
  try {
    matchDates = await fetchUpcomingMatches(supabase, userId);
    if (matchDates.length === 0) {
      console.log('[dozowanie] terminarz: brak zaplanowanych meczów w 14 dni — prompt bez sekcji meczowej.');
    } else {
      console.log(`[dozowanie] terminarz: ${matchDates.length} mecz(e) w 14 dni: ${matchDates.join(', ')}`);
    }
  } catch (e) {
    console.error(`[dozowanie] terminarz: BŁĄD odczytu calendar_events (dozowanie jedzie dalej bez meczów): ${e.message}`);
    matchDates = null;
  }
  const matchSchedule = buildMatchScheduleLines(matchDates);

  const systemPrompt = buildSystemPrompt({ knowledgeBaseContent, segmentId, hintSelection, matchDayCodes: matchSchedule.matchDayCodes });
  const userPrompt = buildUserPrompt({ segmentId, elementDescription, sessionsPerWeek, equipment, readinessLines, matchLines: matchSchedule.lines });
  const aiResult = await callAnthropic(systemPrompt, userPrompt);

  if (!Array.isArray(aiResult.days) || !aiResult.days.length || typeof aiResult.durationMinutes !== 'number' || typeof aiResult.weeks !== 'number' || !aiResult.reasoning) {
    throw new Error('Odpowiedź AI nie zawiera wszystkich wymaganych pól (days/durationMinutes/weeks/reasoning).');
  }

  // DOZOWANIE A6 08.08.2026 — jedna podpowiedź jedzie na ekran planera
  // (reguła R1). Kształt identyczny z `decision_recommendations.source_hint`
  // (runda 4) i `content_doses[].zrodlo_podpowiedzi` (runda 5) — pas B ma
  // komponent, który to renderuje, więc świadomie nie wymyślam trzeciego
  // kształtu na to samo. `null`, gdy podpowiedzi nie było.
  const sourceHint = pickShowcaseHint(
    hintSelection,
    typeof aiResult.used_hint_klucz === 'string' && aiResult.used_hint_klucz.trim()
      ? aiResult.used_hint_klucz.trim()
      : null
  );

  const gaps = describeDayGaps(aiResult.days);
  const matchGap = describeMatchGap(aiResult.days, matchSchedule.matchDayCodes);
  console.log(describeDosingState({
    gaps,
    hintsWeszly: !!(hintSelection && hintSelection.hints && hintSelection.hints.length),
    kluczPodpowiedzi: sourceHint ? sourceHint.klucz : null,
    matchGap,
  }));

  return {
    ok: true,
    suggestion: {
      sessionsPerWeek: aiResult.days.length,
      days: aiResult.days,
      durationMinutes: aiResult.durationMinutes,
      weeks: aiResult.weeks,
      reasoning: aiResult.reasoning,
    },
    pillar: resolvePillar(segmentId),
    // --- DOZOWANIE A6 08.08.2026 — POLA NOWE, dokładane nigdy zabierane.
    // Dzisiejszy konsument (`cele.tsx`) czyta `ok`/`suggestion`/`pillar`
    // i te trzy są bez zmian; poniższe po prostu ignoruje. ---
    sourceHint,
    podpowiedzi: hintLoad
      ? {
        stanTabeli: hintLoad.stanTabeli,
        stanCelowania: hintLoad.stanCelowania,
        stanWieku: hintLoad.stanWieku,
        wiekNieznany: hintLoad.selection.wiekNieznany,
        ukryteZPowoduWieku: hintLoad.selection.ukryteZPowoduWieku,
        wstrzykniete: hintLoad.selection.hints.length,
        wszystkieWejsciowe: hintLoad.selection.wszystkieWejsciowe,
      }
      : { stanTabeli: 'nie_probowano', stanCelowania: null, stanWieku: null, wiekNieznany: null, ukryteZPowoduWieku: 0, wstrzykniete: 0, wszystkieWejsciowe: 0 },
    rytm: gaps,
    // TERMINARZ A7 08.08.2026 (M21) — diagnostyka meczowa; NIE na ekran.
    // `stan: 'nie_probowano'` = błąd odczytu kalendarza (odróżnialny od
    // „sprawdziłem, meczów brak" — reguła R5).
    mecze: matchDates === null
      ? { stan: 'nie_probowano', daty: [], ...{ minOdstepDoMeczuGodzin: null, dniMeczowe: 0 } }
      : { ...matchGap, daty: matchDates },
  };
}

// ------------------------------------------------------------
// LIMIT R13 08.08.2026 — rate-limit fazy 1 (dług M24, znalezisko A35)
// ------------------------------------------------------------
// PO CO: po rundach 6-7 prompt tego endpointu jest ~3x większy (baza wiedzy
// + podpowiedzi z materiałów + terminarz), a wywołuje go appka BEZ sekretu,
// jednym przyciskiem w planerze Bloku. Zawodnik stukający w "Zaproponuj
// dozowanie" pięć razy z rzędu (bo "nie podoba mi się wynik" albo bo sieć
// zamula i nie widzi spinnera) płaci pięć pełnych promptów. Ten limit
// zamyka dokładnie ten scenariusz: max 3 wywołania na zawodnika w oknie
// 10 minut, czwarte dostaje 429 z czasem odczekania — a appka i tak ma
// już wynik z poprzednich prób na ekranie.
//
// CO TEN LIMIT ŚWIADOMIE JEST, A CZYM NIE JEST (uczciwie, R5):
//  • Stan trzymany W PAMIĘCI instancji funkcji (Map userId -> czasy).
//    Vercel może odpalić kilka instancji albo zimny start wyzeruje licznik
//    - wtedy limit bywa łagodniejszy, NIGDY surowszy. To wystarcza na
//    ochronę przed stukaniem i pętlą w appce (realny koszt z A35), a nie
//    wymaga nowej tabeli ani zapisu do bazy (endpoint pozostaje czystą
//    funkcją sugestii).
//  • To NIE jest ochrona przed napastnikiem — endpoint jest bez sekretu
//    (świadoma decyzja z nagłówka, wzorzec validate-goal-refinement.js);
//    napastnik może rotować userId. Twarda ochrona = sekret/auth, osobna
//    decyzja produktowa, poza tą rundą.
// Czysta logika okna jest w pruneAndCheckRateLimit() (testowalna z fałszywym
// zegarem); stan i I/O w checkDosingRateLimit().

const RATE_LIMIT_MAX_CALLS = 3;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minut
const RATE_LIMIT_MAX_TRACKED_USERS = 500;    // bezpiecznik pamięci instancji

// Czysta: (lista czasów wywołań, teraz) -> decyzja + odświeżona lista.
// `fresh` przy odmowie NIE zawiera bieżącej próby — odrzucone wywołanie
// nie przedłuża blokady (inaczej stukanie w przycisk nigdy by się nie
// odblokowało).
function pruneAndCheckRateLimit(entries, nowMs, max = RATE_LIMIT_MAX_CALLS, windowMs = RATE_LIMIT_WINDOW_MS) {
  const fresh = (Array.isArray(entries) ? entries : []).filter((t) => nowMs - t < windowMs);
  if (fresh.length >= max) {
    const retryAfterS = Math.max(1, Math.ceil((windowMs - (nowMs - fresh[0])) / 1000));
    return { allowed: false, fresh, retryAfterS };
  }
  return { allowed: true, fresh: [...fresh, nowMs], retryAfterS: 0 };
}

const _rateLimitState = new Map();

function checkDosingRateLimit(userId, nowMs = Date.now(), state = _rateLimitState) {
  // Bezpiecznik: zanim dopiszemy nowego usera, wyrzucamy przeterminowanych,
  // a gdy to nie wystarcza - czyścimy całość (limit łagodnieje, pamięć nie rośnie).
  if (!state.has(userId) && state.size >= RATE_LIMIT_MAX_TRACKED_USERS) {
    for (const [k, v] of state) {
      if (v.every((t) => nowMs - t >= RATE_LIMIT_WINDOW_MS)) state.delete(k);
    }
    if (state.size >= RATE_LIMIT_MAX_TRACKED_USERS) state.clear();
  }
  const wynik = pruneAndCheckRateLimit(state.get(userId), nowMs);
  state.set(userId, wynik.fresh);
  return wynik;
}

// ------------------------------------------------------------
// HTTP HANDLER (Vercel Function) — wywoływany bezpośrednio z appki
// mobilnej, bez sekretu (patrz komentarz "WZOROWANY" na górze pliku).
// ------------------------------------------------------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, segmentId, componentId, customDescription, sessionsPerWeek } = req.body || {};

  // LIMIT R13 (M24) — przed jakąkolwiek pracą i przed wywołaniem modelu.
  // Bez userId nie limitujemy (i tak zaraz poleci walidacja "brak userId").
  if (userId) {
    const limit = checkDosingRateLimit(String(userId));
    if (!limit.allowed) {
      console.warn(`[dozowanie] rate-limit: userId=${userId} przekroczył ${RATE_LIMIT_MAX_CALLS} wywołania/${Math.round(RATE_LIMIT_WINDOW_MS / 60000)} min — odmowa, retryAfterS=${limit.retryAfterS}.`);
      res.setHeader('Retry-After', String(limit.retryAfterS));
      return res.status(429).json({
        ok: false,
        error: `Za dużo prób w krótkim czasie. Sugestia dozowania sprzed chwili jest nadal aktualna — spróbuj ponownie za ${Math.ceil(limit.retryAfterS / 60)} min.`,
        retryAfterSeconds: limit.retryAfterS,
      });
    }
  }

  try {
    const result = await generateFocusBlockDosing({ userId, segmentId, componentId, customDescription, sessionsPerWeek });
    return res.status(200).json(result);
  } catch (e) {
    console.error('generate-focus-block-dosing error:', e);
    return res.status(400).json({ ok: false, error: e.message });
  }
};

module.exports.generateFocusBlockDosing = generateFocusBlockDosing;
module.exports._internal = {
  SEG_PILLAR, SEG_NAMES, resolvePillar,
  fetchReadinessWindowLogs, computeReadinessSignals, buildReadinessNarrative,
  fetchKnowledgeBase, fetchEquipment, fetchComponentOrCustom,
  buildSystemPrompt, buildUserPrompt, stripMarkdownJsonFence,
  // DOZOWANIE A6 08.08.2026
  DAY_INDEX, describeDayGaps, describeDosingState,
  // TERMINARZ A7 08.08.2026
  fetchUpcomingMatches, buildMatchScheduleLines, describeMatchGap, dayIndexOfDate,
  // LIMIT R13 08.08.2026 (M24)
  RATE_LIMIT_MAX_CALLS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_TRACKED_USERS,
  pruneAndCheckRateLimit, checkDosingRateLimit,
};

