const HORDE = 'https://stablehorde.net/api/v2';
const LS = {
  apiKey: 'hpb.apiKey',
  model: 'hpb.model',
  recipes: 'hpb.recipes',
  lastPreset: 'hpb.lastPreset'
};

let presetsDoc = null;
let currentPreset = null;

let genMode = 'normal';   // 'normal' | 'inpaint'
let queueCache = [];

let reliableModels = [];
let unstableModels = [];

let polling = null;
let currentJobId = null;
let activeTab = 'preset';
let lastResultSeen = false;

const POLL_LIMIT = 120;
const POLL_INTERVAL_MS = 3000;
const QUEUE_REFRESH_MS = 30_000;

// chip state — single source of truth for prompt/negative
let state = { fragments: [], negative: [] };
let rawMode = false;

const $ = (id) => document.getElementById(id);

// ---------------- boot ----------------
(async function init() {
  try {
    presetsDoc = await fetch('presets.json', { cache: 'no-cache' }).then(r => r.json());
    if (!presetsDoc?.presets?.length) throw new Error('no presets in presets.json');

    buildPresetSelect();
    buildSubjectList();
    loadSettings();
    loadModels();
    refreshQueueStatus();
    setInterval(refreshQueueStatus, QUEUE_REFRESH_MS);

    wireListeners();
    switchTab('preset');
    onPresetChange();
    refreshModelAvatar();
    maybeShowOnboarding();
  } catch (e) {
    console.error('init failed:', e);
    document.body.insertAdjacentHTML('afterbegin',
      `<div style="color:#f66;padding:12px;font:13px monospace">Init error: ${e.message}</div>`);
  }
})();

// ---------------- tabs ----------------
function switchTab(id) {
  activeTab = id;
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === id);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.dataset.panel === id);
  });
  if (id === 'generate' && lastResultSeen) {
    lastResultSeen = false;
    $('resultBadge').hidden = true;
  }
}

function flashBadge() {
  if (activeTab !== 'generate') {
    lastResultSeen = true;
    $('resultBadge').hidden = false;
  }
}

// ---------------- listeners ----------------
function wireListeners() {
  // tabs
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  // tab 1
  $('presetSelect').addEventListener('change', onPresetChange);
  $('modelReliableSelect').addEventListener('change', () => { refreshModelAvatar(); refreshQueueStatus(); updateResHint(); });
  $('modelUnstableSelect').addEventListener('change', () => { refreshModelAvatar(); refreshQueueStatus(); updateResHint(); });

  // tab 2
  $('subjectInput').addEventListener('input', resetFragments);
  $('seedInput').addEventListener('input', renderPrompt);
  $('seedRandomBtn').addEventListener('click', () => {
    $('seedInput').value = Math.floor(Math.random() * 2 ** 31);
    renderPrompt();
  });
  $('seedWalkBtn').addEventListener('click', showSeedWalk);

  // tab 3
  $('promptModeBtn').addEventListener('click', toggleRawMode);
  $('addPromptChipBtn').addEventListener('click', () => {
    state.fragments.push('new fragment');
    renderChips();
    renderPrompt();
  });
  $('addNegativeChipBtn').addEventListener('click', () => {
    state.negative.push('new negative');
    renderChips();
    renderPrompt();
  });
  $('copyPromptBtn').addEventListener('click', copyPrompt);
  $('resetChipsBtn').addEventListener('click', resetFragments);
  $('resPresetSelect').addEventListener('change', () => {
    $('customResRow').hidden = $('resPresetSelect').value !== 'custom';
    updateResHint();
  });
  $('resWidth').addEventListener('input', updateResHint);
  $('resHeight').addEventListener('input', updateResHint);

  // tab 4
  $('generateBtn').addEventListener('click', () => onGenerate(false));
  $('rerunBtn').addEventListener('click', () => onGenerate(true));
  $('saveRecipeBtn').addEventListener('click', saveRecipe);
  $('downloadBtn').addEventListener('click', downloadImage);
  $('cancelBtn').addEventListener('click', cancelCurrentJob);

  // account dialog
  $('settingsBtn').addEventListener('click', () => $('accountDialog').showModal());
  $('saveAccountBtn').addEventListener('click', saveAccount);
  $('closeAccountBtn').addEventListener('click', () => {
    localStorage.setItem('hpb.onboarded', '1');
    $('accountDialog').close();
  });
  $('clearDataBtn').addEventListener('click', clearLocalData);
}

// ---------------- presets ----------------
function buildPresetSelect() {
  const sel = $('presetSelect');
  sel.innerHTML = '';
  for (const p of presetsDoc.presets) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    sel.appendChild(o);
  }
  const last = localStorage.getItem(LS.lastPreset);
  if (last && presetsDoc.presets.some(p => p.id === last)) sel.value = last;
  currentPreset = presetsDoc.presets.find(p => p.id === sel.value);
}

function buildSubjectList() {
  const dl = $('subjectList');
  dl.innerHTML = '';
  for (const s of presetsDoc.subjects || []) {
    const o = document.createElement('option');
    o.value = s; dl.appendChild(o);
  }
}

function onPresetChange() {
  currentPreset = presetsDoc.presets.find(p => p.id === $('presetSelect').value);
  localStorage.setItem(LS.lastPreset, $('presetSelect').value);
  resetFragments();
  refreshModelAvatar();
  updateResHint();
  refreshQueueStatus();
}

// ---------------- chips / prompt ----------------
function fragmentsFromPreset() {
  if (!currentPreset) return [];
  const subject = $('subjectInput').value.trim() || 'a person';
  const f = currentPreset.fragments;
  return [
    f.medium  ? f.medium : null,
    f.subject ? f.subject.replace('{subject}', subject) : null,
    f.style,
    f.framing,
    f.background,
    f.quality
  ].filter(Boolean);
}

function negativeFromPreset() {
  return (currentPreset?.negative || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

function resetFragments() {
  state.fragments = fragmentsFromPreset();
  state.negative  = negativeFromPreset();
  renderChips();
  renderPrompt();
}

function renderChips() {
  renderChipRow($('promptChips'),   state.fragments, v => { state.fragments = v; renderChips(); renderPrompt(); });
  renderChipRow($('negativeChips'), state.negative,  v => { state.negative  = v; renderChips(); renderPrompt(); });
}

function renderChipRow(container, arr, onChange) {
  container.innerHTML = '';
  arr.forEach((text, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';

    const span = document.createElement('span');
    span.textContent = text;
    span.title = 'Tap to edit';
    span.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.value = text;
      chip.replaceChild(inp, span);
      inp.focus(); inp.select();

      const commit = () => {
        const v = inp.value.trim();
        if (v) arr[i] = v;
        else arr.splice(i, 1);
        onChange(arr);
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') inp.blur();
        if (e.key === 'Escape') onChange(arr);
      });
    });

    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Remove');
    x.addEventListener('click', () => { arr.splice(i, 1); onChange(arr); });

    chip.append(span, x);
    container.appendChild(chip);
  });

  if (!arr.length) {
    const empty = document.createElement('span');
    empty.style.cssText = 'color:var(--muted);font-size:12px;padding:4px 6px';
    empty.textContent = '(empty — tap + Add Fragment)';
    container.appendChild(empty);
  }
}

function renderPrompt() {
  $('promptPreview').value   = state.fragments.join(', ');
  $('negativePreview').value = state.negative.join(', ');
}

function toggleRawMode() {
  rawMode = !rawMode;
  $('promptChips').hidden         = rawMode;
  $('negativeChips').hidden       = rawMode;
  $('addPromptChipBtn').hidden    = rawMode;
  $('addNegativeChipBtn').hidden  = rawMode;
  $('promptPreview').hidden       = !rawMode;
  $('negativePreview').hidden     = !rawMode;
  $('promptModeBtn').textContent  = rawMode ? 'chips' : 'raw';
}

async function copyPrompt() {
  const text = state.fragments.join(', ');
  try {
    await navigator.clipboard.writeText(text);
    flash('Prompt copied');
  } catch {
    $('promptPreview').select();
    document.execCommand('copy');
    flash('Prompt copied');
  }
}

// ---------------- resolution ----------------
function currentResolution() {
  const v = $('resPresetSelect').value;
  if (v === 'custom') {
    return {
      width:  parseInt($('resWidth').value, 10) || 512,
      height: parseInt($('resHeight').value, 10) || 512
    };
  }
  const [w, h] = v.split('x').map(Number);
  return { width: w, height: h };
}

function updateResHint() {
  if (!$('resHint')) return;
  const { width, height } = currentResolution();
  const model = chosenModel(currentPreset) || '';
  const isSDXL = /xl|sdxl/i.test(model);
  const maxSide = Math.max(width, height);
  let hint = '';
  if (isSDXL && maxSide < 1024) hint = 'SDXL models want ≥1024 on the long side.';
  else if (!isSDXL && maxSide > 768) hint = '⚠ SD 1.5 models degrade above 768 — expect doubles.';
  if (width % 64 !== 0 || height % 64 !== 0) hint += ' Sizes should be multiples of 64.';
  $('resHint').textContent = hint.trim();
}

// ---------------- model helpers ----------------
function avatarFor(modelName) {
  if (!modelName) return 'avatars/default.svg';
  const map = presetsDoc?.modelAvatars || {};
  if (map[modelName]) return map[modelName];
  const key = Object.keys(map).find(k => modelName.toLowerCase().startsWith(k.toLowerCase()));
  return key ? map[key] : 'avatars/default.svg';
}

function refreshModelAvatar() {
  const img  = $('modelAvatar');
  const name = $('modelAvatarName');
  if (!img || !name) return;
  const model = $('modelUnstableSelect')?.value
             || $('modelReliableSelect')?.value
             || currentPreset?.model || '';
  img.src = avatarFor(model);
  name.textContent = model || '— preset default —';
}

function maybeShowOnboarding() {
  if (localStorage.getItem('hpb.onboarded') === '1') return;
  // open dialog after a beat so the page paints first
  setTimeout(() => {
    $('accountDialog').showModal();
    $('onboardingNote').hidden = false;
  }, 300);
}

function chosenModel(preset) {
  const uns = $('modelUnstableSelect')?.value || '';
  const rel = $('modelReliableSelect')?.value || '';
  return uns || rel || localStorage.getItem(LS.model) || preset?.model || '';
}

// ---------------- account ----------------
function loadSettings() {
  $('apiKeyInput').value = localStorage.getItem(LS.apiKey) || '';
}

function saveAccount() {
  localStorage.setItem(LS.apiKey, $('apiKeyInput').value.trim());
  localStorage.setItem('hpb.onboarded', '1');
  $('accountDialog').close();
  flash('Account saved');
}

function clearLocalData() {
  if (!confirm('Clear API key, recipes, and cached preferences?')) return;
  Object.values(LS).forEach(k => localStorage.removeItem(k));
  $('apiKeyInput').value = '';
  flash('Local data cleared');
}

// ---------------- queue status ----------------
let queueCache = [];

async function refreshQueueStatus() {
  const el = $('queueStatus');
  if (!el) return;
  const model = chosenModel(currentPreset);
  if (!model) {
    el.className = 'queue-status';
    el.querySelector('.queue-text').textContent = '— no model —';
    return;
  }
  try {
    if (!queueCache.length) {
      const res = await fetch(`${HORDE}/status/models?type=image`);
      if (!res.ok) throw new Error(res.status);
      queueCache = await res.json();
    }
    const m = queueCache.find(x => x.name === model);
    if (!m) {
      el.className = 'queue-status';
      el.querySelector('.queue-text').textContent = '— unknown model —';
      return;
    }
    const count = m.count || 0;
    const cls = count >= 3 ? 'good' : count >= 1 ? 'medium' : 'bad';
    el.className = `queue-status ${cls}`;
    el.querySelector('.queue-text').textContent =
      `${count} worker${count === 1 ? '' : 's'} · queue ${m.queued ?? 0}`;
  } catch (e) {
    console.warn('queue status failed', e);
    el.className = 'queue-status';
    el.querySelector('.queue-text').textContent = '— unavailable —';
  }
}

// ---------------- models ----------------
async function loadModels() {
  const prevRel = $('modelReliableSelect').value;
  const prevUns = $('modelUnstableSelect').value;

  try {
    const res = await fetch(`${HORDE}/status/models?type=image`);
    if (!res.ok) throw new Error(`models ${res.status}`);
    const models = await res.json();
    queueCache = models;

    const reliableList = (presetsDoc.modelBuckets?.reliable || []).map(s => s.toLowerCase());
    const isReliable = (name) => {
      const n = name.toLowerCase();
      return reliableList.includes(n) || reliableList.some(r => n.startsWith(r));
    };

    const isInpaint = (name) =>
      /inpaint/i.test(name) ||
      (presetsDoc.inpaintModels || []).some(m =>
        m.toLowerCase() === name.toLowerCase());

    // base filter: image models, non-NSFW
    let live = models.filter(m =>
      (!m.type || m.type === 'image') &&
      !m.name.toLowerCase().includes('nsfw')
    );

    // mode filter
    if (genMode === 'inpaint') {
      live = live.filter(m => isInpaint(m.name));
    } else {
      live = live.filter(m => !isInpaint(m.name));
    }

    // split by worker availability within the mode
    reliableModels = live
      .filter(m => isReliable(m.name) && (m.count || 0) > 0)
      .sort((a, b) => (b.count || 0) - (a.count || 0));

    unstableModels = live
      .filter(m => !isReliable(m.name) || (m.count || 0) === 0)
      .sort((a, b) => {
        const aRel = isReliable(a.name) ? 1 : 0;
        const bRel = isReliable(b.name) ? 1 : 0;
        if (aRel !== bRel) return bRel - aRel;
        return (b.count || 0) - (a.count || 0);
      });

    const rel = $('modelReliableSelect');
    const uns = $('modelUnstableSelect');
    rel.querySelectorAll('option:not(:first-child)').forEach(o => o.remove());
    uns.querySelectorAll('option:not(:first-child)').forEach(o => o.remove());

    for (const m of reliableModels) {
      const o = document.createElement('option');
      o.value = m.name;
      o.textContent = `🟢 ${m.name}  (${m.count})`;
      rel.appendChild(o);
    }
    for (const m of unstableModels) {
      const o = document.createElement('option');
      o.value = m.name;
      const w = m.count || 0;
      o.textContent = `${w > 0 ? '🟡' : '🔴'} ${m.name}  (${w})`;
      uns.appendChild(o);
    }

    // restore previous selection if it survived the mode filter
    if (prevRel && reliableModels.some(m => m.name === prevRel)) {
      $('modelReliableSelect').value = prevRel;
    } else if (prevRel) {
      // was selected, gone after mode switch → clear
      $('modelReliableSelect').value = '';
    }
    if (prevUns && unstableModels.some(m => m.name === prevUns)) {
      $('modelUnstableSelect').value = prevUns;
    } else if (prevUns) {
      $('modelUnstableSelect').value = '';
    }

    // fallback: if nothing selected, pick the top reliable one
    if (!$('modelReliableSelect').value && !$('modelUnstableSelect').value && reliableModels[0]) {
      $('modelReliableSelect').value = reliableModels[0].name;
    }

    refreshModelAvatar();
    refreshQueueStatus();
    updateResHint();
  } catch (e) {
    console.warn('model list failed:', e);
  }
}

// ---------------- generate ----------------
async function onGenerate(reuseSeed = false) {
  if (!currentPreset) return;
  $('resultCard').hidden = false;
  switchTab('generate');
  $('generateBtn').disabled = true;
  $('statusLine').textContent = 'Submitting…';

  const model = chosenModel(currentPreset);
  const { width, height } = currentResolution();
  const params = { ...currentPreset.params, width, height };

  let seed = $('seedInput').value.trim();
  if (reuseSeed && $('resultSeed').textContent !== '–') seed = $('resultSeed').textContent;

  const payload = {
    prompt: state.fragments.join(', '),
    negative_prompt: state.negative.join(', '),
    params: { ...params, seed: seed ? String(seed) : undefined },
    models: [model],
    nsfw: false,
    r2: true,
    shared: false
  };

  const apiKey = localStorage.getItem(LS.apiKey) || '0000000000';

  try {
    const res = await fetch(`${HORDE}/generate/async`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey,
        'Client-Agent': 'HordeShaper:1.0:github.com/yusdesign'
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`submit failed: ${res.status}`);
    const { id } = await res.json();
    if (!id) throw new Error('no job id in response');
    $('statusLine').textContent = 'Queued…';
    pollJob(id);
  } catch (e) {
    $('statusLine').textContent = 'Error: ' + e.message;
    $('generateBtn').disabled = false;
  }
}

async function cancelCurrentJob() {
  const id = currentJobId;
  if (polling) clearInterval(polling);
  polling = null; currentJobId = null;
  $('cancelBtn').hidden = true;
  $('generateBtn').disabled = false;
  $('statusLine').textContent = 'Cancelled.';
  if (!id) return;
  try {
    const apiKey = localStorage.getItem(LS.apiKey) || '0000000000';
    await fetch(`${HORDE}/generate/status/${id}`, {
      method: 'DELETE',
      headers: { 'apikey': apiKey, 'Client-Agent': 'HordeShaper:1.0:github.com/yusdesign' }
    });
  } catch (e) { console.warn('cancel failed', e); }
}

function stopPolling(statusText) {
  if (polling) clearInterval(polling);
  polling = null; currentJobId = null;
  $('cancelBtn').hidden = true;
  $('generateBtn').disabled = false;
  if (statusText) $('statusLine').textContent = statusText;
}

function pollJob(id) {
  currentJobId = id;
  if (polling) clearInterval(polling);
  $('cancelBtn').hidden = false;
  let checks = 0;

  polling = setInterval(async () => {
    checks++;
    if (checks > POLL_LIMIT) return stopPolling('Timed out (~6 min). Try Cancel then Generate again.');
    try {
      const st = await fetch(`${HORDE}/generate/check/${id}`).then(r => r.json());

      if (st.faulted)               return stopPolling('Job faulted on worker. Retry or pick another model.');
      if (st.is_possible === false) return stopPolling('No worker can run this model/params.');

      if (st.might_stall || (st.eligible_workers === 0 && checks > 5)) {
        $('statusLine').textContent = `Stalling — no eligible workers (${checks}/${POLL_LIMIT}).`;
      } else if (st.wait_time) {
        $('statusLine').textContent = `Queued… ~${Math.round(st.wait_time)}s (${checks}/${POLL_LIMIT})`;
      }

      if (st.done) {
        clearInterval(polling); polling = null;
        $('statusLine').textContent = 'Fetching result…';
        const status = await fetch(`${HORDE}/generate/status/${id}`).then(r => r.json());
        const gen = status.generations?.[0];
        if (!gen) throw new Error('no generation in status');
        $('resultImg').src = gen.img;
        $('resultSeed').textContent = gen.seed;
        $('resultModel').textContent = gen.model;
        $('seedInput').value = gen.seed;
        stopPolling('Done');
        flashBadge();
      }
    } catch (e) {
      stopPolling('Poll error: ' + e.message);
    }
  }, POLL_INTERVAL_MS);
}

// ---------------- recipes ----------------
function saveRecipe() {
  const recipes = JSON.parse(localStorage.getItem(LS.recipes) || '[]');
  recipes.push({
    preset: currentPreset.id,
    prompt: state.fragments.join(', '),
    negative: state.negative.join(', '),
    params: currentPreset.params,
    model: $('resultModel').textContent,
    seed: $('resultSeed').textContent,
    savedAt: Date.now()
  });
  localStorage.setItem(LS.recipes, JSON.stringify(recipes));
  flash('Recipe saved');
}

// ---------------- seed walk ----------------
function showSeedWalk() {
  let base = parseInt($('seedInput').value, 10);
  if (!Number.isFinite(base)) {
    base = Math.floor(Math.random() * 2 ** 31);
    $('seedInput').value = base;
  }
  const grid = $('seedWalkGrid');
  grid.innerHTML = '';
  grid.hidden = false;
  for (let d = -2; d <= 2; d++) {
    const s = base + d;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = (d === 0 ? '★ ' : '') + s;
    if (d === 0) b.classList.add('active');
    b.addEventListener('click', () => {
      $('seedInput').value = s;
      grid.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      renderPrompt();
    });
    grid.appendChild(b);
  }
}

// ---------------- download ----------------
async function downloadImage() {
  const src = $('resultImg').src;
  if (!src) return flash('Nothing to save');
  const filename = `hordeshaper-${$('resultSeed').textContent || Date.now()}.webp`;

  if (window.Capacitor?.isNativePlatform?.()) {
    const Plugins    = window.Capacitor.Plugins || {};
    const Filesystem = Plugins.Filesystem;
    const Share      = Plugins.Share;
    const Directory  = Filesystem?.Directory || Plugins.Directory || { Cache: 'CACHE' };
    if (!Filesystem || !Share) return flash('Native plugins missing');

    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const blob = await res.blob();
      const base64 = await blobToBase64(blob);
      const saved = await Filesystem.writeFile({
        path: filename, data: base64, directory: Directory.Cache
      });
      await Share.share({
        title: 'Horde Shaper',
        text: `seed ${$('resultSeed').textContent || '?'}`,
        url: saved.uri,
        dialogTitle: 'Save or share image'
      });
      flash('Saved');
    } catch (e) {
      console.error('[save] failed:', e);
      flash('Save failed: ' + (e?.message || e));
    }
    return;
  }

  const a = document.createElement('a');
  a.href = src; a.download = filename; a.target = '_blank';
  document.body.appendChild(a); a.click(); a.remove();
  flash('Downloaded');
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ---------------- helpers ----------------
function flash(msg) {
  const line = $('statusLine');
  if (!line) return;
  line.textContent = msg;
  setTimeout(() => { if (line.textContent === msg) line.textContent = ''; }, 1800);
}

document.querySelectorAll('.mode-toggle .mode').forEach(btn => {
  btn.addEventListener('click', () => {
    if (genMode === btn.dataset.mode) return;
    genMode = btn.dataset.mode;
    document.querySelectorAll('.mode-toggle .mode').forEach(b =>
      b.classList.toggle('active', b === btn));
    $('modeHint').textContent = genMode === 'inpaint'
      ? 'Pick an inpainting model. On Tab 4 you'll be able to load a base image and mask.'
      : 'Generate from prompt. Pick any normal model.';
    // re-filter the model lists without resetting anything else
    loadModels();
  });
});
