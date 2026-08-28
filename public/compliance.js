/* Regulatory sign-off on translated claims.
   Two decisions per claim: may it be made at all, and is this translation
   still that same claim. The reviewer is not expected to read the language. */

const $ = (id) => document.getElementById(id);
const KEY = new URL(location.href).searchParams.get('key') || 'dayjoy-compliance';

const state = {
  lang: null,
  language: null,
  reviewer: localStorage.getItem('dayjoy.complianceReviewer') || '',
  items: [],
  index: 0,
  backAvailable: false,
  seenBackTranslation: null,
};

async function api(path, options = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${path}${sep}key=${encodeURIComponent(KEY)}&lang=${state.lang || ''}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// -------------------------------------------------------------------- start

async function loadLanguages() {
  const res = await fetch(`/api/compliance/claims?key=${encodeURIComponent(KEY)}&lang=__`);
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    $('startError').textContent = 'This link is missing its access code. Please ask Dayjoy for the correct link.';
    return [];
  }
  return body.languages || [];
}

function renderLanguagePicker(languages) {
  const grid = $('langPick');
  grid.innerHTML = '';
  for (const l of languages) {
    const btn = document.createElement('button');
    btn.className = 'langbtn';
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(state.lang === l.code));
    const native = document.createElement('span');
    native.className = 'native';
    native.textContent = l.native;
    native.lang = l.code;
    const latin = document.createElement('span');
    latin.className = 'latin';
    latin.textContent = l.name;
    btn.append(native, latin);
    btn.addEventListener('click', () => {
      state.lang = l.code;
      state.language = l;
      renderLanguagePicker(languages);
      refreshBegin();
    });
    grid.appendChild(btn);
  }
}

function refreshBegin() {
  $('beginBtn').disabled = !(state.lang && $('reviewerName').value.trim());
}

$('reviewerName').addEventListener('input', (e) => {
  state.reviewer = e.target.value;
  localStorage.setItem('dayjoy.complianceReviewer', state.reviewer);
  refreshBegin();
});

$('beginBtn').addEventListener('click', async () => {
  try {
    await load();
    $('startPane').classList.add('hidden');
    $('workPane').classList.remove('hidden');
    const firstPending = state.items.findIndex((i) => i.compliance.status === 'pending');
    state.index = firstPending === -1 ? 0 : firstPending;
    render();
  } catch (err) {
    $('startError').textContent = err.message;
  }
});

// --------------------------------------------------------------------- work

async function load() {
  const data = await api('/api/compliance/claims');
  state.items = data.items;
  state.language = data.language;
  state.backAvailable = data.backTranslationAvailable;
  $('langBadge').textContent = data.language.native;
  updateProgress(data.progress);
}

function updateProgress(progress) {
  const pct = progress.total ? (progress.done / progress.total) * 100 : 0;
  $('progressFill').style.width = `${pct}%`;
  $('doneSummary').textContent = `You reviewed ${progress.done} of ${progress.total} claims in ${state.language.name}.`;
}

function stamp(record) {
  if (!record || record.status === 'pending') return '';
  const when = record.at ? new Date(record.at).toLocaleDateString('en-IN') : '';
  return `${record.by}${when ? ` · ${when}` : ''}`;
}

function render() {
  const item = state.items[state.index];
  if (!item) return;

  state.seenBackTranslation = null;

  $('counter').textContent = `Claim ${state.index + 1} of ${state.items.length}`;
  $('claimSource').textContent = item.source;
  $('paneSource').textContent = item.source;

  const target = $('paneTarget');
  target.lang = state.lang;
  target.textContent = item.translation || '(nothing written in this language yet)';
  $('paneTargetCap').textContent = `${state.language.name} wording`;

  $('paneBack').textContent = state.backAvailable
    ? 'Press the button below.'
    : 'Back-translation is unavailable — no translation key is configured. Do not sign off wording you cannot read.';
  $('backNote').textContent = '';
  $('backBtn').disabled = !state.backAvailable || !item.translation;

  // ---- master decision ----
  const master = item.master;
  const masterState = $('masterState');
  if (master.status === 'approved') {
    masterState.innerHTML = `<span class="badge ok">Permissible</span><span>${stamp(master)}</span>${master.basis ? `<span class="muted">${master.basis}</span>` : ''}`;
  } else if (master.status === 'rejected') {
    masterState.innerHTML = `<span class="badge warn">Not permissible</span><span>${stamp(master)}</span>`;
  } else {
    masterState.innerHTML = '<span class="muted">Not yet decided.</span>';
  }
  $('basisInput').value = master.basis || '';

  // ---- language decision ----
  // Deliberately gated: approving a translation of a claim that is not itself
  // permissible would be meaningless, and the order matters for the audit trail.
  const masterApproved = master.status === 'approved';
  const canDecide = masterApproved && Boolean(item.translation);

  // If we can show them the English, they have to look at it before approving.
  // Rejecting stays available - refusing wording you cannot read is always safe.
  const mustReadFirst = state.backAvailable && !state.seenBackTranslation;
  $('langOk').disabled = !canDecide || mustReadFirst;
  $('langNo').disabled = !canDecide;

  const gate = $('approveGate');
  if (gate) {
    gate.textContent =
      canDecide && mustReadFirst ? 'Read the English back-translation above before approving.' : '';
  }

  const langCard = $('langCard');
  langCard.style.opacity = masterApproved ? '1' : '.5';

  const done = $('doneState');
  const c = item.compliance;
  if (c.status === 'approved') {
    done.innerHTML = `<span class="badge ok">Approved</span><span>${stamp(c)}</span>`;
  } else if (c.status === 'rejected') {
    done.innerHTML = `<span class="badge warn">Rejected — will not be spoken</span><span>${stamp(c)}</span>`;
  } else if (c.by === 'system') {
    done.innerHTML = `<span class="badge warn">Needs re-checking</span><span class="muted">${c.note || ''}</span>`;
  } else {
    done.innerHTML = item.languageReview.status === 'pending'
      ? '<span class="muted">A native speaker has not checked this wording yet.</span>'
      : '';
  }

  $('noteInput').value = c.note && c.by !== 'system' ? c.note : '';
  $('prevBtn').disabled = state.index === 0;
  $('nextBtn').disabled = state.index >= state.items.length - 1;
}

$('backBtn').addEventListener('click', async () => {
  const item = state.items[state.index];
  $('paneBack').textContent = 'Translating…';
  $('backNote').textContent = '';
  try {
    const out = await api(`/api/compliance/backtranslate?text=${encodeURIComponent(item.translation)}`);
    $('paneBack').textContent = out.text;
    state.seenBackTranslation = out.text;
    $('backNote').textContent = out.literal
      ? ''
      : 'This came from machine translation, which tidies wording as it goes. It may read better than the original does.';
  } catch (err) {
    $('paneBack').textContent = '';
    $('backNote').textContent = err.message;
  }
});

async function decide(target, status) {
  const item = state.items[state.index];
  try {
    const result = await api('/api/compliance/decision', {
      method: 'POST',
      body: JSON.stringify({
        key: item.key,
        lang: target,
        status,
        by: state.reviewer.trim(),
        basis: target === 'master' ? $('basisInput').value.trim() : undefined,
        note: target === 'master' ? undefined : $('noteInput').value.trim(),
        backTranslation: target === 'master' ? undefined : state.seenBackTranslation || undefined,
      }),
    });

    if (target === 'master') item.master = result.compliance;
    else item.compliance = result.compliance;

    item.status = { usable: false };
    render();
    if (target !== 'master') {
      const done = state.items.filter((i) => i.compliance.status !== 'pending').length;
      updateProgress({ total: state.items.length, done });
      advance();
    }
  } catch (err) {
    $('backNote').textContent = err.message;
  }
}

$('masterOk').addEventListener('click', () => decide('master', 'approved'));
$('masterNo').addEventListener('click', () => decide('master', 'rejected'));
$('langOk').addEventListener('click', () => decide(state.lang, 'approved'));
$('langNo').addEventListener('click', () => decide(state.lang, 'rejected'));

function advance() {
  const next = state.items.findIndex((i, idx) => idx > state.index && i.compliance.status === 'pending');
  if (next !== -1) {
    state.index = next;
    render();
    return;
  }
  if (state.items.every((i) => i.compliance.status !== 'pending')) {
    $('workPane').classList.add('hidden');
    $('donePane').classList.remove('hidden');
  }
}

$('nextBtn').addEventListener('click', () => {
  if (state.index < state.items.length - 1) {
    state.index += 1;
    render();
  }
});
$('prevBtn').addEventListener('click', () => {
  if (state.index > 0) {
    state.index -= 1;
    render();
  }
});
$('againBtn').addEventListener('click', () => {
  $('donePane').classList.add('hidden');
  $('workPane').classList.remove('hidden');
  state.index = 0;
  render();
});

(async function boot() {
  $('reviewerName').value = state.reviewer;
  renderLanguagePicker(await loadLanguages());
  refreshBegin();
})();
