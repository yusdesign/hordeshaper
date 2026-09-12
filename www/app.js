const HORDE = 'https://stablehorde.net/api/v2';
const LS = {
  apiKey: 'hpb.apiKey',
  model: 'hpb.model',
  recipes: 'hpb.recipes',
  lastPreset: 'hpb.lastPreset'
};

let presetsDoc = null;
let currentPreset = null;

let reliableModels = [];
let unstableModels = [];

let polling = null;
let currentJobId = null;

const POLL_LIMIT = 120;        // ~6 minutes at 3s
const POLL_INTERVAL_MS = 3000;

const $ = (id) => document.getElementById(id);

// ---- boot ----
(async function init() {
  try {
    presetsDoc = await fetch('presets.json').then(r => r.json());
    if (!presetsDoc?.presets?.length) throw new Error('no presets in presets.json');

    buildPresetSelect();
    buildSubjectList();
    loadSettings();
    loadModels(); // fire-and-forget

    wireListeners();
    onPresetChange();
    refreshModelAvatar();
  } catch (e) {
    console.error('init failed:', e);
    document.body.insertAdjacentHTML('afterbegin',
      `<div style="color:#f66;padding:12px;font:13px monospace">Init error: ${e.message}</div>`);
  }
})();

function wireListeners() {
  $('presetSelect').addEventListener('change', onPresetChange);
  $('subjectInput').addEventListener('input', renderPrompt);
  $('seedInput').addEventListener('input', renderPrompt);
  $('copyPromptBtn').addEventListener('click', copyPrompt);
  $('generateBtn').addEventListener('click', () => onGenerate(false));
  $('rerunBtn').addEventListener('click', () => onGenerate(true));
  $('saveRecipeBtn').addEventListener('click', saveRecipe);
  $('cancelBtn').addEventListener('click', cancelCurrentJob);
  $('settingsBtn').addEventListener('click', () => $('settingsDialog').showModal());
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('modelReliableSelect').addEventListener('change', refreshModelAvatar);
  $('modelUnstableSelect').addEventListener('change', refreshModelAvatar);
  $('closeSettingsBtn').addEventListener('click', () => $('settingsDialog').close());
  $('resPresetSelect').addEventListener('change', () => {
  $('customResRow').hidden = $('resPresetSelect').value !== 'custom';
    updateResHint();
    renderPrompt();
  });
  $('resWidth').addEventListener('input', updateResHint);
  $('resHeight').addEventListener('input', updateResHint);
  $('modelReliableSelect').addEventListener('change', updateResHint);
  $('modelUnstableSelect').addEventListener('change', updateResHint);
  $('downloadBtn').addEventListener('click', downloadImage);
}

// ---- presets ----
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
  const sel = $('presetSelect');
  currentPreset = presetsDoc.presets.find(p => p.id === sel.value);
  localStorage.setItem(LS.lastPreset, sel.value);
  renderPrompt();
  refreshModelAvatar();
}

// ---- prompt building ----
function buildPrompt() {
  if (!currentPreset) return '';
  const subject = $('subjectInput').value.trim() || 'a person';
  const f = currentPreset.fragments;
  return [
    f.subject.replace('{subject}', subject),
    f.style,
    f.framing,
    f.background,
    f.quality
  ].filter(Boolean).join(', ');
}

function renderPrompt() {
  if (!currentPreset) return;
  $('promptPreview').value = buildPrompt();
  $('negativePreview').value = currentPreset.negative || '';
}

async function copyPrompt() {
  const text = $('promptPreview').value;
  try {
    await navigator.clipboard.writeText(text);
    flash('Prompt copied');
  } catch {
    $('promptPreview').select();
    document.execCommand('copy');
    flash('Prompt copied');
  }
}

// ---- model avatars ----
function avatarFor(modelName) {
  if (!modelName) return 'avatars/default.svg';
  const map = presetsDoc?.modelAvatars || {};
  if (map[modelName]) return map[modelName];
  const key = Object.keys(map).find(k =>
    modelName.toLowerCase().startsWith(k.toLowerCase()));
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

function chosenModel(preset) {
  const uns = $('modelUnstableSelect')?.value || '';
  const rel = $('modelReliableSelect')?.value || '';
  return uns || rel || localStorage.getItem(LS.model) || preset.model;
}

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

// ---- settings ----
function loadSettings() {
  $('apiKeyInput').value = localStorage.getItem(LS.apiKey) || '';
  // model preference is applied after models load, in loadModels()
}

function saveSettings() {
  localStorage.setItem(LS.apiKey, $('apiKeyInput').value.trim());
  const chosen = $('modelUnstableSelect').value || $('modelReliableSelect').value || '';
  localStorage.setItem(LS.model, chosen);
  refreshModelAvatar();
  $('settingsDialog').close();
}

async function loadModels() {
  try {
    const res = await fetch(`${HORDE}/status/models?type=image`);
    if (!res.ok) throw new Error(`models ${res.status}`);
    const models = await res.json();

    const reliableList = (presetsDoc.modelBuckets?.reliable || []).map(s => s.toLowerCase());
    const isReliable = (name) => {
      const n = name.toLowerCase();
      return reliableList.includes(n) || reliableList.some(r => n.startsWith(r));
    };

    const live = models.filter(m =>
      (!m.type || m.type === 'image') &&
      !m.name.toLowerCase().includes('nsfw')
    );

    reliableModels = live
      .filter(m => isReliable(m.name) && (m.count || 0) > 0)
      .sort((a, b) => (b.count || 0) - (a.count || 0));

    unstableModels = live
      .filter(m => !isReliable(m.name) || (m.count || 0) === 0)
      .sort((a, b) => (b.count || 0) - (a.count || 0));

    const rel = $('modelReliableSelect');
    const uns = $('modelUnstableSelect');
    rel.querySelectorAll('option:not(:first-child)').forEach(o => o.remove());
    uns.querySelectorAll('option:not(:first-child)').forEach(o => o.remove());

    for (const m of reliableModels) {
      const o = document.createElement('option');
      o.value = m.name;
      o.textContent = `${m.name}  (${m.count})`;
      rel.appendChild(o);
    }
    for (const m of unstableModels) {
      const o = document.createElement('option');
      o.value = m.name;
      o.textContent = `${m.name}  (${m.count || 0})`;
      uns.appendChild(o);
    }

    const saved = localStorage.getItem(LS.model);
    if (saved) {
      if (reliableModels.some(m => m.name === saved)) rel.value = saved;
      else if (unstableModels.some(m => m.name === saved)) uns.value = saved;
    }
    refreshModelAvatar();
  } catch (e) {
    console.warn('model list failed:', e);
  }
}

// ---- generation ----
async function onGenerate(reuseSeed = false) {
  if (!currentPreset) return;
  $('resultCard').hidden = false;
  $('generateBtn').disabled = true;
  $('statusLine').textContent = 'Submitting…';

  const model = chosenModel(currentPreset);
  const { width, height } = currentResolution();
  const params = { ...currentPreset.params, width, height };

  let seed = $('seedInput').value.trim();
  if (reuseSeed && $('resultSeed').textContent !== '–') seed = $('resultSeed').textContent;

  const payload = {
    prompt: buildPrompt(),
    negative_prompt: currentPreset.negative || '',
    params: { ...params, seed: seed ? String(seed) : undefined },
    models: [model],
    nsfw: false,
    r2: true,
    shared: false,
    // optional: if you want upscaling
    // post_processing: ['RealESRGAN_x4plus']
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
  polling = null;
  currentJobId = null;
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
  polling = null;
  currentJobId = null;
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
    if (checks > POLL_LIMIT) {
      stopPolling('Timed out (~6 min). Job may still finish — Cancel and try again.');
      return;
    }
    try {
      const st = await fetch(`${HORDE}/generate/check/${id}`).then(r => r.json());
      console.log('[check]', st);

      if (st.faulted)               return stopPolling('Job faulted on worker. Retry or pick another model.');
      if (st.is_possible === false) return stopPolling('No worker can run this model/params. Pick another model.');

      if (st.might_stall || (st.eligible_workers === 0 && checks > 5)) {
        $('statusLine').textContent = `Stalling — no eligible workers (${checks}/${POLL_LIMIT}). Cancel to bail.`;
      } else if (st.wait_time) {
        $('statusLine').textContent = `Queued… ~${Math.round(st.wait_time)}s (${checks}/${POLL_LIMIT})`;
      }

      if (st.done) {
        clearInterval(polling); polling = null;
        $('statusLine').textContent = 'Fetching result…';
        const status = await fetch(`${HORDE}/generate/status/${id}`).then(r => r.json());
        console.log('[status]', status);
        const gen = status.generations?.[0];
        if (!gen) throw new Error('no generation in status');
        $('resultImg').src = gen.img;
        $('resultSeed').textContent = gen.seed;
        $('resultModel').textContent = gen.model;
        $('seedInput').value = gen.seed;
        stopPolling('Done');
      }
    } catch (e) {
      console.error('poll failed:', e);
      stopPolling('Poll error: ' + e.message);
    }
  }, POLL_INTERVAL_MS);
}

// ---- download image ----
async function downloadImage() {
  const src = $('resultImg').src;
  if (!src) return flash('Nothing to save');
  const filename = `hordeshaper-${$('resultSeed').textContent || Date.now()}.webp`;

  // Capacitor path
  if (window.Capacitor?.isNativePlatform?.()) {
    try {
      const { Filesystem, Directory } = window.Capacitor.Plugins;
      const { Share } = window.Capacitor.Plugins;

      // fetch remote image → base64
      const res = await fetch(src);
      const blob = await res.blob();
      const base64 = await blobToBase64(blob);

      const saved = await Filesystem.writeFile({
        path: filename,
        data: base64,
        directory: Directory.Documents,
        recursive: true
      });

      // offer share sheet so user can put it anywhere
      await Share.share({
        title: 'Horde Shaper result',
        url: saved.uri,
        dialogTitle: 'Save image'
      });
      flash('Saved');
    } catch (e) {
      console.error(e);
      flash('Save failed: ' + e.message);
    }
    return;
  }

  // Browser fallback — plain anchor download
  const a = document.createElement('a');
  a.href = src;
  a.download = filename;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
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

// ---- recipes ----
function saveRecipe() {
  const recipes = JSON.parse(localStorage.getItem(LS.recipes) || '[]');
  recipes.push({
    preset: currentPreset.id,
    prompt: $('promptPreview').value,
    negative: $('negativePreview').value,
    params: currentPreset.params,
    model: $('resultModel').textContent,
    seed: $('resultSeed').textContent,
    savedAt: Date.now()
  });
  localStorage.setItem(LS.recipes, JSON.stringify(recipes));
  flash('Recipe saved');
}

// ---- helpers ----
function flash(msg) {
  const line = $('statusLine');
  line.textContent = msg;
  setTimeout(() => { if (line.textContent === msg) line.textContent = ''; }, 1500);
}
