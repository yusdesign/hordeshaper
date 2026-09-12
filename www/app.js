const HORDE = 'https://stablehorde.net/api/v2';
const LS = {
  apiKey: 'hpb.apiKey',
  model: 'hpb.model',
  recipes: 'hpb.recipes'
};

let presetsDoc = null;
let currentPreset = null;

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
  localStorage.setItem(LS.model, $('modelsSelect').value || '');
  flash('Settings saved');
}

async function loadModels() {
  try {
    const res = await fetch('https://stablehorde.net/api/v2/status/models?type=image');
    if (!res.ok) throw new Error(`models ${res.status}`);
    const models = await res.json();          // array now
    const sel = $('modelsSelect');
    const pending = sel.dataset.pending || localStorage.getItem(LS.model) || '';
    sel.querySelectorAll('option:not(:first-child)').forEach(o => o.remove());
    for (const m of models) {
      if (m.type && m.type !== 'image') continue;
      if (m.name.toLowerCase().includes('nsfw')) continue;
      const o = document.createElement('option');
      o.value = m.name;
      o.textContent = `${m.name}  (${m.count})`;
      sel.appendChild(o);
    }
    if (pending) sel.value = pending;
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

function pollJob(id) {
  if (polling) clearInterval(polling);
  polling = setInterval(async () => {
    try {
      const st = await fetch(`${HORDE}/generate/check/${id}`).then(r => r.json());
      if (st.wait_time) $('statusLine').textContent = `Queued… ~${Math.round(st.wait_time)}s`;
      if (st.is_possible === false) {
        clearInterval(polling);
        $('statusLine').textContent = 'Job impossible (bad model or params).';
        $('generateBtn').disabled = false;
        return;
      }
      if (st.done) {
        clearInterval(polling);
        const status = await fetch(`}/generate/status/${id}`).then(r => r.json());
        const gen = status.generations?.[0];
        if (!gen) throw new Error('no generation in status');
        $('resultImg').src = gen.img;
        $('resultSeed').textContent = gen.seed;
        $('resultModel').textContent = gen.model;
        $('seedInput').value = gen.seed;
        $('statusLine').textContent = 'Done';
        $('generateBtn').disabled = false;
      }
    } catch (e) {
      clearInterval(polling);
      $('statusLine').textContent = 'Error: ' + e.message;
      $('generateBtn').disabled = false;
    }
  }, 3000);
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
