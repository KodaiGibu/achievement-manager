/**
 * 業績管理アプリ — UI レイヤー
 */
import {
  APP_TITLE, CATEGORIES, CATEGORY_MAP, kindOf,
  emptyDb, emptyAchievement, emptyAuthor, newId,
  loadDb, saveDb, upsertMaster, findById, removeMaster, countMasterUsage,
  groupByCategory, summarize, exportJson, importJson, dateKey,
} from './model.js';
import {
  buildList, buildCsv, formatItem, formatAuthors, journalLabel, conferenceLabel,
  defaultTitle, fileName, backupFileName, authorName,
} from './format.js';
import { fetchByDoi, normalizeDoi } from './crossref.js';
import {
  buildBibtex, buildRis, buildKakenhi, buildYearlyCsv,
  summarizeByYear, yearlyBar, exportFileName,
} from './export-formats.js';

const $ = (id) => document.getElementById(id);

const app = {
  db: loadDb(),
  editingId: null,        // 編集中の業績 ID（null なら新規）
  authors: [emptyAuthor()],
};

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
document.querySelectorAll('.nb-tabs .nb-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    document.querySelectorAll('.nb-tabs .nb-tab').forEach((b) => b.classList.toggle('active', b === btn));
    ['entry', 'list', 'output', 'yearly', 'master', 'data'].forEach((p) => {
      $(`page-${p}`).classList.toggle('hidden', p !== page);
    });
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
  document.querySelector('.kind-paper').classList.toggle('hidden', kind !== 'paper');
  document.querySelector('.kind-conference').classList.toggle('hidden', kind !== 'conference');
  document.querySelector('.kind-other').classList.toggle('hidden', kind !== 'other');
  // 査読の有無は区分の既定値に合わせる
  const cat = CATEGORY_MAP[$('f-category').value];
  if (kind === 'paper' && typeof cat?.reviewed === 'boolean') $('f-reviewed').checked = cat.reviewed;
  updatePreview();
}
$('f-category').addEventListener('change', applyKind);

/** datalist（候補）を最新のマスタで更新する */
function refreshDatalists() {
  const set = (id, items, label = (x) => x.name) => {
    const dl = $(id);
    dl.innerHTML = '';
    items.forEach((x) => {
      const o = document.createElement('option');
      o.value = label(x);
      dl.appendChild(o);
    });
  };
  set('dl-persons', app.db.masters.persons);
  set('dl-affiliations', app.db.masters.affiliations);
  set('dl-journals', app.db.masters.journals);
  set('dl-conferences', app.db.masters.conferences);
}

/** 著者行を描画する */
function renderAuthors() {
  const box = $('f-authors');
  box.innerHTML = '';
  app.authors.forEach((au, i) => {
    const row = document.createElement('div');
    row.className = 'author-row';
    const person = findById(app.db.masters.persons, au.personId);
    const nameVal = person ? person.name : (au.freeName ?? '');
    const affNames = (au.affiliationIds ?? []).map((id) => findById(app.db.masters.affiliations, id))
      .filter(Boolean).map((a) => a.name);
    if (String(au.freeAffiliation ?? '').trim() !== '') affNames.push(au.freeAffiliation.trim());

    row.innerHTML = `
      <span class="a-no">${i + 1}</span>
      <label>氏名:<input type="text" class="a-name" list="dl-persons" size="16"></label>
      <label>所属:<input type="text" class="a-aff" list="dl-affiliations" size="26"
        placeholder="複数は「・」で区切る"></label>
      <span class="a-self hidden">自分</span>
      <span class="a-ops">
        <button type="button" class="mini a-up" title="上へ">↑</button>
        <button type="button" class="mini a-down" title="下へ">↓</button>
        <button type="button" class="mini danger a-del" title="削除">×</button>
      </span>`;
    row.querySelector('.a-name').value = nameVal;
    row.querySelector('.a-aff').value = affNames.join('・');
    box.appendChild(row);

    const sync = () => {
      const nm = row.querySelector('.a-name').value.trim();
      const af = row.querySelector('.a-aff').value.trim();
      au.freeName = nm;
      au.personId = '';   // 保存時にマスタ登録して ID を解決する
      au.freeAffiliation = af;
      au.affiliationIds = [];
      const isSelf = (app.db.profile.selfNames ?? []).some((s) => s.replace(/\s+/g, '') === nm.replace(/\s+/g, ''));
      row.querySelector('.a-self').classList.toggle('hidden', !isSelf);
      updatePreview();
    };
    row.querySelectorAll('input').forEach((el) => el.addEventListener('input', sync));
    // 氏名を確定したとき、その人の既定所属を自動で補う
    row.querySelector('.a-name').addEventListener('change', () => {
      const nm = row.querySelector('.a-name').value.trim();
      const hit = app.db.masters.persons.find((p) => p.name === nm);
      if (hit && row.querySelector('.a-aff').value.trim() === '') {
        const names = (hit.affiliationIds ?? []).map((id) => findById(app.db.masters.affiliations, id))
          .filter(Boolean).map((a) => a.name);
        if (names.length) { row.querySelector('.a-aff').value = names.join('・'); sync(); }
      }
    });
    row.querySelector('.a-up').addEventListener('click', () => {
      if (i === 0) return;
      [app.authors[i - 1], app.authors[i]] = [app.authors[i], app.authors[i - 1]];
      renderAuthors(); updatePreview();
    });
    row.querySelector('.a-down').addEventListener('click', () => {
      if (i === app.authors.length - 1) return;
      [app.authors[i + 1], app.authors[i]] = [app.authors[i], app.authors[i + 1]];
      renderAuthors(); updatePreview();
    });
    row.querySelector('.a-del').addEventListener('click', () => {
      if (app.authors.length <= 1) { app.authors[0] = emptyAuthor(); }
      else app.authors.splice(i, 1);
      renderAuthors(); updatePreview();
    });
    sync();
  });
}
$('f-add-author').addEventListener('click', () => {
  app.authors.push(emptyAuthor());
  renderAuthors();
});
$('f-add-self').addEventListener('click', () => {
  const me = (app.db.profile.selfNames ?? [])[0] ?? '';
  const aff = app.db.profile.defaultAffiliation ?? '';
  app.authors.unshift({ ...emptyAuthor(), freeName: me, freeAffiliation: aff });
  renderAuthors(); updatePreview();
});

/** 入力欄から業績レコードを組み立てる（マスタ登録も行う） */
function collectAchievement({ commitMasters = true } = {}) {
  const categoryId = $('f-category').value;
  const kind = kindOf(categoryId);
  const a = emptyAchievement(categoryId);
  if (app.editingId) a.id = app.editingId;

  // 著者（マスタへ登録して ID を解決）
  a.authors = app.authors.map((au) => {
    const nm = String(au.freeName ?? '').trim();
    if (nm === '') return null;
    const affNames = String(au.freeAffiliation ?? '').split(/[・,、]/).map((s) => s.trim()).filter(Boolean);
    let affIds = [];
    if (commitMasters) {
      affIds = affNames.map((n) => upsertMaster(app.db.masters.affiliations, { name: n, shortName: '' }, 'name', 'aff'));
    } else {
      affIds = affNames.map((n) => (app.db.masters.affiliations.find((x) => x.name === n) ?? {}).id).filter(Boolean);
    }
    let personId = '';
    if (commitMasters) {
      personId = upsertMaster(app.db.masters.persons,
        { name: nm, nameEn: '', affiliationIds: affIds }, 'name', 'per');
    } else {
      personId = (app.db.masters.persons.find((p) => p.name === nm) ?? {}).id ?? '';
    }
    const unresolved = affNames.filter((n, i) => !affIds[i]);
    return {
      personId,
      freeName: personId ? '' : nm,
      affiliationIds: affIds.filter(Boolean),
      freeAffiliation: unresolved.join('・'),
    };
  }).filter(Boolean);

  if (kind === 'paper') {
    a.title = $('f-title-paper').value.trim();
    const jn = $('f-journal').value.trim();
    const abbr = $('f-journal-abbr').value.trim();
    if (jn !== '') {
      if (commitMasters) a.journalId = upsertMaster(app.db.masters.journals, { name: jn, abbr }, 'name', 'jnl');
      else a.journalId = (app.db.masters.journals.find((x) => x.name === jn) ?? {}).id ?? '';
      if (!a.journalId) a.freeJournal = jn;
    }
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
    if (cn !== '') {
      if (commitMasters) a.conferenceId = upsertMaster(app.db.masters.conferences, { name: cn }, 'name', 'cnf');
      else a.conferenceId = (app.db.masters.conferences.find((x) => x.name === cn) ?? {}).id ?? '';
      if (!a.conferenceId) a.freeConference = cn;
    }
    a.year = $('f-year-conf').value.trim();
    a.month = $('f-month-conf').value.trim();
    a.day = $('f-day-conf').value.trim();
    a.presentationNumber = $('f-number').value.trim();
    a.venue = $('f-venue-conf').value.trim();
  } else {
    a.title = $('f-title-other').value.trim();
    const cn = $('f-conference-other').value.trim();
    if (cn !== '') {
      if (commitMasters) a.conferenceId = upsertMaster(app.db.masters.conferences, { name: cn }, 'name', 'cnf');
      else a.conferenceId = (app.db.masters.conferences.find((x) => x.name === cn) ?? {}).id ?? '';
      if (!a.conferenceId) a.freeConference = cn;
    }
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
['f-title-paper', 'f-journal', 'f-journal-abbr', 'f-year-paper', 'f-month-paper', 'f-day-paper',
  'f-volume', 'f-issue', 'f-pages', 'f-doi',
  'f-title-conf', 'f-conference', 'f-year-conf', 'f-month-conf', 'f-day-conf', 'f-number', 'f-venue-conf',
  'f-title-other', 'f-conference-other', 'f-year-other', 'f-month-other', 'f-day-other',
  'f-venue-other', 'f-note'].forEach((id) => {
  $(id).addEventListener('input', updatePreview);
});

function clearForm(keepCategory = true) {
  const cat = $('f-category').value;
  ['f-title-paper', 'f-journal', 'f-journal-abbr', 'f-year-paper', 'f-month-paper', 'f-day-paper',
    'f-volume', 'f-issue', 'f-pages', 'f-doi',
    'f-title-conf', 'f-conference', 'f-year-conf', 'f-month-conf', 'f-day-conf', 'f-number', 'f-venue-conf',
    'f-title-other', 'f-conference-other', 'f-year-other', 'f-month-other', 'f-day-other',
    'f-venue-other', 'f-note'].forEach((id) => { $(id).value = ''; });
  app.authors = [emptyAuthor()];
  app.editingId = null;
  $('f-editing').classList.add('hidden');
  if (keepCategory) $('f-category').value = cat;
  renderAuthors();
  applyKind();
}
$('f-clear').addEventListener('click', () => { clearForm(); setStatus('入力をクリアしました'); });
$('f-new').addEventListener('click', () => { clearForm(); setStatus('新規入力に戻しました'); });

$('f-save').addEventListener('click', async () => {
  const a = collectAchievement({ commitMasters: true });
  if (!a.authors.length) { await showMessage('入力エラー', '著者を1名以上入力してください。'); return; }
  if (a.title === '') { await showMessage('入力エラー', 'タイトルを入力してください。'); return; }
  if (String(a.year).trim() === '') { await showMessage('入力エラー', '年を入力してください。'); return; }

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
  const el = $('f-doi-state');
  el.textContent = text;
  el.className = `doi-state${kind ? ` ${kind}` : ''}`;
}

$('f-doi-go').addEventListener('click', async () => {
  const raw = $('f-doi-fetch').value.trim();
  if (raw === '') { await showMessage('入力エラー', 'DOI を入力してください。'); return; }

  let doi;
  try { doi = normalizeDoi(raw); }
  catch (e) { setDoiState(e.message, 'bad'); await showMessage('DOI の形式エラー', e.message); return; }

  const btn = $('f-doi-go');
  btn.disabled = true;
  setDoiState('CrossRef に問い合わせ中…', 'busy');
  setStatus(`DOI を照会しています: ${doi}`);

  let meta;
  try {
    meta = await fetchByDoi(doi);
  } catch (e) {
    setDoiState(e.message, 'bad');
    btn.disabled = false;
    await showMessage('取得できませんでした', e.message);
    setStatus('DOI の取得に失敗しました', true);
    return;
  }
  btn.disabled = false;

  // 論文用の区分に切り替える（学会区分のままなら査読有の論文にする）
  if (kindOf($('f-category').value) !== 'paper') {
    $('f-category').value = 'journal_reviewed';
    applyKind();
  }
  // 取得した値を入力欄へ反映（空欄のみ上書きせず、取得値を優先する）
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
    app.authors = meta.authors.map((x) => ({
      ...emptyAuthor(), freeName: x.name, freeAffiliation: x.affiliation ?? '',
    }));
    renderAuthors();
  }
  updatePreview();
  const parts = [`${meta.authors.length}名の著者`, meta.journal || '誌名なし', meta.year || '年不明'];
  setDoiState(`取得しました（${parts.join(' / ')}）`, 'ok');
  setStatus(`DOI から書誌情報を取得しました: ${meta.title || doi}`);
});

// DOI 欄で Enter を押しても取得できるようにする
$('f-doi-fetch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('f-doi-go').click(); }
});

// サンプル入力
$('f-demo').addEventListener('click', () => {
  $('f-category').value = 'journal_reviewed';
  applyKind();
  app.authors = [
    { ...emptyAuthor(), freeName: (app.db.profile.selfNames ?? [])[0] ?? '儀武滉大' },
    { ...emptyAuthor(), freeName: '井口亮', freeAffiliation: '産業技術総合研究所' },
  ];
  renderAuthors();
  $('f-title-paper').value = 'Polyamine impact on physiology of early stages of reef-building corals';
  $('f-journal').value = 'Scientific Reports';
  $('f-journal-abbr').value = 'Sci Rep';
  $('f-year-paper').value = '2024';
  $('f-volume').value = '14';
  $('f-issue').value = '1';
  $('f-pages').value = '23465';
  updatePreview();
  setStatus('サンプルを入力しました。「この内容で登録」で保存できます');
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
      const authors = (a.authors ?? []).map((au) => authorName(app.db, au)).join(' ');
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
        if (ci === 3) td.className = 'left w-title';
        if (ci === 1 || ci === 4 || ci === 5) td.className = 'left';
        tr.appendChild(td);
      });
    const ops = document.createElement('td');
    ops.className = 'ops';
    ops.innerHTML = `<button type="button" class="mini e-edit">編集</button>
      <button type="button" class="mini e-copy">複製</button>
      <button type="button" class="mini danger e-del">削除</button>`;
    ops.querySelector('.e-edit').addEventListener('click', () => loadIntoForm(a.id));
    ops.querySelector('.e-copy').addEventListener('click', () => {
      const clone = { ...JSON.parse(JSON.stringify(a)), id: newId('ach') };
      app.db.achievements.push(clone);
      persist('業績を複製しました'); renderList();
    });
    ops.querySelector('.e-del').addEventListener('click', async () => {
      if (!await askYesNo('削除の確認', `「${a.title}」を削除しますか？この操作は取り消せません。`)) return;
      app.db.achievements = app.db.achievements.filter((x) => x.id !== a.id);
      persist('業績を削除しました'); renderList();
    });
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
    const affs = (au.affiliationIds ?? []).map((x) => findById(app.db.masters.affiliations, x))
      .filter(Boolean).map((x) => x.name);
    if (String(au.freeAffiliation ?? '').trim() !== '') affs.push(au.freeAffiliation.trim());
    return { ...emptyAuthor(), freeName: p ? p.name : (au.freeName ?? ''), freeAffiliation: affs.join('・') };
  });
  if (!app.authors.length) app.authors = [emptyAuthor()];
  renderAuthors();

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
  updatePreview();
  document.querySelector('.nb-tabs .nb-tab[data-page="entry"]').click();
  setStatus(`編集中: ${a.title}`);
}

// ══════════ 業績リスト出力 ══════════

function renderOutputCategories() {
  const box = $('o-categories');
  if (box.dataset.ready === '1') return;
  box.innerHTML = '';
  CATEGORIES.forEach((c) => {
    const label = document.createElement('label');
    label.className = 'chk';
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
  downloadFile(exportFileName('bibtex'), buildBibtex(app.db, outputOptions()),
    'application/x-bibtex;charset=utf-8');
  setStatus('BibTeX を保存しました（Zotero・EndNote に読み込めます）');
});
$('o-ris').addEventListener('click', () => {
  downloadFile(exportFileName('ris'), buildRis(app.db, outputOptions()),
    'application/x-research-info-systems;charset=utf-8');
  setStatus('RIS を保存しました（Zotero・EndNote・Mendeley に読み込めます）');
});
$('o-kakenhi').addEventListener('click', () => {
  downloadFile(exportFileName('kakenhi'), buildKakenhi(app.db, outputOptions()),
    'text/plain;charset=utf-8');
  setStatus('科研費様式（研究発表）を保存しました');
});
$('o-copy').addEventListener('click', async () => {
  const el = $('o-preview');
  try {
    const item = new ClipboardItem({
      'text/html': new Blob([el.innerHTML], { type: 'text/html' }),
      'text/plain': new Blob([el.innerText], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
    setStatus('書式付きでコピーしました（Word などに貼り付けられます）');
  } catch {
    await copyText(el.innerText);
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

  // 概要
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

  // 推移バー
  const max = rows.reduce((m, r) => Math.max(m, r.total), 0);
  $('y-chart').innerHTML = rows.length === 0 ? '<span class="hint">データがありません。</span>'
    : rows.map((r) => `
      <div class="ybar-row">
        <span class="ybar-year">${r.year}${unit}</span>
        <span class="ybar-track"><span class="ybar-fill" style="width:${max ? (r.total / max) * 100 : 0}%"></span></span>
        <span class="ybar-num">${r.total}</span>
      </div>`).join('');

  // 明細表
  const thead = $('y-table').querySelector('thead');
  const tbody = $('y-table').querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';
  if (!rows.length) return;

  const trh = document.createElement('tr');
  [unit, ...categories.map((c) => CATEGORY_MAP[c].label), '合計'].forEach((h, i) => {
    const th = document.createElement('th');
    th.textContent = h;
    if (i === 0) th.className = 'w-year';
    trh.appendChild(th);
  });
  thead.appendChild(trh);

  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const td0 = document.createElement('td');
    td0.textContent = `${r.year}${unit}`;
    td0.className = 'left strong';
    tr.appendChild(td0);
    categories.forEach((c) => {
      const td = document.createElement('td');
      const n = r.byCategory[c] ?? 0;
      td.textContent = n === 0 ? '' : String(n);
      tr.appendChild(td);
    });
    const tdt = document.createElement('td');
    tdt.textContent = String(r.total);
    tdt.className = 'total';
    tr.appendChild(tdt);
    tbody.appendChild(tr);
  });

  // 合計行
  const trf = document.createElement('tr');
  trf.className = 'sum-row';
  const tdf = document.createElement('td');
  tdf.textContent = '合計'; tdf.className = 'left strong';
  trf.appendChild(tdf);
  categories.forEach((c) => {
    const td = document.createElement('td');
    td.textContent = String(rows.reduce((s, r) => s + (r.byCategory[c] ?? 0), 0));
    trf.appendChild(td);
  });
  const tdft = document.createElement('td');
  tdft.textContent = String(withYear); tdft.className = 'total';
  trf.appendChild(tdft);
  tbody.appendChild(trf);
}
$('y-basis').addEventListener('change', () => {
  renderYearly();
  setStatus(`集計単位を${$('y-basis').value === 'fiscal' ? '年度' : '暦年'}に切り替えました`);
});
$('y-csv').addEventListener('click', () => {
  const basis = $('y-basis').value;
  downloadFile(exportFileName('yearly'), '\uFEFF' + buildYearlyCsv(app.db, basis), 'text/csv;charset=utf-8');
  setStatus('年度別集計表を CSV で保存しました');
});

// ══════════ マスタ管理 ══════════

function renderMasters() {
  $('m-selfnames').value = (app.db.profile.selfNames ?? []).join('\n');

  // 所属プルダウン（共著者の既定所属用）
  const affSel = $('m-person-aff');
  affSel.innerHTML = '<option value="">（未設定）</option>';
  app.db.masters.affiliations.forEach((a) => {
    const o = document.createElement('option');
    o.value = a.id; o.textContent = a.shortName ? `${a.name}（${a.shortName}）` : a.name;
    affSel.appendChild(o);
  });

  const table = (tblId, rows) => {
    const tbody = $(tblId).querySelector('tbody');
    tbody.innerHTML = '';
    rows.forEach((cells) => {
      const tr = document.createElement('tr');
      cells.forEach((c) => {
        const td = document.createElement('td');
        if (c instanceof HTMLElement) td.appendChild(c);
        else { td.textContent = c; td.className = 'left'; }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  };
  const opsCell = (type, item, onEdit) => {
    const span = document.createElement('span');
    span.className = 'ops';
    const ed = document.createElement('button');
    ed.type = 'button'; ed.className = 'mini'; ed.textContent = '編集';
    ed.addEventListener('click', onEdit);
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'mini danger'; del.textContent = '削除';
    del.addEventListener('click', async () => {
      const r = removeMaster(app.db, type, item.id);
      if (!r.removed) {
        await showMessage('削除できません',
          `この項目は ${r.used} 件の業績で使用されています。先に業績側を修正してください。`);
        return;
      }
      persist('マスタから削除しました'); renderMasters(); refreshDatalists();
    });
    span.append(ed, del);
    return span;
  };
  const usageCell = (type, id) => String(countMasterUsage(app.db, type, id));

  table('m-person-table', app.db.masters.persons.map((p) => {
    const affs = (p.affiliationIds ?? []).map((id) => findById(app.db.masters.affiliations, id))
      .filter(Boolean).map((a) => a.name).join('・');
    return [p.name, p.nameEn ?? '', affs, usageCell('persons', p.id),
      opsCell('persons', p, () => {
        $('m-person-name').value = p.name;
        $('m-person-en').value = p.nameEn ?? '';
        $('m-person-aff').value = (p.affiliationIds ?? [])[0] ?? '';
      })];
  }));
  table('m-aff-table', app.db.masters.affiliations.map((a) => [
    a.name, a.shortName ?? '', usageCell('affiliations', a.id),
    opsCell('affiliations', a, () => {
      $('m-aff-name').value = a.name; $('m-aff-short').value = a.shortName ?? '';
    })]));
  table('m-jnl-table', app.db.masters.journals.map((j) => [
    j.name, j.abbr ?? '', usageCell('journals', j.id),
    opsCell('journals', j, () => {
      $('m-jnl-name').value = j.name; $('m-jnl-abbr').value = j.abbr ?? '';
    })]));
  table('m-cnf-table', app.db.masters.conferences.map((c) => [
    c.name, usageCell('conferences', c.id),
    opsCell('conferences', c, () => { $('m-cnf-name').value = c.name; })]));
}

$('m-save-self').addEventListener('click', () => {
  app.db.profile.selfNames = $('m-selfnames').value.split('\n').map((s) => s.trim()).filter(Boolean);
  persist('自分の氏名表記を保存しました');
  renderAuthors(); updatePreview();
});
$('m-person-add').addEventListener('click', () => {
  const name = $('m-person-name').value.trim();
  if (name === '') { showMessage('入力エラー', '氏名を入力してください。'); return; }
  const affId = $('m-person-aff').value;
  const hit = app.db.masters.persons.find((p) => p.name === name);
  if (hit) {
    hit.nameEn = $('m-person-en').value.trim();
    hit.affiliationIds = affId ? [affId] : [];
  } else {
    app.db.masters.persons.push({
      id: newId('per'), name, nameEn: $('m-person-en').value.trim(),
      affiliationIds: affId ? [affId] : [],
    });
  }
  persist(`共著者マスタを保存しました：${name}`);
  ['m-person-name', 'm-person-en'].forEach((id) => { $(id).value = ''; });
  renderMasters(); refreshDatalists();
});
$('m-aff-add').addEventListener('click', () => {
  const name = $('m-aff-name').value.trim();
  if (name === '') { showMessage('入力エラー', '名称を入力してください。'); return; }
  const hit = app.db.masters.affiliations.find((a) => a.name === name);
  if (hit) hit.shortName = $('m-aff-short').value.trim();
  else app.db.masters.affiliations.push({ id: newId('aff'), name, shortName: $('m-aff-short').value.trim() });
  persist(`所属マスタを保存しました：${name}`);
  ['m-aff-name', 'm-aff-short'].forEach((id) => { $(id).value = ''; });
  renderMasters(); refreshDatalists();
});
$('m-jnl-add').addEventListener('click', () => {
  const name = $('m-jnl-name').value.trim();
  if (name === '') { showMessage('入力エラー', '名称を入力してください。'); return; }
  const hit = app.db.masters.journals.find((j) => j.name === name);
  if (hit) hit.abbr = $('m-jnl-abbr').value.trim();
  else app.db.masters.journals.push({ id: newId('jnl'), name, abbr: $('m-jnl-abbr').value.trim() });
  persist(`ジャーナルマスタを保存しました：${name}`);
  ['m-jnl-name', 'm-jnl-abbr'].forEach((id) => { $(id).value = ''; });
  renderMasters(); refreshDatalists();
});
$('m-cnf-add').addEventListener('click', () => {
  const name = $('m-cnf-name').value.trim();
  if (name === '') { showMessage('入力エラー', '名称を入力してください。'); return; }
  if (!app.db.masters.conferences.find((c) => c.name === name)) {
    app.db.masters.conferences.push({ id: newId('cnf'), name });
  }
  persist(`大会・講義名マスタを保存しました：${name}`);
  $('m-cnf-name').value = '';
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
    refreshDatalists(); renderStats(); renderMasters(); renderList();
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
