const HORDE = 'https://stablehorde.net/api/v2';
const LS = {
  apiKey: 'hpb.apiKey',
  model: 'hpb.model',
  recipes: 'hpb.recipes'
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
    buildPresetSelect();
    buildSubjectList();
    loadSettings();
    loadModels(); // fire-and-forget, fills settings dropdown
  
    $('presetSelect').addEventListener('change', onPresetChange);
    $('subjectInput').addEventListener('input', renderPrompt);
    $('seedInput').addEventListener('input', renderPrompt);
    $('copyPromptBtn').addEventListener('click', copyPrompt);
    $('generateBtn').addEventListener('click', onGenerate);
    $('rerunBtn').addEventListener('click', () => onGenerate(true));
    $('saveRecipeBtn').addEventListener('click', saveRecipe);
    $('settingsBtn').addEventListener('click', () => $('settingsDialog').showModal());
    $('saveSettingsBtn').addEventListener('click', saveSettings);
    $('cancelBtn').addEventListener('click', cancelCurrentJob);
  
    onPresetChange(); // initial render
    } catch (e) {
      console.error('init failed:', e);
      document.body.insertAdjacentHTML('afterbegin',
        `<div style="color:#f66;padding:12px">Init error: ${e.message}</div>`);
  }
})();

// ---- presets ----
function buildPresetSelect() {
  const sel = $('presetSelect');
  sel.innerHTML = '';
  for (const p of presetsDoc.presets) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    sel.appendChild(o);
  }
  // restore last used
  const last = localStorage.getItem('hpb.lastPreset');
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
  localStorage.setItem('hpb.lastPreset', sel.value);
  renderPrompt();
}

// ---- prompt building ----
function buildPrompt() {
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

function avatarFor(modelName) {
  if (!modelName) return 'avatars/default.svg';
  const map = presetsDoc.modelAvatars || {};
  if (map[modelName]) return map[modelName];
  const key = Object.keys(map).find(k =>
    modelName.toLowerCase().startsWith(k.toLowerCase()));
  return key ? map[key] : 'avatars/default.svg';
}

function refreshModelAvatar() {
  const name = $('modelUnstableSelect').value
            || $('modelReliableSelect').value
            || currentPreset?.model || '';
  $('modelAvatar').src = avatarFor(name);
  $('modelAvatarName').textContent = name || '— preset default —';
}

function chosenModel(preset) {
  const uns = $('modelUnstableSelect').value;
  const rel = $('modelReliableSelect').value;
  return uns || rel || localStorage.getItem(LS.model) || preset.model;
}

// ---- settings ----
function loadSettings() {
  $('apiKeyInput').value = localStorage.getItem(LS.apiKey) || '';
  const m = localStorage.getItem(LS.model);
  if (m) {
    // will be applied once models load; store for later
    $('modelsSelect').dataset.pending = m;
  }
}

function saveSettings() {
  localStorage.setItem(LS.apiKey, $('apiKeyInput').value.trim());
  const chosen = $('modelUnstableSelect').value || $('modelReliableSelect').value || '';
  localStorage.setItem(LS.model, chosen);
  flash('Settings saved');
}

async function loadModels() {
  try {
    const res = await fetch(`${HORDE}/api/v2/status/models?type=image`);
    if (!res.ok) throw new Error(`models ${res.status}`);
    const models = await res.json();

    const reliableList = (presetsDoc.modelBuckets?.reliable || [])
      .map(s => s.toLowerCase());
    const isReliable = (name) =>
      reliableList.includes(name.toLowerCase()) || reliableList.some(r => name.toLowerCase().startsWith(r));

    const live = models.filter(m =>
      (!m.type || m.type === 'image') &&
      !m.name.toLowerCase().includes('nsfw')
    );

    reliableModels = live
      .filter(m => isReliable(m.name) && m.count > 0)
      .sort((a, b) => b.count - a.count);

    unstableModels = live
      .filter(m => !isReliable(m.name) || m.count === 0)
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
      o.textContent = `${m.name}  (${m.count ?? 0})`;
      uns.appendChild(o);
    }

    const saved = localStorage.getItem(LS.model);
    if (saved) {
      if (reliableModels.some(m => m.name === saved)) rel.value = saved;
      else if (unstableModels.some(m => m.name === saved)) uns.value = saved;
    }
  } catch (e) {
    console.warn('model list failed:', e);
  }
}

// ---- generation ----
let polling = null;

async function onGenerate(reuseSeed = false) {
  if (!currentPreset) return;
  $('resultCard').hidden = false;
  $('generateBtn').disabled = true;
  $('statusLine').textContent = 'Submitting…';

  const model = localStorage.getItem(LS.model) || currentPreset.model;
  const params = { ...currentPreset.params };

  let seed = $('seedInput').value.trim();
  if (reuseSeed && $('resultSeed').textContent !== '–') seed = $('resultSeed').textContent;

  const payload = {
    prompt: buildPrompt(),
    negative_prompt: currentPreset.negative || '',
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
    $('statusLine').textContent = 'Queued…';
    pollJob(id);
  } catch (e) {
    $('statusLine').textContent = 'Error: ' + e.message;
    $('generateBtn').disabled = false;
  }
}

async function cancelCurrentJob() {
  if (!currentJobId) return;
  try {
    const apiKey = localStorage.getItem(LS.apiKey) || '0000000000';
    await fetch(`${HORDE}/generate/status/${currentJobId}`, {
      method: 'DELETE',
      headers: { 'apikey': apiKey, 'Client-Agent': 'HordeShaper:1.0:github.com/yusdesign' }
    });
  } catch (e) { console.warn('cancel failed', e); }
  if (polling) clearInterval(polling);
  polling = null;
  $('cancelBtn').hidden = true;
  $('statusLine').textContent = 'Cancelled.';
  $('generateBtn').disabled = false;
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
      stopPolling('Timed out (~6 min). Job may still finish — try Cancel then Generate again.');
      return;
    }
    try {
      const st = await fetch(`${HORDE}/generate/check/${id}`).then(r => r.json());
      console.log('[check]', st);

      if (st.faulted)                        return stopPolling('Job faulted on worker. Retry or pick another model.');
      if (st.is_possible === false)          return stopPolling('No worker can run this model/params. Pick another model.');

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
