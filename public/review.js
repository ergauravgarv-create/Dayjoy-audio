/* Glossary review - for a native speaker, not a developer.
   One word at a time, hear it, approve or correct it. Saves as you go. */

const $ = (id) => document.getElementById(id);

const KEY = new URL(location.href).searchParams.get('key') || 'dayjoy-review';

const state = {
  lang: null,
  language: null,
  reviewer: localStorage.getItem('dayjoy.reviewer') || '',
  items: [],
  index: 0,
  audio: null,
};

const HELP = {
  keep: 'This is a Dayjoy brand name. It must never be translated — only written in your script so the voice pronounces it correctly.',
  render: 'This is an ordinary word. We want the same translation used in every training, so it does not come out three different ways.',
  claim: 'This is a health statement. It must not be made stronger than the original — please keep it as careful as it is written.',
};

// ------------------------------------------------------------------ helpers

async function api(path, options = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${path}${sep}key=${encodeURIComponent(KEY)}&lang=${state.lang || ''}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

function play(url) {
  state.audio?.pause();
  state.audio = new Audio(url);
  state.audio.play().catch(() => {
    $('hearNote').textContent = 'Could not play audio on this device. You can still judge the spelling by eye.';
  });
}

function speak(text) {
  if (!text.trim()) return;
  $('hearNote').textContent = '';
  const url = `/api/glossary/preview?key=${encodeURIComponent(KEY)}&lang=${state.lang}&text=${encodeURIComponent(text)}`;
  play(url);
}

// -------------------------------------------------------------------- start

async function loadLanguages() {
  // Any request with a bad language returns the list, which doubles as the
  // language picker without needing a separate endpoint.
  const res = await fetch(`/api/glossary/review?key=${encodeURIComponent(KEY)}&lang=__`);
  const body = await res.json();
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
      localStorage.setItem('dayjoy.reviewLang', l.code);
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
  localStorage.setItem('dayjoy.reviewer', state.reviewer);
  refreshBegin();
});

$('beginBtn').addEventListener('click', async () => {
  try {
    await loadItems();
    $('startPane').classList.add('hidden');
    $('reviewPane').classList.remove('hidden');
    // Open on the first thing still needing attention, not always at the top.
    const firstPending = state.items.findIndex((i) => i.review.status === 'pending');
    state.index = firstPending === -1 ? 0 : firstPending;
    renderTerm();
  } catch (err) {
    $('startError').textContent = err.message;
  }
});

// ------------------------------------------------------------------- review

async function loadItems() {
  const data = await api('/api/glossary/review');
  state.items = data.items;
  state.language = data.language;
  $('langBadge').textContent = data.language.native;
  updateProgress(data.progress);
}

function updateProgress(progress) {
  const pct = progress.total ? (progress.done / progress.total) * 100 : 0;
  $('progressFill').style.width = `${pct}%`;
  if (progress.done >= progress.total && progress.total > 0) {
    $('doneSummary').textContent = `You checked all ${progress.total} words in ${state.language.name}.`;
  }
}

function renderTerm() {
  const item = state.items[state.index];
  if (!item) return;

  $('counter').textContent = `Word ${state.index + 1} of ${state.items.length}`;
  $('termEn').textContent = item.label;
  $('termKind').textContent =
    item.kind === 'keep' ? 'Brand name' : item.kind === 'claim' ? 'Health statement' : 'Common word';
  $('termHelp').textContent = HELP[item.kind] || HELP.render;

  const spellingEl = $('spelling');
  spellingEl.lang = state.lang;
  if (item.spelling) {
    spellingEl.textContent = item.spelling;
    spellingEl.classList.remove('empty');
  } else {
    spellingEl.textContent = 'We have nothing written for this yet — please write it.';
    spellingEl.classList.add('empty');
  }

  $('hearNote').textContent = '';
  $('fixBox').classList.add('hidden');
  $('fixInput').lang = state.lang;
  $('fixInput').value = item.spelling || '';
  $('noteInput').value = item.review.note || '';

  const done = $('doneState');
  if (item.review.status === 'approved') {
    done.innerHTML = `<span class="badge ok">Approved</span> <span>by ${item.review.by}</span>`;
  } else if (item.review.status === 'corrected') {
    done.innerHTML = `<span class="badge ok">You corrected this</span> <span>by ${item.review.by}</span>`;
  } else {
    done.innerHTML = '';
  }

  $('prevBtn').disabled = state.index === 0;
  $('nextBtn').disabled = state.index >= state.items.length - 1;
}

async function submit(status, spelling) {
  const item = state.items[state.index];
  try {
    const result = await api('/api/glossary/review', {
      method: 'POST',
      body: JSON.stringify({
        key: item.key,
        status,
        spelling,
        by: state.reviewer.trim(),
        note: $('noteInput').value.trim(),
      }),
    });
    item.review = result.review;
    item.spelling = result.spelling;
    updateProgress(result.progress);
    advance();
  } catch (err) {
    $('hearNote').textContent = err.message;
  }
}

function advance() {
  const nextPending = state.items.findIndex(
    (i, idx) => idx > state.index && i.review.status === 'pending'
  );
  if (nextPending !== -1) {
    state.index = nextPending;
    renderTerm();
    return;
  }
  if (state.items.every((i) => i.review.status !== 'pending')) {
    $('reviewPane').classList.add('hidden');
    $('donePane').classList.remove('hidden');
    return;
  }
  // Something earlier was skipped - go back for it rather than declaring victory.
  const anyPending = state.items.findIndex((i) => i.review.status === 'pending');
  state.index = anyPending === -1 ? state.index : anyPending;
  renderTerm();
}

$('okBtn').addEventListener('click', () => submit('approved'));

$('fixBtn').addEventListener('click', () => {
  $('fixBox').classList.remove('hidden');
  $('fixInput').focus();
});

$('saveFixBtn').addEventListener('click', () => {
  const value = $('fixInput').value.trim();
  if (!value) {
    $('hearNote').textContent = 'Please type the correct spelling first.';
    return;
  }
  submit('corrected', value);
});

$('hearBtn').addEventListener('click', () => speak(state.items[state.index]?.spelling || ''));
$('hearFixBtn').addEventListener('click', () => speak($('fixInput').value));

$('skipBtn').addEventListener('click', advance);

$('nextBtn').addEventListener('click', () => {
  if (state.index < state.items.length - 1) {
    state.index += 1;
    renderTerm();
  }
});

$('prevBtn').addEventListener('click', () => {
  if (state.index > 0) {
    state.index -= 1;
    renderTerm();
  }
});

$('againBtn').addEventListener('click', () => {
  $('donePane').classList.add('hidden');
  $('reviewPane').classList.remove('hidden');
  state.index = 0;
  renderTerm();
});

// --------------------------------------------------------------------- boot

(async function boot() {
  $('reviewerName').value = state.reviewer;
  const languages = await loadLanguages();
  const remembered = localStorage.getItem('dayjoy.reviewLang');
  if (remembered && languages.some((l) => l.code === remembered)) {
    state.lang = remembered;
    state.language = languages.find((l) => l.code === remembered);
  }
  renderLanguagePicker(languages);
  refreshBegin();
})();
