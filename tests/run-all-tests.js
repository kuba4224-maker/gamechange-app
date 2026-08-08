// ============================================================
// GAMECHANGE — tests/run-all-tests.js (CI R17, 08.08.2026)
// ============================================================
// Jeden punkt wejścia dla WSZYSTKICH suit backendu: odkrywa tests/test-*.js,
// uruchamia każdą w osobnym procesie node (suita = własny sandbox require.cache,
// dokładnie jak przy ręcznym `node tests/plik.js`), zbiera wyniki i kończy
// kodem 1, jeśli COKOLWIEK jest czerwone.
//
// PO CO ISTNIEJE (audyt holistyczny 2a): setki testów istniały, ale nic nie
// uruchamiało ich automatycznie — jedyną ochroną przed regresją była dyscyplina
// sesji. Ten plik + .github/workflows/test.yml zamieniają dyscyplinę na system.
//
// Uruchomienie lokalne: `npm test` (albo node tests/run-all-tests.js).
// Na CI: patrz .github/workflows/test.yml.
//
// ŚWIADOMIE sekwencyjnie, nie równolegle: suity wypisują pomiary [pomiar]
// i zrzuty — przeplatanie strumieni utrudniłoby czytanie logu CI, a pełen
// przebieg i tak trwa dziesiątki sekund, nie minuty.
// ============================================================

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const testsDir = __dirname;
const files = fs.readdirSync(testsDir)
  .filter((f) => /^test-.*\.js$/.test(f))
  .sort();

if (files.length === 0) {
  console.error('run-all-tests: nie znaleziono ŻADNEGO pliku tests/test-*.js — to samo w sobie jest błędem.');
  process.exit(1);
}

const failed = [];
const started = Date.now();

for (const f of files) {
  const full = path.join(testsDir, f);
  process.stdout.write(`\n===== ${f} =====\n`);
  const res = spawnSync(process.execPath, [full], { stdio: 'inherit' });
  if (res.status !== 0) failed.push(`${f} (kod ${res.status})`);
}

const sec = Math.round((Date.now() - started) / 1000);
console.log(`\n============================================`);
console.log(`run-all-tests: ${files.length} suit w ${sec}s — ` +
  (failed.length === 0 ? 'WSZYSTKIE ZIELONE.' : `CZERWONE: ${failed.length}`));
for (const f of failed) console.log(`  FAIL: ${f}`);
process.exit(failed.length === 0 ? 0 : 1);
