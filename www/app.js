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

let baseImage = null;          // { dataUrl, width, height, downscaled }
let denoiseStrength = 0.6;

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
    
    const scb = $('sharePromptCheckbox');
    if (scb) scb.checked = localStorage.getItem('hpb.share') === '1';
    
    fetchUserKudos();
    loadModels();
    refreshQueueStatus();
    setInterval(refreshQueueStatus, QUEUE_REFRESH_MS);

    wireListeners();
    switchTab('preset');
    onPresetChange();
    refreshModelAvatar();
    maybeShowOnboarding();
    renderBaseImagePreview();
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
  // resolution sync
  $('resPresetSelect').addEventListener('change', syncResolutionUi);
  $('resWidth').addEventListener('input', onCustomSizeChanged);
  $('resHeight').addEventListener('input', onCustomSizeChanged);

  // share checkbox
  const shareCb = $('sharePromptCheckbox');
  if (shareCb) {
    shareCb.checked = localStorage.getItem('hpb.share') === '1';
    shareCb.addEventListener('change', () => {
      localStorage.setItem('hpb.share', shareCb.checked ? '1' : '0');
    });
  }

  // tab 4 — base image
  $('baseImageInput').addEventListener('change', e => handleBaseImageFile(e.target.files?.[0]));
  $('useLastResultBtn').addEventListener('click', useLastResultAsBase);
  $('clearBaseImageBtn').addEventListener('click', () => {
    baseImage = null;
    $('baseImageInput').value = '';
    renderBaseImagePreview();
  });
  $('denoiseSlider').addEventListener('input', () => {
    denoiseStrength = parseInt($('denoiseSlider').value, 10) / 100;
    $('denoiseValue').textContent = denoiseStrength.toFixed(2);
  });

  // tab 4
  $('generateBtn').addEventListener('click', () => onGenerate(false));
  $('rerunBtn').addEventListener('click', () => onGenerate(true));
  $('saveRecipeBtn').addEventListener('click', saveRecipe);
  $('downloadBtn').addEventListener('click', downloadImage);
  $('cancelBtn').addEventListener('click', cancelCurrentJob);

  // account dialog
  // $('settingsBtn').addEventListener('click', () => $('accountDialog').showModal());
  $('settingsBtn').addEventListener('click', () => {
    fetchUserKudos();
    $('accountDialog').showModal();
  });
  $('saveAccountBtn').addEventListener('click', saveAccount);
  $('closeAccountBtn').addEventListener('click', () => {
    localStorage.setItem('hpb.onboarded', '1');
    $('accountDialog').close();
  });
  $('clearDataBtn').addEventListener('click', clearLocalData);

  document.querySelectorAll('.mode-toggle .mode').forEach(btn => {
    btn.addEventListener('click', () => {
      if (genMode === btn.dataset.mode) return;
      genMode = btn.dataset.mode;
      document.querySelectorAll('.mode-toggle .mode').forEach(b =>
        b.classList.toggle('active', b === btn));
      $('modeHint').textContent = genMode === 'inpaint'
        ? 'Pick an inpainting model. On Tab 4 you\'ll be able to load a base image and mask.'
        : 'Generate from prompt. Pick any normal model.';
      // re-filter the model lists without resetting anything else
      loadModels();
    });
  });
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
  if (v === 'user') {
    return {
      width:  parseInt($('resWidth').value, 10) || 512,
      height: parseInt($('resHeight').value, 10) || 512
    };
  }
  const [w, h] = v.split('x').map(Number);
  return { width: w, height: h };
}

function syncResolutionUi() {
  const v = $('resPresetSelect').value;
  $('customResRow').hidden = v !== 'user';
  if (v !== 'user') {
    const [w, h] = v.split('x');
    $('resWidth').value = w;
    $('resHeight').value = h;
  }
  updateResHint();
}

function onCustomSizeChanged() {
  const w = parseInt($('resWidth').value, 10);
  const h = parseInt($('resHeight').value, 10);
  if (!w || !h) return updateResHint();
  const key = `${w}x${h}`;
  const match = [...$('resPresetSelect').options].find(o => o.value === key);
  $('resPresetSelect').value = match ? key : 'user';
  $('customResRow').hidden = $('resPresetSelect').value !== 'user';
  updateResHint();
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

async function saveAccount() {
  localStorage.setItem(LS.apiKey, $('apiKeyInput').value.trim());
  localStorage.setItem('hpb.onboarded', '1');
  await fetchUserKudos();
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

// ----------- kudos card -----------
let userKudos = 0;

async function fetchUserKudos() {
  const valueEl = $('kudosValue');
  const hintEl  = $('kudosHint');
  const cardEl  = valueEl?.closest('.kudos-card');
  if (!valueEl || !hintEl) return;

  const key = localStorage.getItem(LS.apiKey) || '';
  if (!key || key === '0000000000') {
    userKudos = 0;
    valueEl.textContent = 'anonymous';
    hintEl.textContent  = 'Register a free key to earn and spend kudos.';
    cardEl?.classList.remove('good', 'medium', 'low');
    return;
  }

  hintEl.textContent = 'Fetching…';
  try {
    const res = await fetch(`${HORDE}/find_user`, {
      headers: {
        'apikey': key,
        'Client-Agent': 'HordeShaper:1.0:github.com/yusdesign'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    userKudos = Number(data.kudos) || 0;

    valueEl.textContent = userKudos.toFixed(0);
    cardEl?.classList.remove('good', 'medium', 'low');
    if (userKudos >= 50)       cardEl?.classList.add('good');
    else if (userKudos >= 15)  cardEl?.classList.add('medium');
    else                       cardEl?.classList.add('low');

    // what's available at this balance
    let hint = '';
    if (userKudos < 15)        hint = 'Below 15 — SDXL blocked, stick to SD 1.5 models.';
    else if (userKudos < 50)   hint = 'SDXL unlocked (needs ~20+). Queue priority low.';
    else if (userKudos < 200)  hint = 'Good balance. Normal priority.';
    else                       hint = 'High priority in queue.';
    hintEl.textContent = hint;
  } catch (e) {
    userKudos = 0;
    valueEl.textContent = '?';
    hintEl.textContent = 'Could not fetch — check your API key.';
    cardEl?.classList.remove('good', 'medium', 'low');
    console.warn('kudos fetch failed:', e);
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
      const isSDXL = /\bxl\b|sdxl/i.test(m.name);
      const lowKudos = userKudos > 0 && userKudos < 20;
      const tag = isSDXL && lowKudos ? ' ⚠ low kudos' : '';
      o.textContent = `🟢 ${m.name}  (${m.count})${tag}`;
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

  const shareFlag = $('sharePromptCheckbox')?.checked || false;

  const payload = {
    prompt: state.fragments.join(', '),
    negative_prompt: state.negative.join(', '),
    params: { ...params, seed: seed ? String(seed) : undefined },
    models: [model],
    nsfw: false,
    r2: true,
    shared: shareFlag
  };

  // base image handling — img2img or inpainting
  if (baseImage) {
    // Horde expects base64 without the data URI prefix
    const raw = baseImage.dataUrl.replace(/^data:[^,]+,/, '');
    payload.source_image = raw;
    payload.source_processing = genMode === 'inpaint' ? 'inpainting' : 'img2img';
    payload.denoising_strength = denoiseStrength;

    if (genMode === 'inpaint') {
      // no mask editor yet — use the whole image as the mask
      payload.source_mask = raw;
    }
  }

  if (genMode === 'inpaint' && !baseImage) {
    $('statusLine').textContent = 'Inpainting needs a base image. Upload one or use the last result.';
    $('generateBtn').disabled = false;
    return;
  }

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
  let lastWait = Infinity;
  let stallChecks = 0;
  const HARD_LIMIT = 600;        // ~30 min absolute ceiling
  const STALL_LIMIT = 40;        // ~2 min with no progress → give up

  polling = setInterval(async () => {
    checks++;

    if (checks > HARD_LIMIT) {
      return stopPolling('Timed out after ~30 min. Job may still finish on Horde\'s side.');
    }

    try {
      const st = await fetch(`${HORDE}/generate/check/${id}`).then(r => r.json());

      if (st.faulted) {
        const reason = st.faulted_reason || st.message || 'worker crashed';
        return stopPolling(`Job faulted: ${reason}`);
      }
      if (st.is_possible === false) {
        const reason = st.message || 'no worker can run this model / params';
        return stopPolling(`Not possible: ${reason}`);
      }

      // progress detection
      const wait = Number(st.wait_time ?? 0);
      if (wait < lastWait - 1) {
        stallChecks = 0;   // wait_time dropped → progressing
      } else if (checks > 5) {
        stallChecks++;
      }
      lastWait = wait;

      if (st.might_stall || (st.eligible_workers === 0 && checks > 5)) {
        $('statusLine').textContent =
          `Stalling — no eligible workers (${checks}/${HARD_LIMIT}). Cancel to bail.`;
      } else if (wait) {
        const mins = Math.floor(wait / 60);
        const secs = Math.round(wait % 60);
        const eta = mins ? `${mins}m ${secs}s` : `${secs}s`;
        $('statusLine').textContent =
          `Queued… ~${eta} (${checks}/${HARD_LIMIT})`;
      } else {
        $('statusLine').textContent = `Processing… (${checks}/${HARD_LIMIT})`;
      }

      if (stallChecks > STALL_LIMIT) {
        return stopPolling(
          'No progress for ~2 min. Cancel and try again, or pick a different model.'
        );
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
        fetchUserKudos();
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

// ---------------- base image ----------------
const BASE_MIN_DIM = 256;
const BASE_MAX_DIM = 1024;
const BASE_MAX_BYTES = 12 * 1024 * 1024;

async function handleBaseImageFile(file) {
  if (!file) return;
  if (file.size > BASE_MAX_BYTES) {
    return flash(`Image too large (max ${BASE_MAX_BYTES / 1048576} MB)`);
  }
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    return flash('PNG, JPEG or WebP only');
  }

  const dataUrl = await fileToDataUrl(file);
  const img = new Image();

  img.onload = async () => {
    let finalDataUrl = dataUrl;
    let finalW = img.width;
    let finalH = img.height;

    if (img.width < BASE_MIN_DIM || img.height < BASE_MIN_DIM) {
      return flash(`Min ${BASE_MIN_DIM}×${BASE_MIN_DIM} — got ${img.width}×${img.height}`);
    }

    // auto-downscale if too big
    if (img.width > BASE_MAX_DIM || img.height > BASE_MAX_DIM) {
      const scale = BASE_MAX_DIM / Math.max(img.width, img.height);
      finalW = Math.round(img.width * scale);
      finalH = Math.round(img.height * scale);
      const c = document.createElement('canvas');
      c.width = finalW; c.height = finalH;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, finalW, finalH);
      finalDataUrl = c.toDataURL('image/webp', 0.92);
    }

    baseImage = {
      dataUrl: finalDataUrl,
      width: finalW,
      height: finalH,
      downscaled: finalW !== img.width || finalH !== img.height
    };
    renderBaseImagePreview();
  };

  img.onerror = () => flash('Could not read image');
  img.src = dataUrl;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function renderBaseImagePreview() {
  const img  = $('baseImagePreview');
  const info = $('baseImageInfo');
  const row  = $('denoiseRow');

  if (!baseImage) {
    img.hidden = true;
    img.removeAttribute('src');
    info.textContent = 'Max 1024 × 1024. Larger images are auto-downscaled.';
    row.hidden = true;
    return;
  }

  img.src = baseImage.dataUrl;
  img.hidden = false;

  const dims = `${baseImage.width} × ${baseImage.height}`;
  info.textContent = baseImage.downscaled
    ? `${dims} · downscaled to fit`
    : `${dims} · ready`;

  // show strength slider only in img2img-style modes
  row.hidden = genMode === 'inpaint' ? false : false; // always show, inpaint uses same slider
}

async function useLastResultAsBase() {
  const src = $('resultImg').src;
  if (!src) return flash('No result yet');
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const blob = await res.blob();
    const ext = blob.type.includes('png') ? 'png' : blob.type.includes('jpeg') ? 'jpg' : 'webp';
    const file = new File([blob], `last.${ext}`, { type: blob.type || 'image/webp' });
    await handleBaseImageFile(file);
  } catch (e) {
    flash('Could not load last result: ' + e.message);
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
