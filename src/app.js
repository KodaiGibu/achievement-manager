/**
 * 業績管理アプリ — UI レイヤー
 */
import {
  APP_TITLE, CATEGORIES, CATEGORY_MAP, kindOf,
  emptyDb, emptyAchievement, emptyAuthor, newId,
  loadDb, saveDb, upsertMaster, findById, removeMaster, countMasterUsage,
  addAffiliation, affiliationLabel, sortedAffiliations,
  groupByCategory, summarize, exportJson, importJson, dateKey,
} from './model.js';
import {
  buildList, buildCsv, formatItem, formatAuthors, journalLabel, conferenceLabel,
  defaultTitle, fileName, backupFileName, authorName, authorAffiliation, isSelf,
} from './format.js';
import { fetchByDoi, normalizeDoi } from './crossref.js';
import {
  buildBibtex, buildRis, buildKakenhi, buildYearlyCsv, summarizeByYear, exportFileName,
} from './export-formats.js';

const $ = (id) => document.getElementById(id);

const app = {
  db: loadDb(),
  editingId: null,        // 編集中の業績 ID（null なら新規）
  /** 入力中の著者: { freeName, affiliationIds: [] } */
  authors: [emptyAuthor()],
  /** マスタ管理で編集中の項目 ID */
  masterEdit: { aff: null, person: null, jnl: null, cnf: null },
};

// ══ 小さな DOM ヘルパ ══
function el(tag, className = '', text = '') {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}
function btn(text, className = 'mini', title = '') {
  const b = el('button', className, text);
  b.type = 'button';
  if (title) b.title = title;
  return b;
}

// ══ ダイアログ・ステータス ══
const dlgMsg = $('dlg-msg');
function showMessage(title, body) {
  return new Promise((resolve) => {
    $('msg-title').textContent = title;
    $('msg-body').textContent = body;
    $('msg-cancel').classList.add('hidden');
    const ok = () => { $('msg-ok').removeEventListener('click', ok); dlgMsg.close(); resolve(true); };
    $('msg-ok').addEventListener('click', ok);
    dlgMsg.showModal();
  });
}
function askYesNo(title, body) {
  return new Promise((resolve) => {
    $('msg-title').textContent = title;
    $('msg-body').textContent = body;
    const cancel = $('msg-cancel');
    cancel.classList.remove('hidden');
    const done = (v) => {
      $('msg-ok').removeEventListener('click', yes);
      cancel.removeEventListener('click', no);
      cancel.classList.add('hidden');
      dlgMsg.close(); resolve(v);
    };
    const yes = () => done(true);
    const no = () => done(false);
    $('msg-ok').addEventListener('click', yes);
    cancel.addEventListener('click', no);
    dlgMsg.showModal();
  });
}
function setStatus(text, isError = false) {
  const sb = $('statusbar');
  sb.textContent = text;
  sb.classList.toggle('error', isError);
}
function persist(message) {
  const ok = saveDb(app.db);
  $('save-state').textContent = ok
    ? `保存済み ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`
    : '保存に失敗';
  $('save-state').classList.toggle('bad', !ok);
  if (message) setStatus(message, !ok);
  return ok;
}
function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
}

// ══ タブ切替 ══
document.querySelectorAll('.nb-tabs .nb-tab').forEach((b) => {
  b.addEventListener('click', () => {
    const page = b.dataset.page;
    document.querySelectorAll('.nb-tabs .nb-tab').forEach((x) => x.classList.toggle('active', x === b));
    ['entry', 'list', 'output', 'yearly', 'master', 'data'].forEach((p) => {
      $(`page-${p}`).classList.toggle('hidden', p !== page);
    });
    if (page === 'entry') renderAuthors();
    if (page === 'list') renderList();
    if (page === 'output') renderOutput();
    if (page === 'yearly') renderYearly();
    if (page === 'master') renderMasters();
    if (page === 'data') renderStats();
  });
});

// ══════════ 入力フォーム ══════════

function fillCategorySelects() {
  const sel = $('f-category');
  sel.innerHTML = '';
  CATEGORIES.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.label;
    sel.appendChild(o);
  });
  const ls = $('l-category');
  ls.innerHTML = '<option value="">すべて</option>';
  CATEGORIES.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.label;
    ls.appendChild(o);
  });
}

/** 区分に応じて表示するフィールド群を切り替える */
function applyKind() {
  const kind = kindOf($('f-category').value);
  $('f-kind').textContent = { paper: '論文形式', conference: '学会発表形式', other: 'その他形式' }[kind];
  document.querySelectorAll('.kind-paper').forEach((x) => x.classList.toggle('hidden', kind !== 'paper'));
  document.querySelectorAll('.kind-conference').forEach((x) => x.classList.toggle('hidden', kind !== 'conference'));
  document.querySelectorAll('.kind-other').forEach((x) => x.classList.toggle('hidden', kind !== 'other'));
  const cat = CATEGORY_MAP[$('f-category').value];
  if (kind === 'paper' && typeof cat?.reviewed === 'boolean') $('f-reviewed').checked = cat.reviewed;
  updatePreview();
}
$('f-category').addEventListener('change', applyKind);

/** datalist（候補）を最新のマスタで更新する */
function refreshDatalists() {
  const set = (id, items) => {
    const dl = $(id);
    dl.innerHTML = '';
    items.forEach((x) => {
      const o = document.createElement('option');
      o.value = x.name;
      dl.appendChild(o);
    });
  };
  set('dl-persons', app.db.masters.persons);
  set('dl-affiliations', sortedAffiliations(app.db));
  set('dl-journals', app.db.masters.journals);
  set('dl-conferences', app.db.masters.conferences);
}

// ══ 共著者と所属 ══

/** 氏名から人物マスタを探す */
function findPerson(name) {
  const n = String(name ?? '').trim();
  return app.db.masters.persons.find((p) => p.name === n) ?? null;
}
/** 自分の人物マスタを探す（自分の氏名表記のいずれかに一致） */
function findSelfPerson() {
  return app.db.masters.persons.find((p) => isSelf(app.db, p.name)) ?? null;
}

/**
 * 新しい所属（名称＋略称）を登録して ID を返す。
 * 既存の略称と食い違う場合は、変更するか確認する。
 */
async function registerAffiliation(name, shortName) {
  let r;
  try {
    r = addAffiliation(app.db, name, shortName);
  } catch (e) {
    await showMessage('入力エラー', e.message);
    return null;
  }
  if (r.conflict) {
    const change = await askYesNo('略称の確認',
      `「${name}」は略称「${r.conflict}」で登録済みです。\n略称を「${shortName}」に変更しますか？\n`
      + '（変更すると、この所属を使っているすべての業績の出力に反映されます）');
    if (change) r = addAffiliation(app.db, name, shortName, { updateShortName: true });
  }
  const aff = findById(app.db.masters.affiliations, r.id);
  if (r.created) persist(`所属を登録しました：${affiliationLabel(aff)}`);
  else if (r.updated) persist(`所属の略称を更新しました：${affiliationLabel(aff)}`);
  else setStatus(`登録済みの所属を追加しました：${affiliationLabel(aff)}`);
  refreshDatalists();
  return r.id;
}

/** 著者行を描画する */
function renderAuthors() {
  const box = $('f-authors');
  box.innerHTML = '';
  app.authors.forEach((au, i) => box.appendChild(buildAuthorRow(au, i)));
  updatePreview();
}

/** 著者 1 名分の行（氏名・所属チップ・所属の追加欄）を組み立てる */
function buildAuthorRow(au, i) {
  if (!Array.isArray(au.affiliationIds)) au.affiliationIds = [];
  const row = el('div', 'author-row');

  // ── 1段目: 番号・氏名・自分バッジ・並べ替え ──
  const head = el('div', 'a-head');
  head.appendChild(el('span', 'a-no', String(i + 1)));
  const nameLabel = el('label', '', '氏名:');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'a-name';
  nameInput.size = 18;
  nameInput.setAttribute('list', 'dl-persons');
  nameInput.value = au.freeName ?? '';
  nameLabel.appendChild(nameInput);
  head.appendChild(nameLabel);
  const selfBadge = el('span', 'a-self', '自分');
  selfBadge.classList.toggle('hidden', !isSelf(app.db, au.freeName));
  head.appendChild(selfBadge);
  const ops = el('span', 'a-ops');
  const up = btn('↑', 'mini a-up', '上へ');
  const down = btn('↓', 'mini a-down', '下へ');
  const del = btn('×', 'mini danger a-del', 'この著者を削除');
  ops.append(up, down, del);
  head.appendChild(ops);
  row.appendChild(head);

  // ── 2段目: 選択済みの所属（チップ） ──
  const affLine = el('div', 'a-affs');
  affLine.appendChild(el('span', 'a-cap', '所属:'));
  const chips = el('span', 'a-chips');
  const validIds = au.affiliationIds.filter((id) => findById(app.db.masters.affiliations, id));
  au.affiliationIds = validIds;
  if (!validIds.length) chips.appendChild(el('span', 'a-none', '（未設定）'));
  validIds.forEach((id, k) => {
    const aff = findById(app.db.masters.affiliations, id);
    const chip = el('span', 'aff-chip');
    if (k > 0) {
      const left = btn('◀', 'chip-btn', '前へ移動');
      left.addEventListener('click', () => {
        [au.affiliationIds[k - 1], au.affiliationIds[k]] = [au.affiliationIds[k], au.affiliationIds[k - 1]];
        renderAuthors();
      });
      chip.appendChild(left);
    }
    chip.appendChild(el('span', 'chip-name', aff.name));
    if (String(aff.shortName ?? '').trim() !== '') chip.appendChild(el('span', 'chip-short', aff.shortName));
    const rm = btn('×', 'chip-btn', 'この所属を外す');
    rm.addEventListener('click', () => {
      au.affiliationIds.splice(k, 1);
      renderAuthors();
    });
    chip.appendChild(rm);
    chips.appendChild(chip);
  });
  affLine.appendChild(chips);
  row.appendChild(affLine);

  // ── 3段目: 所属の追加（過去の所属から選択 / 新しい所属を登録） ──
  const addLine = el('div', 'a-add');

  const pickBox = el('span', 'a-pick');
  pickBox.appendChild(el('span', 'a-cap', '過去の所属から選択:'));
  const sel = document.createElement('select');
  sel.className = 'a-aff-select';
  const opt0 = document.createElement('option');
  opt0.value = '';
  const candidates = sortedAffiliations(app.db).filter((a) => !au.affiliationIds.includes(a.id));
  opt0.textContent = candidates.length ? '（所属を選ぶ）' : '（登録済みの所属はありません）';
  sel.appendChild(opt0);
  candidates.forEach((a) => {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = affiliationLabel(a);
    sel.appendChild(o);
  });
  const pickBtn = btn('追加', 'mini a-pick-btn');
  pickBox.append(sel, pickBtn);
  addLine.appendChild(pickBox);

  const newBox = el('span', 'a-newaff');
  newBox.appendChild(el('span', 'a-cap', '新しい所属:'));
  const nName = document.createElement('input');
  nName.type = 'text';
  nName.className = 'a-new-name';
  nName.size = 20;
  nName.placeholder = '名称（例: 産業技術総合研究所）';
  nName.setAttribute('list', 'dl-affiliations');
  const nShort = document.createElement('input');
  nShort.type = 'text';
  nShort.className = 'a-new-short';
  nShort.size = 10;
  nShort.placeholder = '略称（例: 産総研）';
  const nBtn = btn('登録して追加', 'mini accent a-new-btn');
  newBox.append(nName, nShort, nBtn);
  addLine.appendChild(newBox);
  row.appendChild(addLine);

  // ── イベント ──
  nameInput.addEventListener('input', () => {
    au.freeName = nameInput.value;
    selfBadge.classList.toggle('hidden', !isSelf(app.db, au.freeName));
    updatePreview();
  });
  // 氏名を確定したとき、所属が未設定ならその人の既定の所属を入れる
  nameInput.addEventListener('change', () => {
    const p = findPerson(nameInput.value);
    if (p && au.affiliationIds.length === 0 && (p.affiliationIds ?? []).length) {
      au.affiliationIds = p.affiliationIds.filter((id) => findById(app.db.masters.affiliations, id));
      renderAuthors();
      setStatus(`${p.name} の既定の所属を入れました`);
    }
  });
  const addPicked = () => {
    if (!sel.value) { setStatus('追加する所属を選んでください', true); return; }
    if (!au.affiliationIds.includes(sel.value)) au.affiliationIds.push(sel.value);
    renderAuthors();
  };
  pickBtn.addEventListener('click', addPicked);
  sel.addEventListener('change', addPicked);

  // 既存の名称を入力したら登録済みの略称を補う
  nName.addEventListener('change', () => {
    const hit = app.db.masters.affiliations.find((a) => a.name === nName.value.trim());
    if (hit && nShort.value.trim() === '' && String(hit.shortName ?? '').trim() !== '') {
      nShort.value = hit.shortName;
    }
  });
  const addNew = async () => {
    const name = nName.value.trim();
    if (name === '') { await showMessage('入力エラー', '新しい所属の名称を入力してください。'); return; }
    const id = await registerAffiliation(name, nShort.value.trim());
    if (!id) return;
    if (!au.affiliationIds.includes(id)) au.affiliationIds.push(id);
    renderAuthors();
  };
  nBtn.addEventListener('click', addNew);
  [nName, nShort].forEach((inp) => inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addNew(); }
  }));

  up.addEventListener('click', () => {
    if (i === 0) return;
    [app.authors[i - 1], app.authors[i]] = [app.authors[i], app.authors[i - 1]];
    renderAuthors();
  });
  down.addEventListener('click', () => {
    if (i === app.authors.length - 1) return;
    [app.authors[i + 1], app.authors[i]] = [app.authors[i], app.authors[i + 1]];
    renderAuthors();
  });
  del.addEventListener('click', () => {
    if (app.authors.length <= 1) app.authors[0] = emptyAuthor();
    else app.authors.splice(i, 1);
    renderAuthors();
  });
  return row;
}

$('f-add-author').addEventListener('click', () => {
  app.authors.push(emptyAuthor());
  renderAuthors();
});
$('f-add-self').addEventListener('click', () => {
  const me = findSelfPerson();
  const name = me ? me.name : ((app.db.profile.selfNames ?? [])[0] ?? '');
  app.authors.unshift({
    ...emptyAuthor(),
    freeName: name,
    affiliationIds: me ? (me.affiliationIds ?? []).slice() : [],
  });
  renderAuthors();
});

/** 入力欄から業績レコードを組み立てる（commitMasters=true でマスタへ登録） */
function collectAchievement({ commitMasters = true } = {}) {
  const categoryId = $('f-category').value;
  const kind = kindOf(categoryId);
  const a = emptyAchievement(categoryId);
  if (app.editingId) a.id = app.editingId;
  const m = app.db.masters;

  a.authors = app.authors.map((au) => {
    const nm = String(au.freeName ?? '').trim();
    if (nm === '') return null;
    const affIds = (au.affiliationIds ?? []).filter((id) => findById(m.affiliations, id));
    const personId = commitMasters
      ? upsertMaster(m.persons, { name: nm, nameEn: '', affiliationIds: affIds.slice() }, 'name', 'per')
      : (findPerson(nm)?.id ?? '');
    return { personId, freeName: personId ? '' : nm, affiliationIds: affIds, freeAffiliation: '' };
  }).filter(Boolean);

  const resolve = (list, value, extra, prefix) => {
    const v = String(value ?? '').trim();
    if (v === '') return '';
    if (commitMasters) return upsertMaster(list, { name: v, ...extra }, 'name', prefix);
    return list.find((x) => x.name === v)?.id ?? '';
  };

  if (kind === 'paper') {
    a.title = $('f-title-paper').value.trim();
    const jn = $('f-journal').value.trim();
    a.journalId = resolve(m.journals, jn, { abbr: $('f-journal-abbr').value.trim() }, 'jnl');
    if (!a.journalId) a.freeJournal = jn;
    a.year = $('f-year-paper').value.trim();
    a.month = $('f-month-paper').value.trim();
    a.day = $('f-day-paper').value.trim();
    a.volume = $('f-volume').value.trim();
    a.issue = $('f-issue').value.trim();
    a.pages = $('f-pages').value.trim();
    a.reviewed = $('f-reviewed').checked;
    a.doi = $('f-doi').value.trim();
  } else if (kind === 'conference') {
    a.title = $('f-title-conf').value.trim();
    const cn = $('f-conference').value.trim();
    a.conferenceId = resolve(m.conferences, cn, {}, 'cnf');
    if (!a.conferenceId) a.freeConference = cn;
    a.year = $('f-year-conf').value.trim();
    a.month = $('f-month-conf').value.trim();
    a.day = $('f-day-conf').value.trim();
    a.presentationNumber = $('f-number').value.trim();
    a.venue = $('f-venue-conf').value.trim();
  } else {
    a.title = $('f-title-other').value.trim();
    const cn = $('f-conference-other').value.trim();
    a.conferenceId = resolve(m.conferences, cn, {}, 'cnf');
    if (!a.conferenceId) a.freeConference = cn;
    a.year = $('f-year-other').value.trim();
    a.month = $('f-month-other').value.trim();
    a.day = $('f-day-other').value.trim();
    a.venue = $('f-venue-other').value.trim();
    a.note = $('f-note').value.trim();
  }
  return a;
}

/** 入力内容のプレビューを更新する（マスタは変更しない） */
function updatePreview() {
  const a = collectAchievement({ commitMasters: false });
  const html = formatItem(app.db, a, 'html');
  $('f-preview').innerHTML = html.trim() === '' ? '（入力すると、ここに業績リストでの表示が出ます）' : html;
}
const FORM_FIELDS = ['f-title-paper', 'f-journal', 'f-journal-abbr', 'f-year-paper', 'f-month-paper',
  'f-day-paper', 'f-volume', 'f-issue', 'f-pages', 'f-doi',
  'f-title-conf', 'f-conference', 'f-year-conf', 'f-month-conf', 'f-day-conf', 'f-number', 'f-venue-conf',
  'f-title-other', 'f-conference-other', 'f-year-other', 'f-month-other', 'f-day-other',
  'f-venue-other', 'f-note'];
FORM_FIELDS.forEach((id) => $(id).addEventListener('input', updatePreview));

// ジャーナル名を確定したら、登録済みの略称を補う
$('f-journal').addEventListener('change', () => {
  const j = app.db.masters.journals.find((x) => x.name === $('f-journal').value.trim());
  if (j && $('f-journal-abbr').value.trim() === '' && String(j.abbr ?? '').trim() !== '') {
    $('f-journal-abbr').value = j.abbr;
    updatePreview();
  }
});

function clearForm() {
  const cat = $('f-category').value;
  FORM_FIELDS.forEach((id) => { $(id).value = ''; });
  $('f-doi-fetch').value = '';
  setDoiState('');
  app.authors = [emptyAuthor()];
  app.editingId = null;
  $('f-editing').classList.add('hidden');
  $('f-category').value = cat;
  renderAuthors();
  applyKind();
}
$('f-clear').addEventListener('click', () => { clearForm(); setStatus('入力をクリアしました'); });
$('f-new').addEventListener('click', () => { clearForm(); setStatus('新規入力に戻しました'); });

$('f-save').addEventListener('click', async () => {
  const preview = collectAchievement({ commitMasters: false });
  if (!preview.authors.length) { await showMessage('入力エラー', '著者を1名以上入力してください。'); return; }
  if (preview.title === '') { await showMessage('入力エラー', 'タイトルを入力してください。'); return; }
  if (String(preview.year).trim() === '') { await showMessage('入力エラー', '年を入力してください。'); return; }

  const a = collectAchievement({ commitMasters: true });
  if (app.editingId) {
    const i = app.db.achievements.findIndex((x) => x.id === app.editingId);
    if (i >= 0) app.db.achievements[i] = a;
    persist(`業績を更新しました：${a.title}`);
  } else {
    app.db.achievements.push(a);
    persist(`業績を登録しました（全 ${app.db.achievements.length} 件）：${a.title}`);
  }
  refreshDatalists();
  clearForm();
});

// ══ DOI から書誌情報を取得（CrossRef）══

function setDoiState(text, kind = '') {
  const e = $('f-doi-state');
  e.textContent = text;
  e.className = `doi-state${kind ? ` ${kind}` : ''}`;
}

$('f-doi-go').addEventListener('click', async () => {
  const raw = $('f-doi-fetch').value.trim();
  if (raw === '') { await showMessage('入力エラー', 'DOI を入力してください。'); return; }
  let doi;
  try { doi = normalizeDoi(raw); }
  catch (e) { setDoiState(e.message, 'bad'); await showMessage('DOI の形式エラー', e.message); return; }

  const b = $('f-doi-go');
  b.disabled = true;
  setDoiState('CrossRef に問い合わせ中…', 'busy');
  setStatus(`DOI を照会しています: ${doi}`);
  let meta;
  try {
    meta = await fetchByDoi(doi);
  } catch (e) {
    setDoiState(e.message, 'bad');
    b.disabled = false;
    await showMessage('取得できませんでした', e.message);
    setStatus('DOI の取得に失敗しました', true);
    return;
  }
  b.disabled = false;

  if (kindOf($('f-category').value) !== 'paper') {
    $('f-category').value = 'journal_reviewed';
    applyKind();
  }
  if (meta.title) $('f-title-paper').value = meta.title;
  if (meta.journal) $('f-journal').value = meta.journal;
  if (meta.journalAbbr) $('f-journal-abbr').value = meta.journalAbbr;
  if (meta.year) $('f-year-paper').value = meta.year;
  if (meta.month) $('f-month-paper').value = meta.month;
  if (meta.day) $('f-day-paper').value = meta.day;
  if (meta.volume) $('f-volume').value = meta.volume;
  if (meta.issue) $('f-issue').value = meta.issue;
  if (meta.pages) $('f-pages').value = meta.pages;
  $('f-doi').value = meta.doi || doi;

  if ($('f-doi-authors').checked && meta.authors.length) {
    let registered = 0;
    app.authors = meta.authors.map((x) => {
      const ids = [];
      if (x.affiliation) {
        const r = addAffiliation(app.db, x.affiliation, '');
        if (r.created) registered += 1;
        ids.push(r.id);
      }
      // 氏名が登録済みで所属が無ければ、既定の所属を使う
      const p = findPerson(x.name);
      if (!ids.length && p) ids.push(...(p.affiliationIds ?? []));
      return { ...emptyAuthor(), freeName: x.name, affiliationIds: ids };
    });
    if (registered) persist(`CrossRef の所属 ${registered} 件を記憶しました`);
    refreshDatalists();
    renderAuthors();
  }
  updatePreview();
  const parts = [`${meta.authors.length}名の著者`, meta.journal || '誌名なし', meta.year || '年不明'];
  setDoiState(`取得しました（${parts.join(' / ')}）`, 'ok');
  setStatus(`DOI から書誌情報を取得しました: ${meta.title || doi}`);
});
$('f-doi-fetch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('f-doi-go').click(); }
});

// サンプル入力
$('f-demo').addEventListener('click', () => {
  $('f-category').value = 'conf_dom_oral';
  applyKind();
  const aist = addAffiliation(app.db, '産業技術総合研究所', '産総研').id;
  const ut = addAffiliation(app.db, '東京大学', '東京大').id;
  persist();
  refreshDatalists();
  app.authors = [
    { ...emptyAuthor(), freeName: (app.db.profile.selfNames ?? [])[0] ?? '儀武滉大', affiliationIds: [ut, aist] },
    { ...emptyAuthor(), freeName: '井口亮', affiliationIds: [aist] },
  ];
  renderAuthors();
  $('f-title-conf').value = '南西諸島における造礁サンゴの細菌叢解析';
  $('f-conference').value = '日本生態学会第72回全国大会';
  $('f-year-conf').value = '2025';
  $('f-month-conf').value = '3';
  $('f-day-conf').value = '15';
  $('f-number').value = 'I01-01';
  updatePreview();
  setStatus('サンプルを入力しました（所属「産業技術総合研究所／産総研」「東京大学／東京大」を記憶しました）');
});

// ══════════ 業績一覧 ══════════

function filteredAchievements() {
  const cat = $('l-category').value;
  const kw = $('l-search').value.trim().toLowerCase();
  const order = $('l-order').value;
  let list = app.db.achievements.slice();
  if (cat) list = list.filter((a) => a.categoryId === cat);
  if (kw) {
    list = list.filter((a) => {
      const authors = (a.authors ?? []).map((au) => `${authorName(app.db, au)} ${authorAffiliation(app.db, au, false)}`).join(' ');
      const src = [a.title, authors, journalLabel(app.db, a), conferenceLabel(app.db, a), a.note]
        .join(' ').toLowerCase();
      return src.includes(kw);
    });
  }
  const sign = order === 'desc' ? -1 : 1;
  list.sort((x, y) => sign * (dateKey(x) - dateKey(y)));
  return list;
}

function renderList() {
  const list = filteredAchievements();
  $('l-count').textContent = `${list.length} 件 / 全 ${app.db.achievements.length} 件`;
  const tbody = $('l-table').querySelector('tbody');
  tbody.innerHTML = '';
  list.forEach((a, i) => {
    const tr = document.createElement('tr');
    const d = [a.year, a.month, a.day].filter((v) => String(v).trim() !== '').join('/');
    const src = kindOf(a.categoryId) === 'paper' ? journalLabel(app.db, a) : conferenceLabel(app.db, a);
    const authors = formatAuthors(app.db, a, { withAffiliation: false }).parts.map((p) => p.name).join('・');
    [String(i + 1), CATEGORY_MAP[a.categoryId]?.label ?? a.categoryId, d, a.title, src, authors]
      .forEach((v, ci) => {
        const td = document.createElement('td');
        td.textContent = v;
        if (ci === 0) td.className = 'num';
        else if (ci === 3) td.className = 'left w-title';
        else if (ci !== 2) td.className = 'left';
        tr.appendChild(td);
      });
    const ops = el('td', 'ops');
    const ed = btn('編集', 'mini');
    const cp = btn('複製', 'mini');
    const dl = btn('削除', 'mini danger');
    ed.addEventListener('click', () => loadIntoForm(a.id));
    cp.addEventListener('click', () => {
      app.db.achievements.push({ ...JSON.parse(JSON.stringify(a)), id: newId('ach') });
      persist('業績を複製しました'); renderList();
    });
    dl.addEventListener('click', async () => {
      if (!await askYesNo('削除の確認', `「${a.title}」を削除しますか？この操作は取り消せません。`)) return;
      app.db.achievements = app.db.achievements.filter((x) => x.id !== a.id);
      persist('業績を削除しました'); renderList();
    });
    ops.append(ed, cp, dl);
    tr.appendChild(ops);
    tbody.appendChild(tr);
  });
}
['l-category', 'l-search', 'l-order'].forEach((id) => {
  $(id).addEventListener('input', renderList);
  $(id).addEventListener('change', renderList);
});

/** 一覧から入力フォームへ読み込む */
function loadIntoForm(id) {
  const a = findById(app.db.achievements, id);
  if (!a) return;
  app.editingId = a.id;
  $('f-editing').classList.remove('hidden');
  $('f-category').value = a.categoryId;
  applyKind();
  app.authors = (a.authors ?? []).map((au) => {
    const p = findById(app.db.masters.persons, au.personId);
    return {
      ...emptyAuthor(),
      freeName: p ? p.name : (au.freeName ?? ''),
      affiliationIds: (au.affiliationIds ?? []).slice(),
    };
  });
  if (!app.authors.length) app.authors = [emptyAuthor()];

  const kind = kindOf(a.categoryId);
  if (kind === 'paper') {
    $('f-title-paper').value = a.title;
    const j = findById(app.db.masters.journals, a.journalId);
    $('f-journal').value = j ? j.name : (a.freeJournal ?? '');
    $('f-journal-abbr').value = j ? (j.abbr ?? '') : '';
    $('f-year-paper').value = a.year; $('f-month-paper').value = a.month; $('f-day-paper').value = a.day;
    $('f-volume').value = a.volume; $('f-issue').value = a.issue; $('f-pages').value = a.pages;
    $('f-reviewed').checked = !!a.reviewed; $('f-doi').value = a.doi ?? '';
  } else if (kind === 'conference') {
    $('f-title-conf').value = a.title;
    const c = findById(app.db.masters.conferences, a.conferenceId);
    $('f-conference').value = c ? c.name : (a.freeConference ?? '');
    $('f-year-conf').value = a.year; $('f-month-conf').value = a.month; $('f-day-conf').value = a.day;
    $('f-number').value = a.presentationNumber ?? ''; $('f-venue-conf').value = a.venue ?? '';
  } else {
    $('f-title-other').value = a.title;
    const c = findById(app.db.masters.conferences, a.conferenceId);
    $('f-conference-other').value = c ? c.name : (a.freeConference ?? '');
    $('f-year-other').value = a.year; $('f-month-other').value = a.month; $('f-day-other').value = a.day;
    $('f-venue-other').value = a.venue ?? ''; $('f-note').value = a.note ?? '';
  }
  document.querySelector('.nb-tabs .nb-tab[data-page="entry"]').click();
  setStatus(`編集中: ${a.title}`);
}

// ══════════ 業績リスト出力 ══════════

function renderOutputCategories() {
  const box = $('o-categories');
  if (box.dataset.ready === '1') return;
  box.innerHTML = '';
  CATEGORIES.forEach((c) => {
    const label = el('label', 'chk');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = c.id; cb.checked = true;
    cb.addEventListener('change', renderOutput);
    label.append(cb, document.createTextNode(c.label));
    box.appendChild(label);
  });
  box.dataset.ready = '1';
}
function selectedCategories() {
  return [...$('o-categories').querySelectorAll('input:checked')].map((c) => c.value);
}
function outputOptions() {
  return {
    order: $('o-order').value,
    title: $('o-title').value.trim() || defaultTitle(),
    categoryIds: selectedCategories(),
  };
}
function renderOutput() {
  renderOutputCategories();
  if ($('o-title').value.trim() === '') $('o-title').value = defaultTitle();
  const opts = outputOptions();
  const groups = groupByCategory(
    app.db.achievements.filter((a) => opts.categoryIds.includes(a.categoryId)), opts.order,
  );
  const body = groups.map((g) => {
    const lis = g.items.map((a) => `<li>${formatItem(app.db, a, 'html')}</li>`).join('');
    return `<h3>${g.category.label}</h3><ul>${lis}</ul>`;
  }).join('');
  const n = groups.reduce((s, g) => s + g.items.length, 0);
  $('o-preview').innerHTML = n === 0
    ? '<p class="empty">出力できる業績がありません。区分の選択を確認してください。</p>'
    : `<h2>${opts.title}</h2>${body}`;
}
$('o-refresh').addEventListener('click', () => { renderOutput(); setStatus('プレビューを更新しました'); });
['o-title', 'o-order'].forEach((id) => $(id).addEventListener('change', renderOutput));
$('o-all-on').addEventListener('click', () => {
  $('o-categories').querySelectorAll('input').forEach((c) => { c.checked = true; }); renderOutput();
});
$('o-all-off').addEventListener('click', () => {
  $('o-categories').querySelectorAll('input').forEach((c) => { c.checked = false; }); renderOutput();
});

$('o-html').addEventListener('click', () => {
  downloadFile(fileName('html'), buildList(app.db, 'html', outputOptions()), 'text/html;charset=utf-8');
  setStatus('HTML を保存しました（Word に貼り付けると書式が保たれます）');
});
$('o-md').addEventListener('click', () => {
  downloadFile(fileName('md'), buildList(app.db, 'markdown', outputOptions()), 'text/markdown;charset=utf-8');
  setStatus('Markdown を保存しました');
});
$('o-txt').addEventListener('click', () => {
  downloadFile(fileName('txt'), buildList(app.db, 'plain', outputOptions()), 'text/plain;charset=utf-8');
  setStatus('テキストを保存しました');
});
$('o-csv').addEventListener('click', () => {
  downloadFile(fileName('csv'), '\uFEFF' + buildCsv(app.db, outputOptions()), 'text/csv;charset=utf-8');
  setStatus('CSV を保存しました（Excel で開けます）');
});
$('o-bib').addEventListener('click', () => {
  downloadFile(exportFileName('bibtex'), buildBibtex(app.db, outputOptions()), 'application/x-bibtex;charset=utf-8');
  setStatus('BibTeX を保存しました（Zotero・EndNote に読み込めます）');
});
$('o-ris').addEventListener('click', () => {
  downloadFile(exportFileName('ris'), buildRis(app.db, outputOptions()),
    'application/x-research-info-systems;charset=utf-8');
  setStatus('RIS を保存しました（Zotero・EndNote・Mendeley に読み込めます）');
});
$('o-kakenhi').addEventListener('click', () => {
  downloadFile(exportFileName('kakenhi'), buildKakenhi(app.db, outputOptions()), 'text/plain;charset=utf-8');
  setStatus('科研費様式（研究発表）を保存しました');
});
$('o-copy').addEventListener('click', async () => {
  const e = $('o-preview');
  try {
    const item = new ClipboardItem({
      'text/html': new Blob([e.innerHTML], { type: 'text/html' }),
      'text/plain': new Blob([e.innerText], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
    setStatus('書式付きでコピーしました（Word などに貼り付けられます）');
  } catch {
    await copyText(e.innerText);
    setStatus('テキストとしてコピーしました');
  }
});
$('o-print').addEventListener('click', () => {
  const w = window.open('', '_blank');
  if (!w) { showMessage('印刷', 'ポップアップがブロックされました。許可してから再実行してください。'); return; }
  w.document.write(buildList(app.db, 'html', outputOptions()));
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
});

// ══════════ 年度別集計 ══════════

function renderYearly() {
  const basis = $('y-basis').value;
  const { rows, categories } = summarizeByYear(app.db, basis);
  const unit = basis === 'fiscal' ? '年度' : '年';
  const withYear = rows.reduce((s, r) => s + r.total, 0);
  const noYear = app.db.achievements.length - withYear;
  const peak = rows.reduce((b, r) => (r.total > (b?.total ?? 0) ? r : b), null);
  const avg = rows.length ? (withYear / rows.length).toFixed(1) : '0';

  $('y-summary').innerHTML = rows.length === 0
    ? '<div class="stat-line">集計できる業績がありません。</div>'
    : `<div class="stat-line">対象 <b>${withYear}</b> 件 / ${rows.length} ${unit}
         （${rows[0].year}${unit} 〜 ${rows[rows.length - 1].year}${unit}）</div>
       <div class="stat-line">1${unit}あたり平均 <b>${avg}</b> 件
         ／ 最多は <b>${peak.year}${unit}</b> の <b>${peak.total}</b> 件
         ${noYear > 0 ? `／ 年が未入力で集計対象外: ${noYear} 件` : ''}</div>`;

  const max = rows.reduce((mx, r) => Math.max(mx, r.total), 0);
  $('y-chart').innerHTML = rows.length === 0 ? '<span class="hint">データがありません。</span>'
    : rows.map((r) => `
      <div class="ybar-row">
        <span class="ybar-year">${r.year}${unit}</span>
        <span class="ybar-track"><span class="ybar-fill" style="width:${max ? (r.total / max) * 100 : 0}%"></span></span>
        <span class="ybar-num">${r.total}</span>
      </div>`).join('');

  const thead = $('y-table').querySelector('thead');
  const tbody = $('y-table').querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';
  if (!rows.length) return;

  const trh = document.createElement('tr');
  [unit, ...categories.map((c) => CATEGORY_MAP[c].label), '合計'].forEach((h, i) => {
    const th = el('th', i === 0 ? 'w-year' : '', h);
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', 'left strong', `${r.year}${unit}`));
    categories.forEach((c) => {
      const n = r.byCategory[c] ?? 0;
      tr.appendChild(el('td', '', n === 0 ? '' : String(n)));
    });
    tr.appendChild(el('td', 'total', String(r.total)));
    tbody.appendChild(tr);
  });
  const trf = el('tr', 'sum-row');
  trf.appendChild(el('td', 'left strong', '合計'));
  categories.forEach((c) => {
    trf.appendChild(el('td', '', String(rows.reduce((s, r) => s + (r.byCategory[c] ?? 0), 0))));
  });
  trf.appendChild(el('td', 'total', String(withYear)));
  tbody.appendChild(trf);
}
$('y-basis').addEventListener('change', () => {
  renderYearly();
  setStatus(`集計単位を${$('y-basis').value === 'fiscal' ? '年度' : '暦年'}に切り替えました`);
});
$('y-csv').addEventListener('click', () => {
  downloadFile(exportFileName('yearly'), '\uFEFF' + buildYearlyCsv(app.db, $('y-basis').value), 'text/csv;charset=utf-8');
  setStatus('年度別集計表を CSV で保存しました');
});

// ══════════ マスタ管理 ══════════

/** マスタ編集フォームの状態（追加 / 編集中）を切り替える */
function setMasterEdit(kind, id) {
  app.masterEdit[kind] = id;
  const editing = !!id;
  $(`m-${kind}-add`).textContent = editing ? '更新' : '追加';
  $(`m-${kind}-cancel`).classList.toggle('hidden', !editing);
  $(`m-${kind}-editing`).classList.toggle('hidden', !editing);
}
const MASTER_FIELDS = {
  aff: ['m-aff-name', 'm-aff-short'],
  person: ['m-person-name', 'm-person-en'],
  jnl: ['m-jnl-name', 'm-jnl-abbr'],
  cnf: ['m-cnf-name'],
};
function resetMasterForm(kind) {
  MASTER_FIELDS[kind].forEach((id) => { $(id).value = ''; });
  if (kind === 'person') [...$('m-person-aff').options].forEach((o) => { o.selected = false; });
  setMasterEdit(kind, null);
}
Object.keys(MASTER_FIELDS).forEach((kind) => {
  $(`m-${kind}-cancel`).addEventListener('click', () => { resetMasterForm(kind); setStatus('編集をやめました'); });
});

function renderMasters() {
  $('m-selfnames').value = (app.db.profile.selfNames ?? []).join('\n');

  // 共著者の既定所属（複数選択）
  const affSel = $('m-person-aff');
  const keep = new Set([...affSel.options].filter((o) => o.selected).map((o) => o.value));
  affSel.innerHTML = '';
  sortedAffiliations(app.db).forEach((a) => {
    const o = document.createElement('option');
    o.value = a.id; o.textContent = affiliationLabel(a);
    o.selected = keep.has(a.id);
    affSel.appendChild(o);
  });

  const table = (tblId, rows) => {
    const tbody = $(tblId).querySelector('tbody');
    tbody.innerHTML = '';
    rows.forEach((cells) => {
      const tr = document.createElement('tr');
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        if (c instanceof Object && c.nodeType) td.appendChild(c);
        else { td.textContent = c; td.className = i === cells.length - 2 ? 'num' : 'left'; }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  };
  const opsCell = (type, kind, item, onEdit) => {
    const span = el('span', 'ops');
    const ed = btn('編集', 'mini');
    ed.addEventListener('click', () => { onEdit(); setMasterEdit(kind, item.id); });
    const dl = btn('削除', 'mini danger');
    dl.addEventListener('click', async () => {
      const r = removeMaster(app.db, type, item.id);
      if (!r.removed) {
        await showMessage('削除できません',
          `この項目は ${r.used} 件で使用されています（業績、または共著者の既定の所属）。先にそちらを修正してください。`);
        return;
      }
      if (app.masterEdit[kind] === item.id) resetMasterForm(kind);
      persist('マスタから削除しました'); renderMasters(); refreshDatalists();
    });
    span.append(ed, dl);
    return span;
  };
  const usage = (type, id) => String(countMasterUsage(app.db, type, id));

  table('m-aff-table', sortedAffiliations(app.db).map((a) => [
    a.name, a.shortName ?? '', usage('affiliations', a.id),
    opsCell('affiliations', 'aff', a, () => {
      $('m-aff-name').value = a.name; $('m-aff-short').value = a.shortName ?? '';
    })]));
  table('m-person-table', app.db.masters.persons.map((p) => {
    const affs = (p.affiliationIds ?? []).map((id) => findById(app.db.masters.affiliations, id))
      .filter(Boolean).map((a) => a.shortName || a.name).join('・');
    return [p.name, p.nameEn ?? '', affs, usage('persons', p.id),
      opsCell('persons', 'person', p, () => {
        $('m-person-name').value = p.name;
        $('m-person-en').value = p.nameEn ?? '';
        [...$('m-person-aff').options].forEach((o) => { o.selected = (p.affiliationIds ?? []).includes(o.value); });
      })];
  }));
  table('m-jnl-table', app.db.masters.journals.map((j) => [
    j.name, j.abbr ?? '', usage('journals', j.id),
    opsCell('journals', 'jnl', j, () => { $('m-jnl-name').value = j.name; $('m-jnl-abbr').value = j.abbr ?? ''; })]));
  table('m-cnf-table', app.db.masters.conferences.map((c) => [
    c.name, usage('conferences', c.id),
    opsCell('conferences', 'cnf', c, () => { $('m-cnf-name').value = c.name; })]));
}

$('m-save-self').addEventListener('click', () => {
  app.db.profile.selfNames = $('m-selfnames').value.split('\n').map((s) => s.trim()).filter(Boolean);
  persist('自分の氏名表記を保存しました');
  renderAuthors();
});

/** 名称の重複（別 ID で同名）を確認する */
function duplicateName(list, name, exceptId) {
  return list.some((x) => x.name.trim() === name && x.id !== exceptId);
}

$('m-aff-add').addEventListener('click', async () => {
  const name = $('m-aff-name').value.trim();
  const short = $('m-aff-short').value.trim();
  if (name === '') { await showMessage('入力エラー', '所属の名称を入力してください。'); return; }
  const editId = app.masterEdit.aff;
  if (editId) {
    if (duplicateName(app.db.masters.affiliations, name, editId)) {
      await showMessage('入力エラー', `「${name}」は既に登録されています。`); return;
    }
    const a = findById(app.db.masters.affiliations, editId);
    a.name = name; a.shortName = short;
    persist(`所属を更新しました：${affiliationLabel(a)}`);
  } else {
    const r = addAffiliation(app.db, name, short, { updateShortName: true });
    const a = findById(app.db.masters.affiliations, r.id);
    persist(r.created ? `所属を登録しました：${affiliationLabel(a)}` : `所属の略称を更新しました：${affiliationLabel(a)}`);
  }
  resetMasterForm('aff');
  renderMasters(); refreshDatalists();
});
$('m-person-add').addEventListener('click', async () => {
  const name = $('m-person-name').value.trim();
  if (name === '') { await showMessage('入力エラー', '氏名を入力してください。'); return; }
  const affIds = [...$('m-person-aff').options].filter((o) => o.selected).map((o) => o.value);
  const en = $('m-person-en').value.trim();
  const editId = app.masterEdit.person;
  const list = app.db.masters.persons;
  if (editId) {
    if (duplicateName(list, name, editId)) { await showMessage('入力エラー', `「${name}」は既に登録されています。`); return; }
    const p = findById(list, editId);
    Object.assign(p, { name, nameEn: en, affiliationIds: affIds });
  } else {
    const hit = list.find((p) => p.name === name);
    if (hit) Object.assign(hit, { nameEn: en, affiliationIds: affIds });
    else list.push({ id: newId('per'), name, nameEn: en, affiliationIds: affIds });
  }
  persist(`共著者を保存しました：${name}`);
  resetMasterForm('person');
  renderMasters(); refreshDatalists();
});
$('m-jnl-add').addEventListener('click', async () => {
  const name = $('m-jnl-name').value.trim();
  const abbr = $('m-jnl-abbr').value.trim();
  if (name === '') { await showMessage('入力エラー', 'ジャーナル名を入力してください。'); return; }
  const editId = app.masterEdit.jnl;
  const list = app.db.masters.journals;
  if (editId) {
    if (duplicateName(list, name, editId)) { await showMessage('入力エラー', `「${name}」は既に登録されています。`); return; }
    Object.assign(findById(list, editId), { name, abbr });
  } else {
    const hit = list.find((j) => j.name === name);
    if (hit) hit.abbr = abbr;
    else list.push({ id: newId('jnl'), name, abbr });
  }
  persist(`ジャーナルを保存しました：${name}`);
  resetMasterForm('jnl');
  renderMasters(); refreshDatalists();
});
$('m-cnf-add').addEventListener('click', async () => {
  const name = $('m-cnf-name').value.trim();
  if (name === '') { await showMessage('入力エラー', '名称を入力してください。'); return; }
  const editId = app.masterEdit.cnf;
  const list = app.db.masters.conferences;
  if (editId) {
    if (duplicateName(list, name, editId)) { await showMessage('入力エラー', `「${name}」は既に登録されています。`); return; }
    findById(list, editId).name = name;
  } else if (!list.find((c) => c.name === name)) {
    list.push({ id: newId('cnf'), name });
  }
  persist(`大会・講義名を保存しました：${name}`);
  resetMasterForm('cnf');
  renderMasters(); refreshDatalists();
});

// ══════════ データ入出力 ══════════

function renderStats() {
  const s = summarize(app.db);
  const rows = CATEGORIES.filter((c) => s.byCategory[c.id])
    .map((c) => `<tr><td class="left">${c.label}</td><td class="num">${s.byCategory[c.id]}</td></tr>`).join('');
  $('d-stats').innerHTML = `
    <div class="stat-line">業績 <b>${s.total}</b> 件
      ${s.minYear ? `（${s.minYear}年〜${s.maxYear}年）` : ''}</div>
    <div class="stat-line">マスタ: 共著者 <b>${s.persons}</b> / 所属 <b>${s.affiliations}</b>
      / ジャーナル <b>${s.journals}</b> / 大会 <b>${s.conferences}</b></div>
    <div class="stat-line">最終保存: ${app.db.updatedAt ? new Date(app.db.updatedAt).toLocaleString('ja-JP') : '—'}</div>
    ${rows ? `<table class="tbl mini-tbl"><thead><tr><th>区分</th><th>件数</th></tr></thead><tbody>${rows}</tbody></table>` : ''}`;
}

$('d-export').addEventListener('click', () => {
  downloadFile(backupFileName(), exportJson(app.db), 'application/json;charset=utf-8');
  setStatus('バックアップを保存しました。アプリ更新後はこのファイルを読み込んでください');
});
$('d-import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const mode = $('d-import-mode').value;
  try {
    const text = await file.text();
    const { db, added } = importJson(text, mode, app.db);
    app.db = db;
    persist(`読み込みました（${mode === 'replace' ? '置き換え' : `${added} 件を追加`}）`);
    refreshDatalists(); renderStats(); renderMasters(); renderList(); renderAuthors();
    await showMessage('読み込み完了',
      mode === 'replace'
        ? `データを置き換えました。業績 ${app.db.achievements.length} 件。`
        : `${added} 件を追加しました。現在の業績は ${app.db.achievements.length} 件です。`);
  } catch (err) {
    await showMessage('読み込みエラー', err.message);
  } finally {
    e.target.value = '';
  }
});
$('d-reset').addEventListener('click', async () => {
  if (!await askYesNo('初期化の確認',
    'すべての業績とマスタを削除します。この操作は取り消せません。実行しますか？')) return;
  app.db = emptyDb();
  persist('データを初期化しました');
  refreshDatalists(); renderStats(); renderMasters(); renderList(); clearForm();
});

// ══════════ 初期化 ══════════
document.title = APP_TITLE;
fillCategorySelects();
refreshDatalists();
renderAuthors();
applyKind();
renderOutputCategories();
$('o-title').value = defaultTitle();
$('save-state').textContent = app.db.updatedAt
  ? `最終保存 ${new Date(app.db.updatedAt).toLocaleString('ja-JP')}` : '未保存';
setStatus(app.db.achievements.length
  ? `保存済みの業績 ${app.db.achievements.length} 件を読み込みました`
  : '準備完了（最初の業績を入力してください）');
