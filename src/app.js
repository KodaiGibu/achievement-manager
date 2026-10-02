/**
 * 業績管理アプリ — UI レイヤー
 */
import {
  APP_TITLE, CATEGORIES, CATEGORY_MAP, kindOf,
  emptyDb, emptyAchievement, emptyAuthor, newId,
  loadDb, saveDb, upsertMaster, findById, removeMaster, countMasterUsage,
  addAffiliation, affiliationLabel, sortedAffiliations, findAffiliationByEnglish,
  findPersonByEnglish, personLabel,
  groupByCategory, summarize, exportJson, importJson, dateKey,
} from './model.js';
import {
  buildList, buildCsv, formatItem, formatAuthors, journalLabel, conferenceLabel,
  defaultTitle, fileName, backupFileName, authorName, authorAffiliation, affiliationText,
  isSelf, resolveLang,
} from './format.js';
import { fetchByDoi, normalizeDoi } from './crossref.js';
import {
  buildBibtex, buildRis, buildKakenhi, buildYearlyCsv, summarizeByYear, exportFileName,
} from './export-formats.js';

const $ = (id) => document.getElementById(id);
const hasJa = (s) => /[ぁ-んァ-ヶ一-龠々ー]/.test(String(s ?? ''));
const tr = (v) => String(v ?? '').trim();

const app = {
  db: loadDb(),
  editingId: null,
  /** 入力中の著者: { freeName, freeNameEn, affiliationIds: [] } */
  authors: [emptyAuthor()],
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
function input(className, size, placeholder = '', list = '') {
  const i = document.createElement('input');
  i.type = 'text';
  i.className = className;
  i.size = size;
  if (placeholder) i.placeholder = placeholder;
  if (list) i.setAttribute('list', list);
  return i;
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
  [['f-category', false], ['l-category', true]].forEach(([id, withAll]) => {
    const sel = $(id);
    sel.innerHTML = withAll ? '<option value="">すべて</option>' : '';
    CATEGORIES.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.label;
      sel.appendChild(o);
    });
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
$('f-lang').addEventListener('change', updatePreview);

/** datalist（候補）を最新のマスタで更新する。共著者は和文名・英語表記の両方を候補に出す */
function refreshDatalists() {
  const fill = (id, values) => {
    const dl = $(id);
    dl.innerHTML = '';
    [...new Set(values.filter((v) => tr(v) !== ''))].forEach((v) => {
      const o = document.createElement('option');
      o.value = v;
      dl.appendChild(o);
    });
  };
  const m = app.db.masters;
  fill('dl-persons', m.persons.flatMap((p) => [p.name, p.nameEn]));
  fill('dl-affiliations', sortedAffiliations(app.db).map((a) => a.name));
  fill('dl-affiliations-en', sortedAffiliations(app.db).map((a) => a.nameEn));
  fill('dl-journals', m.journals.map((j) => j.name));
  fill('dl-conferences', m.conferences.map((c) => c.name));
}

// ══ 共著者と所属 ══

/** 和文名・英語表記のどちらからでも人物を探す */
function findPerson(text) {
  const n = tr(text);
  if (n === '') return null;
  const ps = app.db.masters.persons;
  return ps.find((p) => p.name === n) ?? ps.find((p) => tr(p.nameEn) === n)
    ?? (hasJa(n) ? null : findPersonByEnglish(app.db, n));
}
function findSelfPerson() {
  return app.db.masters.persons.find((p) => isSelf(app.db, p.name) || isSelf(app.db, p.nameEn)) ?? null;
}

/**
 * 所属（和文名称・略称・英語名称・英語略称）を登録して ID を返す。
 * 登録済みの値と食い違う項目があれば、上書きするか確認する。
 */
async function registerAffiliation(name, fields) {
  let r;
  try { r = addAffiliation(app.db, name, fields); }
  catch (e) { await showMessage('入力エラー', e.message); return null; }
  if (r.conflicts.length) {
    const lines = r.conflicts.map((c) => `・${c.label}：「${c.current}」→「${c.incoming}」`).join('\n');
    const change = await askYesNo('登録内容の確認',
      `「${name || fields.nameEn}」は登録済みです。次の項目が登録内容と異なります。\n${lines}\n\n`
      + '入力した内容で更新しますか？（この所属を使っているすべての業績の出力に反映されます）');
    if (change) r = addAffiliation(app.db, name, fields, { updateExisting: true });
  }
  const aff = findById(app.db.masters.affiliations, r.id);
  if (r.created) persist(`所属を登録しました：${affiliationLabel(aff)}`);
  else if (r.updated) persist(`所属を更新しました：${affiliationLabel(aff)}`);
  else setStatus(`登録済みの所属を追加しました：${affiliationLabel(aff)}`);
  refreshDatalists();
  return r.id;
}

function renderAuthors() {
  const box = $('f-authors');
  box.innerHTML = '';
  app.authors.forEach((au, i) => box.appendChild(buildAuthorRow(au, i)));
  updatePreview();
}

/** 著者 1 名分の行（氏名・英語表記・所属チップ・所属の追加欄） */
function buildAuthorRow(au, i) {
  if (!Array.isArray(au.affiliationIds)) au.affiliationIds = [];
  const row = el('div', 'author-row');

  // ── 1段目: 氏名・英語表記 ──
  const head = el('div', 'a-head');
  head.appendChild(el('span', 'a-no', String(i + 1)));
  const nameLabel = el('label', '', '氏名:');
  const nameInput = input('a-name', 16, '和文名または英語表記', 'dl-persons');
  nameInput.value = au.freeName ?? '';
  nameLabel.appendChild(nameInput);
  const enLabel = el('label', '', '英語表記:');
  const enInput = input('a-name-en', 16, 'Gibu, K.');
  enInput.value = au.freeNameEn ?? '';
  enLabel.appendChild(enInput);
  const selfBadge = el('span', 'a-self', '自分');
  const isMe = () => isSelf(app.db, au.freeName) || isSelf(app.db, au.freeNameEn);
  selfBadge.classList.toggle('hidden', !isMe());
  const ops = el('span', 'a-ops');
  const up = btn('↑', 'mini a-up', '上へ');
  const down = btn('↓', 'mini a-down', '下へ');
  const del = btn('×', 'mini danger a-del', 'この著者を削除');
  ops.append(up, down, del);
  head.append(nameLabel, enLabel, selfBadge, ops);
  row.appendChild(head);

  // ── 2段目: 選択済みの所属 ──
  const affLine = el('div', 'a-affs');
  affLine.appendChild(el('span', 'a-cap', '所属:'));
  const chips = el('span', 'a-chips');
  au.affiliationIds = au.affiliationIds.filter((id) => findById(app.db.masters.affiliations, id));
  if (!au.affiliationIds.length) chips.appendChild(el('span', 'a-none', '（未設定）'));
  au.affiliationIds.forEach((id, k) => {
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
    if (tr(aff.shortName)) chip.appendChild(el('span', 'chip-short', aff.shortName));
    const en = affiliationText(aff, 'en', true);
    const hasEn = tr(aff.nameEn) !== '' || tr(aff.shortNameEn) !== '';
    chip.appendChild(el('span', hasEn ? 'chip-en' : 'chip-en missing', hasEn ? en : '英名未登録'));
    const rm = btn('×', 'chip-btn', 'この所属を外す');
    rm.addEventListener('click', () => { au.affiliationIds.splice(k, 1); renderAuthors(); });
    chip.appendChild(rm);
    chips.appendChild(chip);
  });
  affLine.appendChild(chips);
  row.appendChild(affLine);

  // ── 3段目: 過去の所属から選択 ──
  const pickLine = el('div', 'a-add');
  pickLine.appendChild(el('span', 'a-cap', '過去の所属から選択:'));
  const sel = document.createElement('select');
  sel.className = 'a-aff-select';
  const candidates = sortedAffiliations(app.db).filter((a) => !au.affiliationIds.includes(a.id));
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = candidates.length ? '（所属を選ぶ）' : '（登録済みの所属はありません）';
  sel.appendChild(opt0);
  candidates.forEach((a) => {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = affiliationLabel(a);
    sel.appendChild(o);
  });
  const pickBtn = btn('追加', 'mini a-pick-btn');
  pickLine.append(sel, pickBtn);
  row.appendChild(pickLine);

  // ── 4段目: 新しい所属（和文・英文）──
  const newLine = el('div', 'a-add a-newaff');
  newLine.appendChild(el('span', 'a-cap', '新しい所属:'));
  const nName = input('a-new-name', 18, '名称（産業技術総合研究所）', 'dl-affiliations');
  const nShort = input('a-new-short', 8, '略称（産総研）');
  const nNameEn = input('a-new-name-en', 22, '英語名称', 'dl-affiliations-en');
  const nShortEn = input('a-new-short-en', 8, '英語略称（AIST）');
  const nBtn = btn('登録して追加', 'mini accent a-new-btn');
  newLine.append(nName, nShort, nNameEn, nShortEn, nBtn);
  row.appendChild(newLine);

  // ── イベント ──
  nameInput.addEventListener('input', () => {
    au.freeName = nameInput.value;
    selfBadge.classList.toggle('hidden', !isMe());
    updatePreview();
  });
  enInput.addEventListener('input', () => {
    au.freeNameEn = enInput.value;
    selfBadge.classList.toggle('hidden', !isMe());
    updatePreview();
  });
  // 和文名・英語表記のどちらで確定しても、登録済みの人物に紐づける
  const bindPerson = (value) => {
    const p = findPerson(value);
    if (!p) return false;
    au.freeName = p.name;
    if (tr(p.nameEn) !== '') au.freeNameEn = p.nameEn;
    if (au.affiliationIds.length === 0 && (p.affiliationIds ?? []).length) {
      au.affiliationIds = p.affiliationIds.filter((id) => findById(app.db.masters.affiliations, id));
    }
    renderAuthors();
    setStatus(`登録済みの共著者を選びました：${personLabel(p)}`);
    return true;
  };
  nameInput.addEventListener('change', () => bindPerson(nameInput.value));
  enInput.addEventListener('change', () => {
    if (tr(au.freeName) === '') bindPerson(enInput.value);
  });

  const addPicked = () => {
    if (!sel.value) return;
    if (!au.affiliationIds.includes(sel.value)) au.affiliationIds.push(sel.value);
    renderAuthors();
  };
  pickBtn.addEventListener('click', addPicked);
  sel.addEventListener('change', addPicked);

  // 登録済みの名称（和文・英文）を入力したら残りの項目を補う
  const fillFrom = (aff) => {
    if (!aff) return;
    if (tr(nName.value) === '') nName.value = aff.name;
    if (tr(nShort.value) === '') nShort.value = aff.shortName ?? '';
    if (tr(nNameEn.value) === '') nNameEn.value = aff.nameEn ?? '';
    if (tr(nShortEn.value) === '') nShortEn.value = aff.shortNameEn ?? '';
  };
  nName.addEventListener('change', () => fillFrom(app.db.masters.affiliations.find((a) => a.name === tr(nName.value))));
  nNameEn.addEventListener('change', () => fillFrom(findAffiliationByEnglish(app.db, nNameEn.value)));

  const addNew = async () => {
    const name = tr(nName.value);
    const fields = { shortName: tr(nShort.value), nameEn: tr(nNameEn.value), shortNameEn: tr(nShortEn.value) };
    if (name === '' && fields.nameEn === '') {
      await showMessage('入力エラー', '新しい所属の名称（または英語名称）を入力してください。');
      return;
    }
    const id = await registerAffiliation(name, fields);
    if (!id) return;
    if (!au.affiliationIds.includes(id)) au.affiliationIds.push(id);
    renderAuthors();
  };
  nBtn.addEventListener('click', addNew);
  [nName, nShort, nNameEn, nShortEn].forEach((x) => x.addEventListener('keydown', (e) => {
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

$('f-add-author').addEventListener('click', () => { app.authors.push(emptyAuthor()); renderAuthors(); });
$('f-add-self').addEventListener('click', () => {
  const me = findSelfPerson();
  const names = app.db.profile.selfNames ?? [];
  app.authors.unshift({
    ...emptyAuthor(),
    freeName: me ? me.name : (names.find(hasJa) ?? names[0] ?? ''),
    freeNameEn: me ? (me.nameEn ?? '') : (names.find((n) => !hasJa(n)) ?? ''),
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
  a.lang = $('f-lang').value;
  const m = app.db.masters;

  a.authors = app.authors.map((au) => {
    const nm = tr(au.freeName);
    const en = tr(au.freeNameEn);
    const name = nm || en;
    if (name === '') return null;
    const affIds = (au.affiliationIds ?? []).filter((id) => findById(m.affiliations, id));
    // プレビュー時はマスタを変更せず、入力中の氏名・英語表記をそのまま使う
    if (!commitMasters) return { personId: '', freeName: name, freeNameEn: en, affiliationIds: affIds, freeAffiliation: '' };
    const personId = upsertMaster(m.persons, { name, nameEn: en, affiliationIds: affIds.slice() }, 'name', 'per');
    // 入力欄で英語表記を明示した場合は、それを正として更新する
    const p = findById(m.persons, personId);
    if (en !== '' && p.nameEn !== en) p.nameEn = en;
    return { personId, freeName: '', freeNameEn: '', affiliationIds: affIds, freeAffiliation: '' };
  }).filter(Boolean);

  const resolve = (list, value, extra, prefix) => {
    const v = tr(value);
    if (v === '') return '';
    if (commitMasters) return upsertMaster(list, { name: v, ...extra }, 'name', prefix);
    return list.find((x) => x.name === v)?.id ?? '';
  };

  if (kind === 'paper') {
    a.title = tr($('f-title-paper').value);
    const jn = tr($('f-journal').value);
    a.journalId = resolve(m.journals, jn, { abbr: tr($('f-journal-abbr').value) }, 'jnl');
    if (!a.journalId) a.freeJournal = jn;
    a.year = tr($('f-year-paper').value);
    a.month = tr($('f-month-paper').value);
    a.day = tr($('f-day-paper').value);
    a.volume = tr($('f-volume').value);
    a.issue = tr($('f-issue').value);
    a.pages = tr($('f-pages').value);
    a.reviewed = $('f-reviewed').checked;
    a.doi = tr($('f-doi').value);
  } else if (kind === 'conference') {
    a.title = tr($('f-title-conf').value);
    const cn = tr($('f-conference').value);
    a.conferenceId = resolve(m.conferences, cn, {}, 'cnf');
    if (!a.conferenceId) a.freeConference = cn;
    a.year = tr($('f-year-conf').value);
    a.month = tr($('f-month-conf').value);
    a.day = tr($('f-day-conf').value);
    a.presentationNumber = tr($('f-number').value);
    a.venue = tr($('f-venue-conf').value);
  } else {
    a.title = tr($('f-title-other').value);
    const cn = tr($('f-conference-other').value);
    a.conferenceId = resolve(m.conferences, cn, {}, 'cnf');
    if (!a.conferenceId) a.freeConference = cn;
    a.year = tr($('f-year-other').value);
    a.month = tr($('f-month-other').value);
    a.day = tr($('f-day-other').value);
    a.venue = tr($('f-venue-other').value);
    a.note = tr($('f-note').value);
  }
  return a;
}

/** プレビューと、英語表記時の英名未登録の警告を更新する */
function updatePreview() {
  const a = collectAchievement({ commitMasters: false });
  const lang = resolveLang(app.db, a);
  const mode = $('f-lang').value;
  $('f-lang-state').textContent = `→ ${lang === 'en' ? '英語表記' : '日本語表記'}で出力${mode === 'auto' ? '（自動）' : ''}`;
  $('f-lang-state').classList.toggle('en', lang === 'en');

  const warn = $('f-lang-warn');
  if (lang === 'en') {
    const noName = app.authors.filter((au) => tr(au.freeName) && !tr(au.freeNameEn)).map((au) => au.freeName);
    const noAff = [...new Set(app.authors.flatMap((au) => au.affiliationIds ?? []))]
      .map((id) => findById(app.db.masters.affiliations, id))
      .filter((x) => x && !tr(x.nameEn) && !tr(x.shortNameEn)).map((x) => x.name);
    const msgs = [];
    if (noName.length) msgs.push(`英語表記が未入力の著者：${noName.join('、')}`);
    if (noAff.length) msgs.push(`英語名称が未登録の所属：${noAff.join('、')}（マスタ管理で登録できます）`);
    warn.textContent = msgs.length ? `${msgs.join(' ／ ')} — 未登録の分は和文で出力されます。` : '';
    warn.classList.toggle('hidden', msgs.length === 0);
  } else {
    warn.classList.add('hidden');
  }

  const html = formatItem(app.db, a, 'html');
  $('f-preview').innerHTML = html.trim() === '' ? '（入力すると、ここに業績リストでの表示が出ます）' : html;
}
const FORM_FIELDS = ['f-title-paper', 'f-journal', 'f-journal-abbr', 'f-year-paper', 'f-month-paper',
  'f-day-paper', 'f-volume', 'f-issue', 'f-pages', 'f-doi',
  'f-title-conf', 'f-conference', 'f-year-conf', 'f-month-conf', 'f-day-conf', 'f-number', 'f-venue-conf',
  'f-title-other', 'f-conference-other', 'f-year-other', 'f-month-other', 'f-day-other',
  'f-venue-other', 'f-note'];
FORM_FIELDS.forEach((id) => $(id).addEventListener('input', updatePreview));

$('f-journal').addEventListener('change', () => {
  const j = app.db.masters.journals.find((x) => x.name === tr($('f-journal').value));
  if (j && tr($('f-journal-abbr').value) === '' && tr(j.abbr) !== '') {
    $('f-journal-abbr').value = j.abbr;
    updatePreview();
  }
});

function clearForm() {
  const cat = $('f-category').value;
  FORM_FIELDS.forEach((id) => { $(id).value = ''; });
  $('f-doi-fetch').value = '';
  $('f-lang').value = 'auto';
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
  if (tr(preview.year) === '') { await showMessage('入力エラー', '年を入力してください。'); return; }

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

/** CrossRef の英語の所属名を、登録済みの所属に紐づける（無ければ英語名称として登録） */
function bindCrossrefAffiliation(text) {
  const hit = findAffiliationByEnglish(app.db, text);
  if (hit) return { id: hit.id, created: false };
  const r = addAffiliation(app.db, text, { nameEn: text });
  return { id: r.id, created: r.created };
}

$('f-doi-go').addEventListener('click', async () => {
  const raw = tr($('f-doi-fetch').value);
  if (raw === '') { await showMessage('入力エラー', 'DOI を入力してください。'); return; }
  let doi;
  try { doi = normalizeDoi(raw); }
  catch (e) { setDoiState(e.message, 'bad'); await showMessage('DOI の形式エラー', e.message); return; }

  const b = $('f-doi-go');
  b.disabled = true;
  setDoiState('CrossRef に問い合わせ中…', 'busy');
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

  let matched = 0;
  let newAff = 0;
  if ($('f-doi-authors').checked && meta.authors.length) {
    app.authors = meta.authors.map((x) => {
      const p = findPersonByEnglish(app.db, x.name);
      const ids = [];
      if (x.affiliation) {
        const r = bindCrossrefAffiliation(x.affiliation);
        if (r.created) newAff += 1;
        ids.push(r.id);
      }
      if (p) {
        matched += 1;
        if (!ids.length) ids.push(...(p.affiliationIds ?? []));
        return { ...emptyAuthor(), freeName: p.name, freeNameEn: p.nameEn || x.name, affiliationIds: ids };
      }
      return { ...emptyAuthor(), freeName: x.name, freeNameEn: x.name, affiliationIds: ids };
    });
    if (newAff) persist();
    refreshDatalists();
    renderAuthors();
  }
  updatePreview();
  setDoiState(`取得しました（著者${meta.authors.length}名のうち登録済み${matched}名に紐づけ${newAff ? `・所属${newAff}件を記憶` : ''}）`, 'ok');
  setStatus(`DOI から書誌情報を取得しました: ${meta.title || doi}`);
});
$('f-doi-fetch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('f-doi-go').click(); }
});

// サンプル入力（国際学会・英語表記）
$('f-demo').addEventListener('click', () => {
  $('f-category').value = 'conf_intl_oral';
  $('f-lang').value = 'auto';
  applyKind();
  const aist = addAffiliation(app.db, '産業技術総合研究所', {
    shortName: '産総研', nameEn: 'National Institute of Advanced Industrial Science and Technology', shortNameEn: 'AIST',
  }).id;
  const ut = addAffiliation(app.db, '東京大学', {
    shortName: '東京大', nameEn: 'The University of Tokyo', shortNameEn: 'UTokyo',
  }).id;
  persist();
  refreshDatalists();
  app.authors = [
    { ...emptyAuthor(), freeName: '儀武滉大', freeNameEn: 'Gibu, K.', affiliationIds: [ut, aist] },
    { ...emptyAuthor(), freeName: '井口亮', freeNameEn: 'Iguchi, A.', affiliationIds: [aist] },
  ];
  renderAuthors();
  $('f-title-conf').value = 'Microbiome Analysis of Reef-Building Corals in the Ryukyu Islands';
  $('f-conference').value = '1st Asia-Pacific Biodiversity Joint Conference';
  $('f-year-conf').value = '2024';
  $('f-month-conf').value = '10';
  $('f-day-conf').value = '23';
  $('f-number').value = '23-VI-4';
  updatePreview();
  setStatus('サンプルを入力しました（著者・所属の英名を使って英語表記で出力されます）');
});

// ══════════ 業績一覧 ══════════

function filteredAchievements() {
  const cat = $('l-category').value;
  const kw = tr($('l-search').value).toLowerCase();
  const order = $('l-order').value;
  let list = app.db.achievements.slice();
  if (cat) list = list.filter((a) => a.categoryId === cat);
  if (kw) {
    list = list.filter((a) => {
      const authors = (a.authors ?? []).map((au) => [
        authorName(app.db, au, 'ja'), authorName(app.db, au, 'en'),
        authorAffiliation(app.db, au, false, 'ja'), authorAffiliation(app.db, au, false, 'en'),
      ].join(' ')).join(' ');
      return [a.title, authors, journalLabel(app.db, a), conferenceLabel(app.db, a), a.note]
        .join(' ').toLowerCase().includes(kw);
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
    const row = document.createElement('tr');
    const lang = resolveLang(app.db, a);
    const d = [a.year, a.month, a.day].filter((v) => tr(v) !== '').join('/');
    const src = kindOf(a.categoryId) === 'paper' ? journalLabel(app.db, a) : conferenceLabel(app.db, a);
    const authors = formatAuthors(app.db, a, { lang, withAffiliation: false }).parts.map((p) => p.name)
      .join(lang === 'en' ? ', ' : '・');
    [String(i + 1), CATEGORY_MAP[a.categoryId]?.label ?? a.categoryId,
      `${lang === 'en' ? '英' : '和'}${a.lang === 'auto' ? '（自動）' : ''}`, d, a.title, src, authors]
      .forEach((v, ci) => {
        const td = el('td', '', v);
        if (ci === 0) td.className = 'num';
        else if (ci === 4) td.className = 'left w-title';
        else if (ci === 1 || ci >= 5) td.className = 'left';
        row.appendChild(td);
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
    row.appendChild(ops);
    tbody.appendChild(row);
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
  $('f-lang').value = a.lang ?? 'auto';
  applyKind();
  app.authors = (a.authors ?? []).map((au) => {
    const p = findById(app.db.masters.persons, au.personId);
    return {
      ...emptyAuthor(),
      freeName: p ? p.name : (au.freeName ?? ''),
      freeNameEn: p ? (p.nameEn ?? '') : (au.freeNameEn ?? ''),
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
  return { order: $('o-order').value, title: tr($('o-title').value) || defaultTitle(), categoryIds: selectedCategories() };
}
function renderOutput() {
  renderOutputCategories();
  if (tr($('o-title').value) === '') $('o-title').value = defaultTitle();
  const opts = outputOptions();
  const groups = groupByCategory(app.db.achievements.filter((a) => opts.categoryIds.includes(a.categoryId)), opts.order);
  const body = groups.map((g) => `<h3>${g.category.label}</h3><ul>${
    g.items.map((a) => `<li>${formatItem(app.db, a, 'html')}</li>`).join('')}</ul>`).join('');
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
  setStatus('CSV を保存しました（和文・英文の著者と所属を含みます）');
});
$('o-bib').addEventListener('click', () => {
  downloadFile(exportFileName('bibtex'), buildBibtex(app.db, outputOptions()), 'application/x-bibtex;charset=utf-8');
  setStatus('BibTeX を保存しました');
});
$('o-ris').addEventListener('click', () => {
  downloadFile(exportFileName('ris'), buildRis(app.db, outputOptions()), 'application/x-research-info-systems;charset=utf-8');
  setStatus('RIS を保存しました');
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
       <div class="stat-line">1${unit}あたり平均 <b>${avg}</b> 件 ／ 最多は <b>${peak.year}${unit}</b> の <b>${peak.total}</b> 件
         ${noYear > 0 ? `／ 年が未入力で集計対象外: ${noYear} 件` : ''}</div>`;
  const max = rows.reduce((mx, r) => Math.max(mx, r.total), 0);
  $('y-chart').innerHTML = rows.length === 0 ? '<span class="hint">データがありません。</span>'
    : rows.map((r) => `<div class="ybar-row"><span class="ybar-year">${r.year}${unit}</span>
        <span class="ybar-track"><span class="ybar-fill" style="width:${max ? (r.total / max) * 100 : 0}%"></span></span>
        <span class="ybar-num">${r.total}</span></div>`).join('');

  const thead = $('y-table').querySelector('thead');
  const tbody = $('y-table').querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';
  if (!rows.length) return;
  const trh = document.createElement('tr');
  [unit, ...categories.map((c) => CATEGORY_MAP[c].label), '合計'].forEach((h, i) => trh.appendChild(el('th', i === 0 ? 'w-year' : '', h)));
  thead.appendChild(trh);
  rows.forEach((r) => {
    const row = document.createElement('tr');
    row.appendChild(el('td', 'left strong', `${r.year}${unit}`));
    categories.forEach((c) => row.appendChild(el('td', '', r.byCategory[c] ? String(r.byCategory[c]) : '')));
    row.appendChild(el('td', 'total', String(r.total)));
    tbody.appendChild(row);
  });
  const trf = el('tr', 'sum-row');
  trf.appendChild(el('td', 'left strong', '合計'));
  categories.forEach((c) => trf.appendChild(el('td', '', String(rows.reduce((s, r) => s + (r.byCategory[c] ?? 0), 0)))));
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

const MASTER_FIELDS = {
  aff: ['m-aff-name', 'm-aff-short', 'm-aff-name-en', 'm-aff-short-en'],
  person: ['m-person-name', 'm-person-en'],
  jnl: ['m-jnl-name', 'm-jnl-abbr'],
  cnf: ['m-cnf-name'],
};
function setMasterEdit(kind, id) {
  app.masterEdit[kind] = id;
  const editing = !!id;
  $(`m-${kind}-add`).textContent = editing ? '更新' : '追加';
  $(`m-${kind}-cancel`).classList.toggle('hidden', !editing);
  $(`m-${kind}-editing`).classList.toggle('hidden', !editing);
}
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
  const s = summarize(app.db);
  $('m-aff-en-count').textContent = `英名登録 ${s.affiliationsWithEn} / ${s.affiliations}`;
  $('m-person-en-count').textContent = `英語表記登録 ${s.personsWithEn} / ${s.persons}`;

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
      const row = document.createElement('tr');
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        if (c && typeof c === 'object' && c.nodeType) td.appendChild(c);
        else {
          td.textContent = c;
          td.className = i === cells.length - 2 ? 'num' : 'left';
          if (c === '') td.classList.add('blank');
        }
        row.appendChild(td);
      });
      tbody.appendChild(row);
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
    a.name, a.shortName ?? '', a.nameEn ?? '', a.shortNameEn ?? '', usage('affiliations', a.id),
    opsCell('affiliations', 'aff', a, () => {
      $('m-aff-name').value = a.name; $('m-aff-short').value = a.shortName ?? '';
      $('m-aff-name-en').value = a.nameEn ?? ''; $('m-aff-short-en').value = a.shortNameEn ?? '';
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

function duplicateName(list, name, exceptId) {
  return list.some((x) => x.name.trim() === name && x.id !== exceptId);
}

$('m-aff-add').addEventListener('click', async () => {
  const name = tr($('m-aff-name').value);
  const fields = {
    shortName: tr($('m-aff-short').value),
    nameEn: tr($('m-aff-name-en').value),
    shortNameEn: tr($('m-aff-short-en').value),
  };
  if (name === '') { await showMessage('入力エラー', '所属の名称を入力してください。'); return; }
  const editId = app.masterEdit.aff;
  if (editId) {
    if (duplicateName(app.db.masters.affiliations, name, editId)) {
      await showMessage('入力エラー', `「${name}」は既に登録されています。`); return;
    }
    const a = findById(app.db.masters.affiliations, editId);
    Object.assign(a, { name, ...fields });
    persist(`所属を更新しました：${affiliationLabel(a)}`);
  } else {
    const r = addAffiliation(app.db, name, fields, { updateExisting: true });
    const a = findById(app.db.masters.affiliations, r.id);
    persist(r.created ? `所属を登録しました：${affiliationLabel(a)}` : `所属を更新しました：${affiliationLabel(a)}`);
  }
  resetMasterForm('aff');
  renderMasters(); refreshDatalists();
});
$('m-person-add').addEventListener('click', async () => {
  const name = tr($('m-person-name').value);
  if (name === '') { await showMessage('入力エラー', '氏名を入力してください。'); return; }
  const affIds = [...$('m-person-aff').options].filter((o) => o.selected).map((o) => o.value);
  const en = tr($('m-person-en').value);
  const editId = app.masterEdit.person;
  const list = app.db.masters.persons;
  if (editId) {
    if (duplicateName(list, name, editId)) { await showMessage('入力エラー', `「${name}」は既に登録されています。`); return; }
    Object.assign(findById(list, editId), { name, nameEn: en, affiliationIds: affIds });
  } else {
    const hit = list.find((p) => p.name === name);
    if (hit) Object.assign(hit, { nameEn: en, affiliationIds: affIds });
    else list.push({ id: newId('per'), name, nameEn: en, affiliationIds: affIds });
  }
  persist(`共著者を保存しました：${en ? `${name} / ${en}` : name}`);
  resetMasterForm('person');
  renderMasters(); refreshDatalists();
});
$('m-jnl-add').addEventListener('click', async () => {
  const name = tr($('m-jnl-name').value);
  const abbr = tr($('m-jnl-abbr').value);
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
  const name = tr($('m-cnf-name').value);
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
    <div class="stat-line">業績 <b>${s.total}</b> 件 ${s.minYear ? `（${s.minYear}年〜${s.maxYear}年）` : ''}</div>
    <div class="stat-line">マスタ: 共著者 <b>${s.persons}</b>（英語表記 ${s.personsWithEn}）
      / 所属 <b>${s.affiliations}</b>（英語名称 ${s.affiliationsWithEn}）
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
    await showMessage('読み込み完了', mode === 'replace'
      ? `データを置き換えました。業績 ${app.db.achievements.length} 件。`
      : `${added} 件を追加しました。現在の業績は ${app.db.achievements.length} 件です。`);
  } catch (err) {
    await showMessage('読み込みエラー', err.message);
  } finally {
    e.target.value = '';
  }
});
$('d-reset').addEventListener('click', async () => {
  if (!await askYesNo('初期化の確認', 'すべての業績とマスタを削除します。この操作は取り消せません。実行しますか？')) return;
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
