// ============================================================
// GAMECHANGE - /api/cron-onboard-diagnosis.js
// ============================================================
// NOWY PLIK (25.07.2026, wieczor) - bezposrednia realizacja decyzji Kuby:
// "ankieta niech sie stanie na razie gotowym wejsciem do systemu... jak
// bedzie gotowy system, to po ankiecie... wprowadzimy zawodnikow do
// systemu i beda juz w systemie pierwsze rekomendacje wynikajace z
// wypelnionej ankiety."
//
// CO TEN PLIK ROBI (bez niego nic automatycznie nie generuje pierwszej
  // rekomendacji, mimo ze dane juz sa polaczone):
//   Domena 15 (most kont legacy) od dawna laczy istniejace wiersze
//   `diagnostics` z nowym `user_id` w momencie zalozenia konta. Ale
//   POWIAZANIE DANYCH to nie to samo co WYGENEROWANIE REKOMENDACJI -
//   nic wczesniej nie sprawdzalo "kto ma swiezo powiazana ankiete, a nie
//   ma jeszcze zadnego celu". Ten cron to wlasnie ta brakujaca klamra.
//
// CO ROBI KROK PO KROKU:
//   1. Znajduje zawodnikow z co najmniej jedna powiazana diagnoza i
//      ZEREM celow (goals) - to definicja "jeszcze nie onboardowany".
//   2. Dla kazdego kandydata: bierze NAJNOWSZA diagnoze, wylicza segment
//      bedacy wzglednym waskim gardlem (ta sama logika co w index.html),
//      z fallbackiem na najnizej punktowany segment gdy profil wyrownany.
//   3. Tworzy PIERWSZY cel (origin='system_proposed', is_priority=true).
//   4. Wola generateRecommendation() IN-PROCESS zeby od razu wygenerowac
//      pierwszy training_focus.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
  const {
    generateRecommendation,
    _internal: { computeRelativeDeficits, pickLowestScoringSegment },
    } = require('./generate-recommendation');

    const MAX_PER_RUN = 20;

    function getAdminClient() {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) {
        throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w zmiennych srodowiskowych.');
        }
          return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
        }

          async function fetchLatestDiagnosisPerUser(supabase) {
            const { data, error } = await supabase
            .from('diagnostics')
              .select('user_id, scores, top_deficits, created_at')
                .not('user_id', 'is', null)
                .not('scores', 'is', null)
                .order('created_at', { ascending: false })
                .limit(2000);
                if (error) throw new Error(`fetchLatestDiagnosisPerUser: ${error.message}`);

                const latestByUser = new Map();
                for (const row of data || []) {
                    if (!latestByUser.has(row.user_id)) latestByUser.set(row.user_id, row);
                    }
                    return latestByUser;
                  }

                    async function fetchUserIdsWithAnyGoal(supabase) {
                      const { data, error } = await supabase.from('goals').select('user_id');
                          if (error) throw new Error(`fetchUserIdsWithAnyGoal: ${error.message}`);
                          return new Set((data || []).map((r) => r.user_id));
                        }

                          function pickTopDeficitSegment(scoresRaw) {
                            let scores;
                            try { scores = typeof scoresRaw === 'string' ? JSON.parse(scoresRaw) : scoresRaw; }
                            catch (e) { return null; }
                            if (!scores || typeof scores !== 'object') return null;

                              const deficits = computeRelativeDeficits(scores, 1);
                              if (deficits.length) return deficits[0][0];

                              return pickLowestScoringSegment(scores);
                            }

                              module.exports = async (req, res) => {
                                  const authHeader = req.headers.authorization || '';
                                  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
                                    return res.status(401).json({ error: 'Unauthorized' });
                                  }

                                  const supabase = getAdminClient();
                                  const results = { onboarded: 0, skippedNoSegment: 0, blocked: 0, failed: 0, capped: false, errors: [] };

                                  try {
                                    const [latestByUser, userIdsWithGoal] = await Promise.all([
                                        fetchLatestDiagnosisPerUser(supabase),
                                        fetchUserIdsWithAnyGoal(supabase),
                                        ]);

                                    const candidates = [...latestByUser.entries()].filter(([userId]) => !userIdsWithGoal.has(userId));

                                    if (candidates.length > MAX_PER_RUN) {
                                      results.capped = true;
                                      console.warn(`cron-onboard-diagnosis: ${candidates.length} kandydatow, przetwarzam tylko pierwszych ${MAX_PER_RUN}.`);
                                    }

                                    const batch = candidates.slice(0, MAX_PER_RUN);

                                    for (const [userId, diagRow] of batch) {
                                        const segmentId = pickTopDeficitSegment(diagRow.scores);
                                        if (!segmentId) {
                                          results.skippedNoSegment++;
                                          continue;
                                        }

                                        try {
                                          const { data: newGoal, error: goalError } = await supabase
                                          .from('goals')
                                            .insert({
                                                user_id: userId,
                                                segment_id: segmentId,
                                                origin: 'system_proposed',
                                                status: 'active',
                                                is_priority: true,
                                                })
                                            .select()
                                            .single();
                                            if (goalError) throw new Error(`insert goals: ${goalError.message}`);

                                            const recResult = await generateRecommendation(
                                              { userId, recommendationType: 'training_focus', goalId: newGoal.id },
                                              supabase
                                            );

                                            if (!recResult.ok) {
                                              results.blocked++;
                                              console.warn(`cron-onboard-diagnosis: rekomendacja zablokowana dla user ${userId}: ${recResult.reason}`);
                                              } else {
                                              results.onboarded++;
                                            }
                                            } catch (e) {
                                              results.failed++;
                                              results.errors.push({ userId, error: e.message });
                                              console.error(`cron-onboard-diagnosis: blad dla user ${userId}:`, e);
                                            }
                                          }

                                            console.log('cron-onboard-diagnosis zakonczony:', results);
                                            return res.status(200).json({ ok: true, results });
                                            } catch (e) {
                                              console.error('cron-onboard-diagnosis error:', e);
                                              return res.status(500).json({ ok: false, error: e.message, results });
                                            }
                                          };

// dopisane wyłącznie po to, żeby dało się pokryć testem funkcję wyboru
// segmentu (patrz tests/test-cron-onboard-diagnosis.js) — zero zmiany
// zachowania handlera powyżej.
module.exports._internal = { pickTopDeficitSegment };

