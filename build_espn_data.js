// build_espn_data.js — fetches all WC 2026 static data from ESPN API
// Run: node build_espn_data.js
// Outputs: espn-data.js  (teams, players, matches, groups)
const https = require('https');
const fs = require('fs');

function get(url) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } };
    const req = https.get(url, opts, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function batchRun(items, fn, concurrency = 6, delayMs = 80) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const r = await Promise.allSettled(chunk.map(fn));
    results.push(...r);
    if (i + concurrency < items.length) await sleep(delayMs);
  }
  return results;
}

// ESPN team display name → canonical name used in this app
const ESPN_TO_CANONICAL = {
  'Bosnia-Herzegovina': 'Bosnia & Herzegovina',
  'Congo DR':           'DR Congo',
  'Czechia':            'Czech Republic',
};
function canonical(name) { return ESPN_TO_CANONICAL[name] || name; }

const SLUG_TO_ROUND = {
  'round-of-32':   'Round of 32',
  'round-of-16':   'Round of 16',
  'quarterfinals': 'Quarterfinals',
  'semifinals':    'Semifinals',
  'third-place':   '3rd Place',
  'final':         'Final',
};

function lbs2kg(lbs) {
  if (!lbs) return '';
  const n = parseFloat(lbs);
  return isNaN(n) ? '' : Math.round(n * 0.453592) + ' kg';
}

function feetInch2cm(str) {
  if (!str) return '';
  const m = str.match(/(\d+)'\s*(\d+)"/);
  if (!m) return str;
  return Math.round(parseInt(m[1]) * 30.48 + parseInt(m[2]) * 2.54) + ' cm';
}

function formatDOB(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getUTCDate().toString().padStart(2,'0')}.${(d.getUTCMonth()+1).toString().padStart(2,'0')}.${d.getUTCFullYear()}`;
}

async function main() {
  console.log('=== ESPN WC 2026 Data Builder ===\n');

  // ── 1. Teams ──────────────────────────────────────────────────────────────
  console.log('1. Fetching teams...');
  const teamsData = await get('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/teams');
  const rawTeams = teamsData.sports[0].leagues[0].teams.map(t => t.team);

  const ESPN_TEAMS = {};
  for (const t of rawTeams) {
    const name = canonical(t.displayName);
    ESPN_TEAMS[name] = { id: t.id, abbr: t.abbreviation, color: t.color || '', altColor: t.alternateColor || '' };
  }
  console.log(`   ✓ ${Object.keys(ESPN_TEAMS).length} teams\n`);

  // ── 2. Groups (standings API) ──────────────────────────────────────────────
  console.log('2. Fetching group assignments...');
  const standingsData = await get('https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?season=2026');
  const ESPN_GROUPS = {};    // teamName → "Group A"
  const groupById   = {};    // teamId   → "Group A"  (for match mapping)
  for (const grp of standingsData.children || []) {
    const gName = grp.name; // "Group A", "Group B", ...
    for (const entry of grp.standings?.entries || []) {
      const tName = canonical(entry.team?.displayName || '');
      const tId   = String(entry.team?.id || '');
      if (tName) ESPN_GROUPS[tName] = gName;
      if (tId)   groupById[tId]     = gName;
    }
  }
  console.log(`   ✓ ${Object.keys(ESPN_GROUPS).length} teams assigned to groups\n`);

  // ── 3. Match schedule (all WC 2026 dates) ─────────────────────────────────
  console.log('3. Fetching match schedule (June 11 – July 23)...');
  const dates = [];
  for (let d = new Date('2026-06-11'); d <= new Date('2026-07-23'); d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }

  const allEvents = [];
  for (let i = 0; i < dates.length; i += 8) {
    const batch = dates.slice(i, i + 8);
    const results = await Promise.allSettled(
      batch.map(d => get(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${d}`))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') allEvents.push(...(r.value.events || []));
    }
    process.stdout.write(`   ${Math.min(i + 8, dates.length)}/${dates.length} days...  \r`);
    await sleep(80);
  }

  // Deduplicate by event ID
  const seen = new Set();
  const uniqueEvents = allEvents.filter(e => {
    if (!e.id || seen.has(e.id)) return false;
    seen.add(e.id); return true;
  });

  const ESPN_MATCHES = uniqueEvents.map(ev => {
    const comp = ev.competitions?.[0];
    if (!comp) return null;
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) return null;

    const t1 = canonical(home.team.displayName);
    const t2 = canonical(away.team.displayName);

    const iso = ev.date || '';
    const [dateStr, timePart] = iso.split('T');
    const [hh, mm] = (timePart || '00:00').replace(/Z.*/,'').split(':');
    const time = `${(hh||'00').padStart(2,'0')}:${(mm||'00').padStart(2,'0')} UTC+0`;

    const slug   = ev.season?.slug || '';
    const t1id   = String(home.team?.id || '');
    const t2id   = String(away.team?.id || '');
    const group  = slug === 'group-stage' ? (groupById[t1id] || groupById[t2id] || null) : null;
    const round  = !group ? (SLUG_TO_ROUND[slug] || null) : null;
    const venue  = comp.venue?.fullName || '';

    return { id: ev.id, date: dateStr, time, team1: t1, team2: t2, group, round, venue };
  }).filter(Boolean).sort((a, b) => (a.date + a.time) < (b.date + b.time) ? -1 : 1);

  console.log(`\n   ✓ ${ESPN_MATCHES.length} matches\n`);

  // ── 4. Rosters ─────────────────────────────────────────────────────────────
  console.log('4. Fetching rosters...');
  const ESPN_PLAYERS = {};
  const allPlayerIds = [];

  await batchRun(Object.entries(ESPN_TEAMS), async ([name, team]) => {
    const r = await get(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/teams/${team.id}/roster`);
    const players = (r.athletes || []).map(a => ({
      id:     a.id,
      name:   a.displayName,
      pos:    a.position?.abbreviation || '',
      jersey: a.jersey || '',
      age:    a.age || null,
      dob:    a.dateOfBirth ? formatDOB(a.dateOfBirth) : '',
      height: feetInch2cm(a.displayHeight),
      weight: lbs2kg(a.displayWeight),
      club:   '',
    }));
    ESPN_PLAYERS[name] = players;
    players.forEach(p => allPlayerIds.push({ id: p.id, team: name }));
    process.stdout.write(`   ${Object.keys(ESPN_PLAYERS).length}/${Object.keys(ESPN_TEAMS).length} teams...  \r`);
  }, 6, 120);
  console.log(`\n   ✓ ${Object.values(ESPN_PLAYERS).flat().length} players\n`);

  // ── 5. Club info ───────────────────────────────────────────────────────────
  console.log(`5. Fetching club info for ${allPlayerIds.length} players...`);
  let done = 0;
  await batchRun(allPlayerIds, async ({ id, team }) => {
    try {
      const a = await get(`https://site.api.espn.com/apis/common/v3/sports/soccer/fifa.world/athletes/${id}`);
      const club = a.athlete?.team?.displayName || '';
      const p = ESPN_PLAYERS[team]?.find(x => x.id === id);
      if (p) p.club = club;
    } catch { /* skip */ }
    done++;
    if (done % 100 === 0) process.stdout.write(`   ${done}/${allPlayerIds.length}...  \r`);
  }, 8, 60);
  console.log(`\n   ✓ ${done} players processed\n`);

  // ── 6. Write output ────────────────────────────────────────────────────────
  const totalPlayers = Object.values(ESPN_PLAYERS).flat().length;
  const out =
`// Auto-generated by build_espn_data.js — ${new Date().toISOString().split('T')[0]}
// ${Object.keys(ESPN_TEAMS).length} teams | ${totalPlayers} players | ${ESPN_MATCHES.length} matches
const ESPN_TEAMS=${JSON.stringify(ESPN_TEAMS)};
const ESPN_PLAYERS=${JSON.stringify(ESPN_PLAYERS)};
const ESPN_GROUPS=${JSON.stringify(ESPN_GROUPS)};
const ESPN_MATCHES=${JSON.stringify(ESPN_MATCHES)};
`;

  fs.writeFileSync('espn-data.js', out, 'utf8');
  console.log('✓ espn-data.js written');
  console.log(`  Teams:   ${Object.keys(ESPN_TEAMS).length}`);
  console.log(`  Players: ${totalPlayers}`);
  console.log(`  Groups:  ${Object.keys(ESPN_GROUPS).length} assignments`);
  console.log(`  Matches: ${ESPN_MATCHES.length}`);
  const gs = ESPN_MATCHES.filter(m => m.group).length;
  const ko = ESPN_MATCHES.filter(m => m.round).length;
  console.log(`           ${gs} group stage + ${ko} knockout`);
}

main().catch(e => { console.error(e); process.exit(1); });
