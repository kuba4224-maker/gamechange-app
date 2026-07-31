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
// - Kontrola kosztów / rate-limiting — ten sam świadomy brak co w
//   validate-goal-refinement.js (SESJA_START tej sesji tego nie wymagał).
// ============================================================

const { createClient } = require('@supabase/supabase-js');

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
// PROMPT
// ------------------------------------------------------------
function buildSystemPrompt({ knowledgeBaseContent, segmentId }) {
  const kbBlock = knowledgeBaseContent
    ? `BAZA WIEDZY GAMECHANGE dla tego segmentu (źródło prawdy — nigdy jej nie neguj):\n${knowledgeBaseContent}\n\n`
    : '';
  const techSpecNote = segmentId === 'techSpec'
    ? 'UWAGA: baza wiedzy dla segmentu Technika Specjalistyczna jest słabiej ugruntowana naukowo niż pozostałe (więcej praktyki trenerskiej niż twardych badań) — sformułuj reasoning z odrobiną większej ostrożności/mniejszą pewnością, ale NIE odmawiaj sugestii.\n\n'
    : '';

  return `Jesteś silnikiem dozowania w module "Blok Skupienia" aplikacji Gamechange dla młodych piłkarzy.

FILOZOFIA (nienaruszalna): jesteś NAWIGATOREM, nie planistą — sugerujesz rozsądne dozowanie (dni tygodnia, czas trwania, liczba tygodni), zawodnik może je edytować przed zatwierdzeniem. Bierz pod uwagę zadeklarowaną liczbę sesji/tydzień zawodnika jako punkt wyjścia (nie zwiększaj jej samodzielnie), sygnały gotowości (jeśli wskazują na zmęczenie/ryzyko — bądź ostrożniejszy z czasem trwania, nie z liczbą dni), i dostępny sprzęt (nie proponuj ćwiczeń wymagających sprzętu, którego zawodnik nie ma — jeśli baza wiedzy sugeruje coś sprzętowego, a sprzętu brak, wspomnij o alternatywie bez sprzętu w reasoning).

${kbBlock}${techSpecNote}JĘZYK: wyłącznie polski, zwięźle, zwracaj się do zawodnika bezpośrednio ("Ty"), ton ciepły i konkretny — to nastoletni zawodnik, nie profesjonalny sportowiec.

DOMYŚLNY CZAS TRWANIA: 15-20 minut na sesję, chyba że baza wiedzy albo sygnały gotowości sugerują inaczej.
DOMYŚLNA LICZBA TYGODNI: 4, chyba że baza wiedzy sugeruje inny sensowny okres (2-8 tygodni).

FORMAT ODPOWIEDZI: zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez bloków kodu, bez komentarzy) dokładnie w tym kształcie:
{"days": ["MON","WED","FRI" - dokładnie tyle kodów dni ile zadeklarowanej liczby sesji/tydzień, z angielskich skrótów MON/TUE/WED/THU/FRI/SAT/SUN, rozłożone możliwie równomiernie w tygodniu], "durationMinutes": liczba, "weeks": liczba, "reasoning": "krótkie uzasadnienie po polsku, 1-2 zdania, w stylu przykładu z dokumentacji Gamechange (np. Twój sen i obciążenie są w normie, więc to bezpieczny zakres.)"}`;
}

function buildUserPrompt({ segmentId, elementDescription, sessionsPerWeek, equipment, readinessLines }) {
  const lines = [];
  lines.push(`Segment: ${SEG_NAMES[segmentId] || segmentId}.`);
  lines.push(`Co zawodnik chce trenować: ${elementDescription}.`);
  lines.push(`Zadeklarowana liczba sesji w tygodniu (punkt wyjścia, nie zwiększaj): ${sessionsPerWeek}.`);
  lines.push(`Dostęp do sprzętu: ${equipment && equipment.length ? equipment.join(', ') : 'brak zadeklarowanego dodatkowego sprzętu (zakładaj tylko piłkę/ciało własne)'}.`);
  if (readinessLines && readinessLines.length) lines.push(...readinessLines);
  else lines.push('Brak aktywnych sygnałów zmęczenia/ryzyka w danych zawodnika — możesz zaproponować standardowy zakres.');
  return lines.join('\n');
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
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
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

  const systemPrompt = buildSystemPrompt({ knowledgeBaseContent, segmentId });
  const userPrompt = buildUserPrompt({ segmentId, elementDescription, sessionsPerWeek, equipment, readinessLines });
  const aiResult = await callAnthropic(systemPrompt, userPrompt);

  if (!Array.isArray(aiResult.days) || !aiResult.days.length || typeof aiResult.durationMinutes !== 'number' || typeof aiResult.weeks !== 'number' || !aiResult.reasoning) {
    throw new Error('Odpowiedź AI nie zawiera wszystkich wymaganych pól (days/durationMinutes/weeks/reasoning).');
  }

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
  };
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
};

