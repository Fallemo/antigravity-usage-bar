const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

/** @type {Map<string, { mtimeMs: number, size: number, events: Array<any> }>} */
const fileCache = new Map();

/** @type {vscode.StatusBarItem | undefined} */
let statusBarItem;
/** @type {vscode.WebviewPanel | undefined} */
let dashboardPanel;
/** @type {NodeJS.Timeout | undefined} */
let pollTimer;
/** @type {NodeJS.Timeout | undefined} */
let debounceTimer;
let lastWarnedLevel = 'normal'; // 'normal' | 'warn' | 'crit'

function getAntigravityDir() {
  const cfg = vscode.workspace.getConfiguration('antigravityUsage');
  const custom = (cfg.get('dataDirectory') || '').trim();
  if (custom) {
    return custom;
  }
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

function formatModelName(rawModel) {
  if (!rawModel || typeof rawModel !== 'string') {
    return 'Gemini';
  }
  const m = rawModel.toLowerCase();
  if (m.includes('carbon')) return 'Gemini 4 Carbon';
  if (m.includes('neon')) return 'Gemini 4 Neon';
  if (m.includes('argon')) return 'Gemini 4 Argon';
  if (m.includes('hydrogen')) return 'Gemini 4 Hydrogen';
  if (m.includes('orchestrator')) return 'Orchestrator';
  if (m.includes('3-8-flash') || m.includes('3.8')) return 'Gemini 3.8 Flash';
  if (m.includes('flash')) return 'Gemini Flash';
  if (m.includes('claude')) return 'Claude (AGY)';
  if (m.includes('pro')) return 'Gemini Pro';
  return rawModel;
}

function getModelWeight(rawModel) {
  const m = (rawModel || '').toLowerCase();
  // Modelele grele de reasoning consumă mai mult din quota Google AI Pro per pas
  if (m.includes('carbon') || m.includes('neon') || m.includes('opus')) {
    return 1.5;
  }
  // Modelele rapide / ușoare consumă mult mai puțin din quota
  if (m.includes('hydrogen') || m.includes('flash') || m.includes('lite') || m.includes('haiku')) {
    return 0.3;
  }
  return 1.0;
}

function parseTranscriptFile(filePath, stat) {
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.events;
  }

  const events = [];
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return events;
  }

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    // Filtru rapid înainte de JSON.parse pentru viteză
    if (!line.includes('"USER_INPUT"') && !line.includes('"input_tokens"') && !line.includes('"output_tokens"')) {
      continue;
    }
    try {
      const obj = JSON.parse(line);
      const ts = obj.created_at ? Date.parse(obj.created_at) : NaN;
      if (Number.isNaN(ts)) continue;

      if (obj.source === 'USER_EXPLICIT' && obj.type === 'USER_INPUT') {
        events.push({ kind: 'command', ts });
      } else if (
        obj.source === 'MODEL' &&
        (typeof obj.input_tokens === 'number' || typeof obj.output_tokens === 'number')
      ) {
        const inTok = Number(obj.input_tokens) || 0;
        const outTok = Number(obj.output_tokens) || 0;
        const cacheTok = Number(obj.cache_read_tokens) || 0;
        const weight = getModelWeight(obj.model);
        const units = weight * (1200 + inTok + outTok * 4 + cacheTok * 0.08);
        events.push({
          kind: 'model',
          ts,
          model: formatModelName(obj.model),
          units
        });
      }
    } catch {
      // Ignoră o linie parțial scrisă în timpul streaming-ului
    }
  }

  fileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, events });
  return events;
}

function tryReadCliStatuslineQuota() {
  // Dacă utilizatorul are și un cache oficial din agy CLI statusLine, îl poate citi opțional
  const cliQuotaPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'quota-cache.json');
  try {
    if (!fs.existsSync(cliQuotaPath)) return null;
    const stat = fs.statSync(cliQuotaPath);
    if (Date.now() - stat.mtimeMs > FIVE_HOURS_MS) return null;
    const data = JSON.parse(fs.readFileSync(cliQuotaPath, 'utf8'));
    if (!data || typeof data.quota !== 'object') return null;
    return { quota: data.quota, updatedAt: stat.mtimeMs };
  } catch {
    return null;
  }
}

function formatDurationShort(ms) {
  if (ms <= 0) return 'acum';
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function collectUsageStats(context) {
  const now = Date.now();
  const agyDir = getAntigravityDir();
  const brainDir = path.join(agyDir, 'brain');

  const cutoff5h = now - FIVE_HOURS_MS;
  const cutoffWk = now - ONE_WEEK_MS;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const cutoffToday = startOfToday.getTime();

  let units5h = 0;
  let unitsWk = 0;
  let commands5h = 0;
  let commandsToday = 0;
  let commandsWk = 0;
  let steps5h = 0;
  let stepsWk = 0;
  let oldestEvent5h = null;
  let latestEventTs = null;

  /** @type {Map<string, { steps5h: number, stepsWk: number, units5h: number, unitsWk: number }>} */
  const modelMap = new Map();

  // Pentru calibrarea/ancorarea manuală cu Settings -> Models
  const syncData = context.globalState.get('syncAnchor', null);
  let unitsSinceSync5h = 0;
  let unitsSinceSyncWk = 0;

  if (fs.existsSync(brainDir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const transcriptPath = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      let stat;
      try {
        stat = fs.statSync(transcriptPath);
      } catch {
        continue;
      }

      if (now - stat.mtimeMs > EIGHT_DAYS_MS) {
        continue;
      }

      const events = parseTranscriptFile(transcriptPath, stat);
      for (const ev of events) {
        if (ev.ts < cutoffWk) continue;
        if (!latestEventTs || ev.ts > latestEventTs) {
          latestEventTs = ev.ts;
        }

        if (ev.kind === 'command') {
          commandsWk++;
          if (ev.ts >= cutoffToday) commandsToday++;
          if (ev.ts >= cutoff5h) {
            commands5h++;
            if (!oldestEvent5h || ev.ts < oldestEvent5h) oldestEvent5h = ev.ts;
          }
        } else if (ev.kind === 'model') {
          stepsWk++;
          unitsWk += ev.units;

          if (syncData && ev.ts > syncData.syncedAt) {
            if (ev.ts >= cutoff5h) unitsSinceSync5h += ev.units;
            unitsSinceSyncWk += ev.units;
          }

          let mEntry = modelMap.get(ev.model);
          if (!mEntry) {
            mEntry = { steps5h: 0, stepsWk: 0, units5h: 0, unitsWk: 0 };
            modelMap.set(ev.model, mEntry);
          }
          mEntry.stepsWk++;
          mEntry.unitsWk += ev.units;

          if (ev.ts >= cutoff5h) {
            steps5h++;
            units5h += ev.units;
            mEntry.steps5h++;
            mEntry.units5h += ev.units;
            if (!oldestEvent5h || ev.ts < oldestEvent5h) oldestEvent5h = ev.ts;
          }
        }
      }
    }
  }

  const cfg = vscode.workspace.getConfiguration('antigravityUsage');
  const budget5h = Math.max(200000, Number(cfg.get('fiveHourBudgetUnits')) || 9000000);
  const budgetWk = Math.max(1000000, Number(cfg.get('weeklyBudgetUnits')) || 45000000);

  let pct5h = (units5h / budget5h) * 100;
  let pctWk = (unitsWk / budgetWk) * 100;
  let sourceMode = 'local';

  // Aplică ancora sincronizată manual din Settings -> Models (dacă nu a expirat fereastra)
  if (syncData && typeof syncData.syncedAt === 'number') {
    const elapsed = now - syncData.syncedAt;
    if (typeof syncData.pct5h === 'number' && elapsed < FIVE_HOURS_MS) {
      const decayFactor = Math.max(0, 1 - elapsed / FIVE_HOURS_MS);
      const anchoredBase = syncData.pct5h * decayFactor;
      const addedSinceSync = (unitsSinceSync5h / budget5h) * 100;
      pct5h = Math.max(pct5h * (1 - decayFactor), anchoredBase + addedSinceSync);
      sourceMode = 'synced';
    }
    if (typeof syncData.pctWk === 'number' && elapsed < ONE_WEEK_MS) {
      const decayWk = Math.max(0, 1 - elapsed / ONE_WEEK_MS);
      const anchoredWkBase = syncData.pctWk * decayWk;
      const addedWkSinceSync = (unitsSinceSyncWk / budgetWk) * 100;
      pctWk = Math.max(pctWk * (1 - decayWk), anchoredWkBase + addedWkSinceSync);
      sourceMode = 'synced';
    }
  }

  // Dacă există cache proaspăt din CLI statusLine oficial, îl folosim cu prioritate
  const cliQuota = tryReadCliStatuslineQuota();
  if (cliQuota) {
    for (const [bucket, info] of Object.entries(cliQuota.quota)) {
      if (!info || typeof info.remaining_fraction !== 'number') continue;
      const used = (1 - info.remaining_fraction) * 100;
      const b = bucket.toLowerCase();
      if (b.includes('gemini') && (b.includes('5h') || b.includes('hour') || b.includes('short'))) {
        pct5h = used;
        sourceMode = 'cli';
      } else if (b.includes('gemini') && b.includes('week')) {
        pctWk = used;
        sourceMode = 'cli';
      }
    }
  }

  pct5h = Math.min(100, Math.max(0, Math.round(pct5h)));
  pctWk = Math.min(100, Math.max(0, Math.round(pctWk)));

  // Când începe să se elibereze din fereastra rolling de 5h
  let nextReliefInMs = null;
  if (oldestEvent5h) {
    nextReliefInMs = Math.max(0, oldestEvent5h + FIVE_HOURS_MS - now);
  } else if (syncData && syncData.syncedAt && now - syncData.syncedAt < FIVE_HOURS_MS) {
    nextReliefInMs = Math.max(0, syncData.syncedAt + FIVE_HOURS_MS - now);
  }

  const models = Array.from(modelMap.entries())
    .map(([name, m]) => ({
      name,
      steps5h: m.steps5h,
      stepsWk: m.stepsWk,
      share5h: units5h > 0 ? Math.round((m.units5h / units5h) * 100) : 0,
      shareWk: unitsWk > 0 ? Math.round((m.unitsWk / unitsWk) * 100) : 0
    }))
    .sort((a, b) => b.stepsWk - a.stepsWk);

  return {
    pct5h,
    pctWk,
    units5h,
    unitsWk,
    budget5h,
    budgetWk,
    commands5h,
    commandsToday,
    commandsWk,
    steps5h,
    stepsWk,
    nextReliefInMs,
    latestEventTs,
    models,
    sourceMode,
    syncData
  };
}

function buildTooltip(stats) {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportThemeIcons = true;

  const bar = (pct) => {
    const filled = Math.round(pct / 10);
    return '█'.repeat(filled) + '░'.repeat(Math.max(0, 10 - filled));
  };

  const statusBadge =
    stats.pct5h >= 90
      ? '🔴 **Aproape de limită — ia o pauză sau schimbă pe Hydrogen**'
      : stats.pct5h >= 70
      ? '🟡 **Ritm ridicat — folosești intens fereastra de 5h**'
      : '🟢 **Ritm normal (Google AI Pro)**';

  md.appendMarkdown(`### $(sparkle) Antigravity / Gemini Pro Usage\n\n`);
  md.appendMarkdown(`${statusBadge}\n\n---\n\n`);

  const reliefText =
    stats.nextReliefInMs !== null && stats.pct5h > 0
      ? ` · se eliberează peste **${formatDurationShort(stats.nextReliefInMs)}**`
      : '';

  md.appendMarkdown(
    `**Ultimele 5 ore (\`5h\`):** \`${bar(stats.pct5h)}\` **${stats.pct5h}%** (${stats.commands5h} comenzi${reliefText})\n\n`
  );
  md.appendMarkdown(
    `**Ultimele 7 zile (\`wk\`):** \`${bar(stats.pctWk)}\` **${stats.pctWk}%** (${stats.commandsWk} comenzi · azi: ${stats.commandsToday})\n\n`
  );

  if (stats.models.length > 0) {
    md.appendMarkdown(`---\n**Modele folosite recent:**\n`);
    for (const m of stats.models.slice(0, 4)) {
      md.appendMarkdown(`- **${m.name}**: ${m.steps5h} pași (5h) · ${m.stepsWk} pași (7 zile)\n`);
    }
    md.appendMarkdown(`\n`);
  }

  if (stats.sourceMode === 'synced' && stats.syncData) {
    const ago = formatDurationShort(Date.now() - stats.syncData.syncedAt);
    md.appendMarkdown(`*$(check) Calibrat cu Settings acum ${ago}*\n\n`);
  } else {
    md.appendMarkdown(`*$(info) Estimat din activitatea locală VS Code*\n\n`);
  }

  md.appendMarkdown(
    `[$(sliders) Sincronizează %](command:antigravityUsage.syncPercentage) &nbsp;·&nbsp; ` +
      `[$(gear) Settings → Models](command:antigravityUsage.openOfficialSettings) &nbsp;·&nbsp; ` +
      `[$(graph) Panou](command:antigravityUsage.dashboard)`
  );

  return md;
}

function updateUI(context, silent = false) {
  if (!statusBarItem) return;

  const cfg = vscode.workspace.getConfiguration('antigravityUsage');
  const label = cfg.get('label');
  const warnThreshold = Number(cfg.get('warningThreshold')) || 70;
  const critThreshold = Number(cfg.get('criticalThreshold')) || 90;
  const notifyHigh = !silent && cfg.get('notifyOnHighUsage') !== false;

  const stats = collectUsageStats(context);
  const prefix = label ? `${label} ` : '';
  statusBarItem.text = `$(sparkle) ${prefix}5h ${stats.pct5h}% · wk ${stats.pctWk}%`;
  statusBarItem.tooltip = buildTooltip(stats);

  const maxPct = Math.max(stats.pct5h, stats.pctWk);
  if (maxPct >= critThreshold) {
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    if (notifyHigh && lastWarnedLevel !== 'crit') {
      lastWarnedLevel = 'crit';
      vscode.window
        .showWarningMessage(
          `Antigravity Pro: ai ajuns la ${stats.pct5h}% pe fereastra de 5h (${stats.commands5h} comenzi). Poți comuta pe Gemini 4 Hydrogen pentru comenzi ușoare.`,
          'Vezi Settings → Models'
        )
        .then((choice) => {
          if (choice) vscode.commands.executeCommand('antigravityUsage.openOfficialSettings');
        });
    }
  } else if (maxPct >= warnThreshold) {
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    if (notifyHigh && lastWarnedLevel === 'normal') {
      lastWarnedLevel = 'warn';
      vscode.window.showInformationMessage(
        `Antigravity Pro: ai trecut de ${maxPct}% usage (${stats.commands5h} comenzi în ultimele 5h).`
      );
    }
  } else {
    statusBarItem.backgroundColor = undefined;
    if (maxPct < warnThreshold - 10) {
      lastWarnedLevel = 'normal';
    }
  }

  statusBarItem.show();

  if (dashboardPanel) {
    dashboardPanel.webview.html = renderDashboardHtml(stats);
  }
}

function scheduleUpdate(context, delayMs = 1200) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => updateUI(context), delayMs);
}

async function openOfficialSettings() {
  try {
    await vscode.commands.executeCommand('antigravity.openSettings');
  } catch {
    vscode.window.showWarningMessage(
      'Nu am putut deschide automat Antigravity Settings. Verifică dacă extensia Google Antigravity este activă.'
    );
  }
}

async function syncPercentageFlow(context) {
  const stats = collectUsageStats(context);

  const modePick = await vscode.window.showQuickPick(
    [
      {
        label: '$(eye) Deschide întâi Antigravity Settings → Models și apoi introdu %',
        description: 'Deschide panoul oficial Antigravity ca să vezi bara de quota',
        action: 'open_then_input'
      },
      {
        label: '$(edit) Știu deja procentul — vreau să îl introduc acum',
        description: `Acum în bară: 5h ${stats.pct5h}% · wk ${stats.pctWk}%`,
        action: 'input_now'
      }
    ],
    {
      title: 'Sincronizează Usage-ul cu Antigravity Settings → Models',
      placeHolder: 'Alege cum vrei să sincronizezi procentul afișat în bară'
    }
  );

  if (!modePick) return;

  if (modePick.action === 'open_then_input') {
    await openOfficialSettings();
  }

  const kindPick = await vscode.window.showQuickPick(
    [
      {
        label: 'Procent CONSUMAT (ex: am folosit 25%)',
        description: '0% = neatins, 100% = limită atinsă (la fel ca bara de Claude)',
        mode: 'used'
      },
      {
        label: 'Procent RĂMAS / REMAINING (ex: mai am 75% disponibil → 25% folosit)',
        description: 'Dacă în Settings scrie cât mai ai disponibil, scadem automat din 100%',
        mode: 'remaining'
      }
    ],
    {
      title: 'Cum este exprimat procentul pe care îl vezi?',
      placeHolder: 'Alege ca să nu faci calcule în minte'
    }
  );

  if (!kindPick) return;

  const input5h = await vscode.window.showInputBox({
    title: 'Procentul pe fereastra de 5 ore (5h)',
    prompt:
      kindPick.mode === 'used'
        ? 'Cât % ai CONSUMAT pe 5h? (0 - 100)'
        : 'Cât % mai ai RĂMAS / DISPONIBIL pe 5h? (0 - 100)',
    value: kindPick.mode === 'used' ? String(stats.pct5h) : String(100 - stats.pct5h),
    validateInput: (val) => {
      const n = Number(val.replace('%', '').trim());
      if (Number.isNaN(n) || n < 0 || n > 100) return 'Introdu un număr între 0 și 100';
      return null;
    }
  });

  if (input5h === undefined) return;
  const raw5h = Number(input5h.replace('%', '').trim());
  const used5h = kindPick.mode === 'used' ? raw5h : 100 - raw5h;

  const inputWk = await vscode.window.showInputBox({
    title: 'Procentul săptămânal (wk) — opțional',
    prompt:
      kindPick.mode === 'used'
        ? 'Cât % ai CONSUMAT pe săptămână? (Apasă Enter gol dacă vrei să păstrezi estimarea actuală)'
        : 'Cât % mai ai RĂMAS pe săptămână? (Apasă Enter gol dacă vrei să păstrezi estimarea actuală)',
    placeHolder: 'Lasă gol pentru a păstra valoarea curentă',
    validateInput: (val) => {
      if (!val.trim()) return null;
      const n = Number(val.replace('%', '').trim());
      if (Number.isNaN(n) || n < 0 || n > 100) return 'Introdu un număr între 0 și 100 sau lasă gol';
      return null;
    }
  });

  if (inputWk === undefined) return;
  let usedWk = null;
  if (inputWk.trim() !== '') {
    const rawWk = Number(inputWk.replace('%', '').trim());
    usedWk = kindPick.mode === 'used' ? rawWk : 100 - rawWk;
  }

  // Dacă avem activitate locală semnificativă în ultimele 5h și utilizatorul a folosit >= 10%,
  // calibrăm automat și plafonul de 5h ca viitoarele comenzi să urce proporțional cu contul lui!
  const cfg = vscode.workspace.getConfiguration('antigravityUsage');
  if (used5h >= 5 && stats.units5h > 100000) {
    const calibrated5h = Math.round(stats.units5h / (used5h / 100));
    if (calibrated5h >= 500000 && calibrated5h <= 150000000) {
      await cfg.update('fiveHourBudgetUnits', calibrated5h, vscode.ConfigurationTarget.Global);
    }
  }
  if (usedWk !== null && usedWk >= 5 && stats.unitsWk > 200000) {
    const calibratedWk = Math.round(stats.unitsWk / (usedWk / 100));
    if (calibratedWk >= 2000000 && calibratedWk <= 500000000) {
      await cfg.update('weeklyBudgetUnits', calibratedWk, vscode.ConfigurationTarget.Global);
    }
  }

  await context.globalState.update('syncAnchor', {
    syncedAt: Date.now(),
    pct5h: used5h,
    pctWk: usedWk
  });

  updateUI(context);
  vscode.window.showInformationMessage(
    `Antigravity Usage sincronizat: 5h ${Math.round(used5h)}%${usedWk !== null ? ` · wk ${Math.round(usedWk)}%` : ''}. Noile comenzi din VS Code se vor adăuga automat peste acest prag!`
  );
}

function renderDashboardHtml(stats) {
  const colorFor = (pct) =>
    pct >= 90 ? '#f14c4c' : pct >= 70 ? '#cca700' : '#3fb950';

  const reliefStr =
    stats.nextReliefInMs !== null && stats.pct5h > 0
      ? `Capacitatea începe să se elibereze peste <b>${formatDurationShort(stats.nextReliefInMs)}</b>`
      : 'Nicio comandă activă în ultimele 5 ore';

  const modelRows =
    stats.models.length > 0
      ? stats.models
          .map(
            (m) => `
          <tr>
            <td><b>${m.name}</b></td>
            <td>${m.steps5h} pași (${m.share5h}%)</td>
            <td>${m.stepsWk} pași (${m.shareWk}%)</td>
          </tr>`
          )
          .join('')
      : `<tr><td colspan="3" style="opacity:0.7">Nicio activitate înregistrată încă în ultimele 7 zile.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="UTF-8" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 24px;
      max-width: 720px;
      margin: 0 auto;
    }
    h2 { margin-top: 0; display: flex; align-items: center; gap: 8px; }
    .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 20px 0; }
    .card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
      border-radius: 8px;
      padding: 16px;
    }
    .card-title { font-size: 13px; opacity: 0.8; margin-bottom: 6px; }
    .big-pct { font-size: 32px; font-weight: 700; margin-bottom: 10px; }
    .bar-bg {
      width: 100%; height: 10px; border-radius: 5px;
      background: rgba(128,128,128,0.25); overflow: hidden; margin-bottom: 10px;
    }
    .bar-fill { height: 100%; border-radius: 5px; transition: width 0.3s ease; }
    .sub { font-size: 12px; opacity: 0.8; line-height: 1.5; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td {
      text-align: left; padding: 10px 8px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      font-size: 13px;
    }
    th { opacity: 0.75; font-weight: 600; }
    .actions { display: flex; gap: 10px; margin-top: 22px; flex-wrap: wrap; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px; padding: 8px 14px;
      cursor: pointer; font-size: 13px;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button:hover { opacity: 0.9; }
    .tip {
      margin-top: 20px; padding: 12px 14px; border-radius: 6px;
      background: rgba(128,128,128,0.12); font-size: 12.5px; line-height: 1.5;
    }
  </style>
</head>
<body>
  <h2>✦ Antigravity / Gemini Pro — Monitor Usage</h2>
  <div class="cards">
    <div class="card">
      <div class="card-title">Fereastra de 5 ore (5h)</div>
      <div class="big-pct" style="color:${colorFor(stats.pct5h)}">${stats.pct5h}%</div>
      <div class="bar-bg"><div class="bar-fill" style="width:${stats.pct5h}%;background:${colorFor(stats.pct5h)}"></div></div>
      <div class="sub">
        <b>${stats.commands5h}</b> comenzi trimise · <b>${stats.steps5h}</b> pași agent<br/>
        ${reliefStr}
      </div>
    </div>
    <div class="card">
      <div class="card-title">Fereastra săptămânală (wk · 7 zile)</div>
      <div class="big-pct" style="color:${colorFor(stats.pctWk)}">${stats.pctWk}%</div>
      <div class="bar-bg"><div class="bar-fill" style="width:${stats.pctWk}%;background:${colorFor(stats.pctWk)}"></div></div>
      <div class="sub">
        <b>${stats.commandsWk}</b> comenzi în 7 zile · <b>${stats.commandsToday}</b> comenzi azi<br/>
        <b>${stats.stepsWk}</b> pași agent în total săptămâna asta
      </div>
    </div>
  </div>

  <h3>Activitate pe modele</h3>
  <table>
    <thead>
      <tr><th>Model</th><th>Ultimele 5 ore</th><th>Ultimele 7 zile</th></tr>
    </thead>
    <tbody>${modelRows}</tbody>
  </table>

  <div class="actions">
    <button onclick="send('sync')">Sincronizează % cu Settings → Models</button>
    <button class="secondary" onclick="send('settings')">Deschide Antigravity Settings</button>
    <button class="secondary" onclick="send('refresh')">Reîmprospătează</button>
  </div>

  <div class="tip">
    <b>Cum să ții usage-ul sub control pe Google AI Pro:</b><br/>
    • Modelele grele (<b>Gemini 4 Carbon / Neon</b>) consumă mai mult per comandă — ideale pentru arhitectură și bug-uri grele.<br/>
    • Pentru editări rapide sau întrebări scurte, comută pe <b>Gemini 4 Hydrogen</b> sau <b>Orchestrator</b>.<br/>
    • Dacă verifici procentul oficial în <i>Antigravity Settings → Models</i> și apeși o dată pe <b>Sincronizează %</b>, bara se calibrează automat pe ritmul contului tău Pro.
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function send(cmd) { vscode.postMessage({ command: cmd }); }
  </script>
</body>
</html>`;
}

function openDashboard(context) {
  const stats = collectUsageStats(context);
  if (dashboardPanel) {
    dashboardPanel.reveal(vscode.ViewColumn.One);
    dashboardPanel.webview.html = renderDashboardHtml(stats);
    return;
  }

  dashboardPanel = vscode.window.createWebviewPanel(
    'antigravityUsageDashboard',
    'Antigravity Pro Usage',
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  dashboardPanel.webview.html = renderDashboardHtml(stats);
  dashboardPanel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.command === 'sync') {
      await vscode.commands.executeCommand('antigravityUsage.syncPercentage');
    } else if (msg.command === 'settings') {
      await vscode.commands.executeCommand('antigravityUsage.openOfficialSettings');
    } else if (msg.command === 'refresh') {
      updateUI(context);
    }
  });

  dashboardPanel.onDidDispose(() => {
    dashboardPanel = undefined;
  });
}

async function showQuickMenu(context) {
  const stats = collectUsageStats(context);
  const items = [
    {
      label: '$(graph) Vezi Panoul Detaliat de Usage',
      description: `5h: ${stats.pct5h}% (${stats.commands5h} comenzi) · wk: ${stats.pctWk}% (${stats.commandsWk} comenzi)`,
      action: 'dashboard'
    },
    {
      label: '$(sliders) Sincronizează % cu Antigravity Settings → Models',
      description: 'Aliniază procentul din bară cu cel oficial din Settings în 5 secunde',
      action: 'sync'
    },
    {
      label: '$(gear) Deschide Antigravity Settings (Models)',
      description: 'Vezi pagina oficială Google Antigravity din VS Code',
      action: 'official_settings'
    },
    {
      label: '$(refresh) Reîmprospătează Acum',
      description: 'Recalculează din conversațiile recente',
      action: 'refresh'
    }
  ];

  if (stats.syncData) {
    items.push({
      label: '$(clear-all) Șterge sincronizarea manuală',
      description: 'Revino doar la estimarea automată din logurile locale',
      action: 'reset_sync'
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `Antigravity / Gemini Pro — 5h ${stats.pct5h}% · wk ${stats.pctWk}%`,
    placeHolder: 'Alege o acțiune'
  });

  if (!picked) return;
  if (picked.action === 'dashboard') openDashboard(context);
  else if (picked.action === 'sync') await syncPercentageFlow(context);
  else if (picked.action === 'official_settings') await openOfficialSettings();
  else if (picked.action === 'refresh') updateUI(context);
  else if (picked.action === 'reset_sync') {
    await context.globalState.update('syncAnchor', null);
    updateUI(context);
    vscode.window.showInformationMessage('Sincronizarea manuală a fost resetată.');
  }
}

function createBarItem(context) {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  const cfg = vscode.workspace.getConfiguration('antigravityUsage');
  const priority = Number(cfg.get('statusBarPriority')) || 101;
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority);
  statusBarItem.command = 'antigravityUsage.menu';
  context.subscriptions.push(statusBarItem);
}

function setupWatchers(context) {
  const agyDir = getAntigravityDir();
  const brainDir = path.join(agyDir, 'brain');

  try {
    const pattern = new vscode.RelativePattern(vscode.Uri.file(brainDir), '*/*/*/transcript.jsonl');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(() => scheduleUpdate(context, 1000));
    watcher.onDidCreate(() => scheduleUpdate(context, 1000));
    watcher.onDidDelete(() => scheduleUpdate(context, 1000));
    context.subscriptions.push(watcher);
  } catch {
    // Polling-ul periodic acoperă orice caz în care folderul nu există încă
  }

  pollTimer = setInterval(() => updateUI(context), 20000);
  context.subscriptions.push({ dispose: () => pollTimer && clearInterval(pollTimer) });

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) scheduleUpdate(context, 500);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravityUsage')) {
        if (e.affectsConfiguration('antigravityUsage.statusBarPriority')) {
          createBarItem(context);
        }
        updateUI(context);
      }
    })
  );
}

function activate(context) {
  createBarItem(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityUsage.menu', () => showQuickMenu(context)),
    vscode.commands.registerCommand('antigravityUsage.dashboard', () => openDashboard(context)),
    vscode.commands.registerCommand('antigravityUsage.syncPercentage', () => syncPercentageFlow(context)),
    vscode.commands.registerCommand('antigravityUsage.openOfficialSettings', () => openOfficialSettings()),
    vscode.commands.registerCommand('antigravityUsage.refresh', () => updateUI(context)),
    vscode.commands.registerCommand('antigravityUsage.resetSync', async () => {
      await context.globalState.update('syncAnchor', null);
      updateUI(context);
      vscode.window.showInformationMessage('Calibrarea manuală a fost resetată.');
    })
  );

  setupWatchers(context);
  updateUI(context, true);
}

function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
}

module.exports = { activate, deactivate };
