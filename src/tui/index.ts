import blessed from 'blessed';
import contrib from 'blessed-contrib';

const serverUrl = 'http://localhost:3000';

const screen = blessed.screen({
  smartCSR: true,
  title: 'AI Router',
  fullUnicode: true
});

// ══════════════════════════════════════════
//  Page 1: Dashboard
// ══════════════════════════════════════════

const dashPage = blessed.box({
  top: 0, left: 0, width: '100%', height: '100%'
});
screen.append(dashPage);

const dashGrid = new contrib.grid({ rows: 12, cols: 12, screen: dashPage as any });

const hintBox = dashGrid.set(0, 0, 2, 12, blessed.box, {
  label: ' AI Router ',
  content: '',
  tags: true,
  valign: 'middle',
  border: { type: 'line', fg: '#555555' } as any,
  style: { fg: '#999999', border: { fg: '#555555' }, label: { fg: '#cccccc' } },
  padding: { left: 2 }
});

function renderHint(): void {
  const s = currentRouting.strategy ?? 'load-balance';
  const def = currentRouting.defaultUpstream ?? '-';
  const stratLabel = s === 'manual' ? `${s} → ${def}` : s;
  hintBox.setContent(
    `[↑↓] select   [a] add   [e] edit   [t] toggle   [d] delete   [m] measure   [r] routing   [q] quit\n` +
    `{gray-fg}routing: ${stratLabel}{/}`
  );
  screen.render();
}

const upstreamTable = dashGrid.set(2, 0, 7, 12, contrib.table, {
  keys: true,
  tags: true,
  fg: '#cccccc',
  selectedBg: '#333333',
  selectedFg: '#ffffff',
  label: ' Upstreams ',
  columnSpacing: 2,
  columnWidth: [22, 24, 10, 8, 10, 10],
  border: { type: 'line', fg: '#555555' },
  style: {
    border: { fg: '#555555' },
    header: { fg: '#999999', bold: true },
    cell: { fg: '#cccccc' },
    label: { fg: '#cccccc' }
  }
});

const activityBox = dashGrid.set(9, 0, 3, 12, blessed.box, {
  label: ' Activity ',
  tags: true,
  border: { type: 'line', fg: '#555555' } as any,
  style: { fg: '#aaaaaa', border: { fg: '#555555' }, label: { fg: '#cccccc' } },
  padding: { left: 1 }
});

// ══════════════════════════════════════════
//  Page 2: Full-screen Form (Add / Edit)
// ══════════════════════════════════════════

type FormMode = 'add' | 'edit';

interface FormState {
  mode: FormMode;
  editName: string;
  fields: { key: string; label: string; value: string; hint?: string; options?: string[] }[];
  activeField: number;
  editing: boolean;
}

const form: FormState = {
  mode: 'add',
  editName: '',
  fields: [],
  activeField: 0,
  editing: false
};

let submitting = false;

const formPage = blessed.box({
  top: 0, left: 0, width: '100%', height: '100%',
  hidden: true
});
screen.append(formPage);

const formTitle = blessed.box({
  parent: formPage,
  top: 0, left: 0, width: '100%', height: 3,
  tags: true,
  style: { fg: '#cccccc' },
  border: { type: 'line', fg: '#555555' } as any,
  padding: { left: 1 }
});

const formBody = blessed.box({
  parent: formPage,
  top: 3, left: 0, width: '100%', height: '100%-6',
  tags: true,
  keys: true,
  keyable: true,
  style: { fg: '#cccccc' },
  padding: { left: 1 }
});

const formHint = blessed.box({
  parent: formPage,
  bottom: 0, left: 0, width: '100%', height: 3,
  tags: true,
  content: '{center}{gray-fg}[↑↓] navigate   [Enter] edit / submit   [Esc] cancel / back{/gray-fg}{/center}',
  style: { fg: '#888888' },
  border: { type: 'line', fg: '#555555' } as any
});

const formInput = blessed.textbox({
  parent: formPage,
  top: 5, left: 20, width: '50%', height: 3,
  style: { bg: '#333333', fg: '#ffffff', focus: { bg: '#444444' } },
  inputOnFocus: false,
  hidden: true,
  border: { type: 'line', fg: '#555555' } as any
});

// ══════════════════════════════════════════
//  Page Management
// ══════════════════════════════════════════

let currentPage: 'dash' | 'form' = 'dash';

function showDash(): void {
  formPage.hide();
  dashPage.show();
  currentPage = 'dash';
  upstreamTable.focus();
  screen.render();
}

function showForm(mode: FormMode, upstream?: any): void {
  form.mode = mode;
  form.activeField = 0;
  form.editing = false;

  if (mode === 'add') {
    form.editName = '';
    form.fields = [
      { key: 'name', label: 'Name', value: '', hint: 'Unique identifier' },
      { key: 'type', label: 'Type', value: 'openai', hint: 'Enter to choose', options: ['openai', 'anthropic'] },
      { key: 'baseurl', label: 'Base URL', value: '', hint: 'e.g. https://api.openai.com' },
      { key: 'key', label: 'API Key', value: '', hint: 'sk-...' },
      { key: 'model', label: 'Model', value: '', hint: 'e.g. gpt-4o or claude-sonnet-4-5-20250929' },
      { key: 'group', label: 'Group', value: '', hint: 'logical group, e.g. glm / claude' },
      { key: 'weight', label: 'Weight', value: '1', hint: '1-10' },
      { key: 'authStyle', label: 'Auth Style', value: '(default)', hint: 'Enter to choose', options: ['(default)', 'x-api-key', 'bearer'] },
    ];
  } else {
    form.editName = upstream.name;
    form.fields = [
      { key: 'name', label: 'Name', value: upstream.name, hint: 'Change to rename' },
      { key: 'type', label: 'Type', value: upstream.type || 'openai', hint: 'Enter to choose', options: ['openai', 'anthropic'] },
      { key: 'baseurl', label: 'Base URL', value: upstream.baseurl || '' },
      { key: 'key', label: 'API Key', value: '', hint: 'Leave empty to keep current' },
      { key: 'model', label: 'Model', value: upstream.model || '', hint: 'Bound model id' },
      { key: 'group', label: 'Group', value: upstream.group || '', hint: 'logical group, e.g. glm / claude' },
      { key: 'weight', label: 'Weight', value: String(upstream.weight || 1), hint: '1-10' },
      { key: 'authStyle', label: 'Auth Style', value: upstream.authStyle || '(default)', hint: 'Enter to choose', options: ['(default)', 'x-api-key', 'bearer'] },
    ];
  }

  dashPage.hide();
  formPage.show();
  currentPage = 'form';
  renderForm();
  formBody.focus();
  screen.render();
}

function renderForm(): void {
  const title = form.mode === 'add'
    ? '{bold}+ Add Upstream{/bold}'
    : `{bold}Edit: ${form.editName}{/bold}`;
  formTitle.setContent(title);

  const lines: string[] = [''];
  const submitIdx = form.fields.length;

  for (let i = 0; i < form.fields.length; i++) {
    const f = form.fields[i];
    const selected = i === form.activeField;
    const pointer = selected ? '▸' : ' ';
    const labelPad = f.label.padEnd(12);

    let display = f.value || '{gray-fg}(empty){/gray-fg}';
    if (f.key === 'key' && f.value) {
      display = '***set***';
    }

    const hint = f.hint ? `  {gray-fg}${f.hint}{/gray-fg}` : '';

    if (selected) {
      lines.push(` ${pointer} {bold}{white-fg}${labelPad}{/white-fg}{/bold}  ${display}${hint}`);
    } else {
      lines.push(` ${pointer} {gray-fg}${labelPad}{/gray-fg}  ${display}${hint}`);
    }
    lines.push('');
  }

  const submitSelected = form.activeField === submitIdx;
  if (submitSelected) {
    lines.push(` ▸ {bold}[ Submit ]{/bold}`);
  } else {
    lines.push(`   [ Submit ]`);
  }

  formBody.setContent(lines.join('\n'));
  screen.render();
}

function formNavigate(dir: number): void {
  if (form.editing) return;
  const max = form.fields.length; // fields.length = last is submit button
  form.activeField = Math.max(0, Math.min(max, form.activeField + dir));
  renderForm();
}

function formEnter(): void {
  if (form.editing || submitting) return;

  if (form.activeField === form.fields.length) {
    submitting = true;
    submitFormData().finally(() => { submitting = false; });
    return;
  }

  const field = form.fields[form.activeField];
  form.editing = true;

  if (field.options) {
    const fieldIdx = form.activeField;
    openListPicker({
      title: field.label,
      items: field.options,
      selected: field.value,
      onPick: (value) => {
        form.fields[fieldIdx].value = value;
        if (fieldIdx < form.fields.length) {
          form.activeField = fieldIdx + 1;
        }
        process.nextTick(() => {
          form.editing = false;
          formBody.focus();
          renderForm();
        });
      },
      onCancel: () => {
        process.nextTick(() => {
          form.editing = false;
          formBody.focus();
          renderForm();
        });
      }
    });
    return;
  }

  const row = 1 + form.activeField * 2;
  formInput.top = 3 + row;
  formInput.left = 18;
  formInput.setValue(field.value);
  formInput.show();
  screen.render();

  // readInput with callback: Enter → value string, Escape → null
  (formInput.readInput as any)((_err: any, value: string | null) => {
    const submitted = value != null;
    if (submitted) {
      form.fields[form.activeField].value = (value || '').trim();
      if (form.activeField < form.fields.length) {
        form.activeField++;
      }
    }
    formInput.hide();
    // Defer state reset so screen-level handlers in same tick still see editing=true
    process.nextTick(() => {
      form.editing = false;
      formBody.focus();
      renderForm();
    });
  });
}

async function submitFormData(): Promise<void> {
  if (form.mode === 'add') {
    const vals: Record<string, string> = {};
    for (const f of form.fields) vals[f.key] = f.value;

    if (!vals.name) { log('{bold}✗ Name required{/bold}'); return; }
    if (!vals.baseurl) { log('{bold}✗ Base URL required{/bold}'); return; }
    if (!vals.key) { log('{bold}✗ API Key required{/bold}'); return; }
    if (!vals.model) { log('{bold}✗ Model required{/bold}'); return; }
    if (vals.type !== 'openai' && vals.type !== 'anthropic') {
      log('{bold}✗ Type must be openai or anthropic{/bold}'); return;
    }

    const authStyleRaw = vals.authStyle;
    const authStyle = (!authStyleRaw || authStyleRaw === '(default)') ? undefined : authStyleRaw;

    log('{gray-fg}Adding upstream...{/gray-fg}');
    const ok = await addUpstreamAPI({
      name: vals.name, type: vals.type,
      baseurl: vals.baseurl, key: vals.key,
      model: vals.model,
      group: vals.group || undefined,
      weight: parseInt(vals.weight) || 1,
      authStyle
    });
    if (ok) {
      await autoSave();
      showDash();
      await refresh();
    }
  } else {
    const updates: Record<string, any> = {};
    for (const f of form.fields) {
      if (f.key === 'key' && !f.value) continue;
      if (f.key === 'authStyle') {
        if (!f.value || f.value === '(default)') continue;
        updates.authStyle = f.value;
        continue;
      }
      if (f.key === 'weight') {
        updates[f.key] = parseInt(f.value) || 1;
      } else {
        updates[f.key] = f.value;
      }
    }

    log(`{gray-fg}Updating "${form.editName}"...{/gray-fg}`);
    const ok = await updateUpstreamAPI(form.editName, updates);
    if (ok) {
      await autoSave();
      showDash();
      await refresh();
    }
  }
}

// Form key bindings — on screen level so they always fire
screen.key(['up'], () => {
  if (currentPage === 'form' && !form.editing) formNavigate(-1);
});
screen.key(['down'], () => {
  if (currentPage === 'form' && !form.editing) formNavigate(1);
});
screen.key(['escape'], () => {
  if (currentPage !== 'form') return;
  // When editing, readInput handles Escape internally via its callback
  if (!form.editing) {
    showDash();
  }
});

// ══════════════════════════════════════════
//  API Functions
// ══════════════════════════════════════════

async function fetchUpstreams(): Promise<any[]> {
  try {
    const response = await fetch(`${serverUrl}/admin/upstreams`);
    const data = await response.json() as any;
    return data.upstreams || [];
  } catch (err: any) {
    if (err?.cause?.code === 'ECONNREFUSED' || String(err).includes('fetch failed')) {
      log(`{bold}✗ Cannot connect to ${serverUrl}. Start server first: npm run dev{/bold}`);
    } else {
      log(`{bold}Error: ${err}{/bold}`);
    }
    return [];
  }
}


async function fetchUpstreamConfig(name: string): Promise<any> {
  try {
    const res = await fetch(`${serverUrl}/admin/upstreams/${encodeURIComponent(name)}/config`);
    const data = await res.json() as any;
    return data.upstream;
  } catch (err) {
    log(`{bold}Error: ${err}{/bold}`);
    return null;
  }
}

async function addUpstreamAPI(data: { name: string; type: string; baseurl: string; key: string; model: string; group?: string; weight: number; authStyle?: string }): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/admin/upstreams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, enabled: true })
    });
    const result = await response.json() as any;
    if (response.ok) {
      log(`✓ Added "${data.name}"`);
      return true;
    } else {
      log(`{bold}✗ ${result.error}{/bold}`);
      return false;
    }
  } catch (err: any) {
    if (err?.cause?.code === 'ECONNREFUSED' || String(err).includes('fetch failed')) {
      log(`{bold}✗ Server not reachable (${serverUrl}). Run: npm run dev{/bold}`);
    } else {
      log(`{bold}✗ Error: ${err}{/bold}`);
    }
    return false;
  }
}

async function updateUpstreamAPI(name: string, updates: Record<string, any>): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/admin/upstreams/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const result = await response.json() as any;
    if (response.ok) {
      log(`✓ Updated "${name}"`);
      return true;
    } else {
      log(`{bold}✗ ${result.error}{/bold}`);
      return false;
    }
  } catch (err) {
    log(`{bold}✗ Error: ${err}{/bold}`);
    return false;
  }
}

async function deleteUpstream(name: string): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/admin/upstreams/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (response.ok) {
      log(`✓ Deleted "${name}"`);
      return true;
    }
    return false;
  } catch (err) {
    return false;
  }
}


async function autoSave(): Promise<void> {
  try {
    await fetch(`${serverUrl}/admin/config/save`, { method: 'POST' });
    log('{gray-fg}Auto-saved{/gray-fg}');
  } catch (_) {}
}

async function toggleUpstream(name: string, enable: boolean): Promise<void> {
  try {
    const action = enable ? 'enable' : 'disable';
    await fetch(`${serverUrl}/admin/upstreams/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
    log(`✓ ${action}d "${name}"`);
  } catch (err) {
    log(`{bold}✗ Error: ${err}{/bold}`);
  }
}

async function measureLatency(name: string): Promise<void> {
  try {
    log(`{gray-fg}Measuring "${name}"...{/gray-fg}`);
    const response = await fetch(`${serverUrl}/admin/upstreams/${encodeURIComponent(name)}/measure`, { method: 'POST' });
    const data = await response.json() as any;
    if (response.ok) {
      log(`✓ "${name}": ${data.latencyMs}ms`);
    } else {
      log(`{bold}✗ Measure failed: ${data.error || 'unknown'}{/bold}`);
    }
  } catch (err: any) {
    log(`{bold}✗ Measure error: ${err?.message || err}{/bold}`);
  }
}

// ─── Routing config ─────────────────────────────────────────────

const currentRouting: { strategy?: string; defaultUpstream?: string } = {};

async function fetchRouting(): Promise<void> {
  try {
    const r = await fetch(`${serverUrl}/admin/routing`);
    const data = await r.json() as any;
    currentRouting.strategy = data.strategy;
    currentRouting.defaultUpstream = data.config?.defaultUpstream;
  } catch { /* keep stale */ }
}

async function setStrategyAPI(strategy: string): Promise<boolean> {
  try {
    const r = await fetch(`${serverUrl}/admin/routing/strategy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy })
    });
    return r.ok;
  } catch { return false; }
}

async function setDefaultUpstreamAPI(name: string | null): Promise<boolean> {
  try {
    const r = await fetch(`${serverUrl}/admin/routing/default-upstream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    return r.ok;
  } catch { return false; }
}

// ══════════════════════════════════════════
//  Dashboard Rendering
// ══════════════════════════════════════════

let cachedUpstreams: any[] = [];

// log() used to write to the Activity Log panel, which is now the Activity chart.
// Transient messages are dropped — keep the function as a no-op stub so the rest
// of the TUI still compiles and runs.
function log(_msg: string): void { /* no-op */ }

function formatLatency(ms: number): string {
  if (!ms || ms <= 0) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

async function refresh(): Promise<void> {
  cachedUpstreams = await fetchUpstreams();
  upstreamTable.setData({
    headers: ['Name', 'Model', 'Group', 'Weight', 'Latency', 'Avg'],
    data: cachedUpstreams.map((u: any) => [
      // Plain glyph: contrib.table measures column width by raw char count,
      // so blessed color tags inside cells break header/data alignment.
      `${u.enabled ? '●' : '○'} ${u.name}`,
      u.model ?? '-',
      u.group ?? '-',
      String(u.weight ?? 1),
      formatLatency(u.latencyMs),
      formatLatency(u.avgLatencyMs),
    ])
  });
  screen.render();
}

// ─── Activity chart ─────────────────────────────────────────────

const ACTIVITY_COLORS = ['yellow', 'cyan', 'magenta', 'green', 'red', 'blue', 'white'];

function colorForUpstream(name: string, names: string[]): string {
  const idx = names.indexOf(name);
  return ACTIVITY_COLORS[(idx >= 0 ? idx : 0) % ACTIVITY_COLORS.length];
}

function niceUnit(maxValue: number, targetBlocks: number): number {
  if (maxValue <= 0 || targetBlocks <= 0) return 1000;
  const raw = maxValue / targetBlocks;
  const candidates = [
    1, 2, 5,
    10, 20, 50,
    100, 200, 500,
    1_000, 2_000, 5_000,
    10_000, 20_000, 50_000,
    100_000, 200_000, 500_000
  ];
  for (const n of candidates) if (n >= raw) return n;
  return candidates[candidates.length - 1];
}

function formatUnit(n: number): string {
  if (n >= 1000) return `${n / 1000}k`;
  return String(n);
}

interface ActivityData {
  bucketSeconds: number;
  now: number;
  buckets: Array<{ ts: number; values: Record<string, { input: number; output: number }> }>;
}

async function fetchActivity(): Promise<ActivityData | null> {
  try {
    const r = await fetch(`${serverUrl}/admin/activity`);
    return await r.json() as ActivityData;
  } catch {
    return null;
  }
}

function renderActivity(data: ActivityData): void {
  // Use computed dimensions from blessed; the values are populated after layout.
  const totalW = Math.max(20, Number((activityBox as any).width) || 80);
  const totalH = Math.max(8, Number((activityBox as any).height) || 12);

  // Subtract border (2) + label row + padding-left (1)
  const innerW = totalW - 2 - 1;
  const innerH = totalH - 2;

  // Reserve top row for legend, bottom row for time axis, separator above axis.
  const titleRows = 1;
  const axisRows = 1;
  const chartH = Math.max(2, innerH - titleRows - axisRows);
  const colCount = Math.max(10, innerW);

  // Stable upstream order from current upstream list. Falls back to keys in data.
  const upstreamNames = (cachedUpstreams.length > 0
    ? cachedUpstreams.map((u: any) => u.name)
    : Array.from(new Set(data.buckets.flatMap(b => Object.keys(b.values))))
  );

  // Map bucket ts → values for fast lookup. Build a continuous time grid:
  // newest column = newest 10s window; older to the left.
  const valuesByTs = new Map<number, Record<string, { input: number; output: number }>>();
  for (const b of data.buckets) valuesByTs.set(b.ts, b.values);

  const bucketSec = data.bucketSeconds;
  const nowBucket = Math.floor(data.now / bucketSec) * bucketSec;
  const columnTs: number[] = [];
  for (let i = colCount - 1; i >= 0; i--) {
    columnTs.push(nowBucket - i * bucketSec);
  }

  // Find max bucket total for auto-scaling
  let maxTotal = 0;
  for (const ts of columnTs) {
    const v = valuesByTs.get(ts);
    if (!v) continue;
    let total = 0;
    for (const u of Object.values(v)) total += u.input + u.output;
    if (total > maxTotal) maxTotal = total;
  }
  // Each character cell is a 2×4 Braille grid → 4 vertical levels per cell.
  // 1 level = `unit` tokens. niceUnit picks unit so max ≈ chartH×4 levels.
  const LEVELS_PER_CELL = 4;
  // Braille glyphs: index = number of bottom levels filled (0..4).
  const BRAILLE_BARS = [' ', '⣀', '⣤', '⣶', '⣿'];
  const totalLevels = chartH * LEVELS_PER_CELL;
  const unit = niceUnit(maxTotal, totalLevels);

  // Build chart grid (rows × cols). Top row is rendered first. Each cell is a
  // ready-to-print string (possibly with blessed color tags).
  const grid: string[][] = Array.from({ length: chartH }, () => Array(colCount).fill(' '));
  for (let col = 0; col < colCount; col++) {
    const ts = columnTs[col];
    const v = valuesByTs.get(ts);
    if (!v) continue;
    let cellRow = chartH - 1;
    for (const name of upstreamNames) {
      const usage = v[name];
      if (!usage) continue;
      const total = usage.input + usage.output;
      if (total <= 0) continue;
      let levels = Math.max(1, Math.round(total / unit));
      const color = colorForUpstream(name, upstreamNames);
      while (levels > 0 && cellRow >= 0) {
        const inCell = Math.min(levels, LEVELS_PER_CELL);
        grid[cellRow][col] = `{${color}-fg}${BRAILLE_BARS[inCell]}{/}`;
        cellRow--;
        levels -= inCell;
      }
    }
  }

  // Title / legend line — full-cell glyph as the swatch.
  const legend = upstreamNames
    .map(n => `{${colorForUpstream(n, upstreamNames)}-fg}⣿{/} ${n}`)
    .join('  ');
  const title = `1 dot = ${formatUnit(unit)} tok    ${legend}`;

  // Time axis labels: every K columns, mark "Ns ago" label, right-anchored at "now".
  // Spacing: aim for one label every ~10 columns.
  const labelEvery = Math.max(6, Math.floor(colCount / 8));
  const axisChars = Array<string>(colCount).fill(' ');
  for (let col = colCount - 1; col >= 0; col--) {
    const i = colCount - 1 - col;
    if (i === 0) {
      // Right-most position: "now"
      const label = 'now';
      for (let k = 0; k < label.length && col + k < colCount; k++) {
        axisChars[col + k] = label[k];
      }
    } else if (i % labelEvery === 0) {
      const sec = i * bucketSec;
      const label = sec >= 60 ? `${Math.floor(sec / 60)}m` : `${sec}s`;
      // anchor label so that its right edge is at this column
      const start = col - label.length + 1;
      for (let k = 0; k < label.length; k++) {
        const c = start + k;
        if (c >= 0 && c < colCount) axisChars[c] = label[k];
      }
    }
  }
  const axisLine = `{gray-fg}${axisChars.join('')}{/}`;

  const lines = [title, ...grid.map(r => r.join('')), axisLine];
  activityBox.setContent(lines.join('\n'));
  screen.render();
}

async function refreshActivity(): Promise<void> {
  const data = await fetchActivity();
  if (!data) return;
  renderActivity(data);
}

function getSelectedUpstream(): any | null {
  const idx = (upstreamTable as any).rows?.selected ?? -1;
  return cachedUpstreams[idx] || null;
}

// ══════════════════════════════════════════
//  Dashboard Key Bindings
// ══════════════════════════════════════════

screen.key(['q', 'C-c'], () => process.exit(0));

screen.key(['t'], async () => {
  if (currentPage !== 'dash') return;
  const u = getSelectedUpstream();
  if (u) {
    await toggleUpstream(u.name, !u.enabled);
    await autoSave();
    await refresh();
  }
});

screen.key(['e'], async () => {
  if (currentPage !== 'dash') return;
  const u = getSelectedUpstream();
  if (u) {
    const config = await fetchUpstreamConfig(u.name);
    if (config) showForm('edit', config);
  }
});

screen.key(['m'], async () => {
  if (currentPage !== 'dash') return;
  const u = getSelectedUpstream();
  if (u) {
    await measureLatency(u.name);
    await refresh();
  }
});


screen.key(['a'], () => {
  if (currentPage !== 'dash') return;
  showForm('add');
});

screen.key(['return'], async () => {
  if (currentPage === 'form' && !form.editing) {
    formEnter();
  }
  // Dashboard Enter is intentionally unbound to avoid conflicts with list pickers.
});

screen.key(['d'], () => {
  if (currentPage !== 'dash') return;
  const u = getSelectedUpstream();
  if (!u) return;

  const confirm = blessed.question({
    top: 'center',
    left: 'center',
    width: 40,
    height: 7,
    tags: true,
    border: { type: 'line', fg: '#777777' } as any,
    style: { fg: '#cccccc', border: { fg: '#777777' } },
    label: ' Confirm ',
  });
  screen.append(confirm);
  (confirm.ask as any)(`Delete "${u.name}"?`, async (_err: any, ok: boolean) => {
    confirm.detach();
    screen.render();
    if (ok) {
      await deleteUpstream(u.name);
      await autoSave();
      await refresh();
    }
  });
});


// ══════════════════════════════════════════
//  Routing Picker (modal)
// ══════════════════════════════════════════

function openListPicker(opts: {
  title: string;
  items: string[];
  selected?: string;
  onPick: (value: string) => void | Promise<void>;
  onCancel?: () => void;
}): void {
  const list = blessed.list({
    parent: screen,
    top: 'center',
    left: 'center',
    width: 40,
    height: Math.min(opts.items.length + 4, 14),
    label: ` ${opts.title} `,
    keys: true,
    vi: true,
    mouse: true,
    border: { type: 'line', fg: '#777777' } as any,
    style: {
      fg: '#cccccc',
      border: { fg: '#777777' },
      label: { fg: '#cccccc' },
      selected: { bg: '#444444', fg: '#ffffff', bold: true },
      item: { fg: '#cccccc' }
    } as any,
    items: opts.items,
    tags: true
  });

  const initialIdx = opts.selected ? opts.items.indexOf(opts.selected) : 0;
  if (initialIdx >= 0) (list as any).select(initialIdx);
  list.focus();
  screen.render();

  const dismiss = () => {
    list.detach();
    screen.render();
  };

  list.key(['escape'], () => {
    dismiss();
    if (opts.onCancel) {
      opts.onCancel();
    } else {
      upstreamTable.focus();
      screen.render();
    }
  });
  list.on('select', async (item: any) => {
    const val = item.getText();
    dismiss();
    if (!opts.onCancel) {
      // Default behavior for dashboard pickers: return focus to upstream table.
      upstreamTable.focus();
      screen.render();
    }
    await opts.onPick(val);
  });
}

async function openRoutingPicker(): Promise<void> {
  await fetchRouting();
  openListPicker({
    title: 'Routing Strategy',
    items: ['load-balance', 'rules', 'manual'],
    selected: currentRouting.strategy,
    onPick: async (strategy) => {
      const ok = await setStrategyAPI(strategy);
      if (!ok) return;
      currentRouting.strategy = strategy;
      if (strategy === 'manual') {
        await openDefaultUpstreamPicker();
      } else {
        await autoSave();
        renderHint();
      }
    }
  });
}

async function openDefaultUpstreamPicker(): Promise<void> {
  const names = cachedUpstreams.map((u: any) => u.name);
  if (names.length === 0) return;
  openListPicker({
    title: 'Default Upstream',
    items: names,
    selected: currentRouting.defaultUpstream,
    onPick: async (name) => {
      const ok = await setDefaultUpstreamAPI(name);
      if (!ok) return;
      currentRouting.defaultUpstream = name;
      await autoSave();
      renderHint();
    }
  });
}

screen.key(['r'], async () => {
  if (currentPage !== 'dash') return;
  await openRoutingPicker();
});

// ══════════════════════════════════════════
//  Start
// ══════════════════════════════════════════

(async () => {
  await fetchRouting();
  renderHint();
  await refresh();
  await refreshActivity();
})();
upstreamTable.focus();
setInterval(async () => {
  if (currentPage !== 'dash') return;
  await fetchRouting();
  renderHint();
  await refresh();
}, 30000);
setInterval(() => { if (currentPage === 'dash') refreshActivity(); }, 5000);