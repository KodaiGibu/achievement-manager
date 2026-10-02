/**
 * 業績管理アプリ — データモデルとマスタ管理
 *
 * 保存データはすべてブラウザの localStorage に保持し、
 * JSON でのエクスポート / インポートによりアプリ更新をまたいで引き継げる。
 */

export const APP_TITLE = '業績管理アプリ';
export const SCHEMA_VERSION = 4;
export const STORAGE_KEY = 'achievement_db_v1';

/** 所属の階層の最大の深さ（循環参照の保護にも使う） */
export const MAX_AFF_DEPTH = 8;

// ══ 業績区分 ══

export const CATEGORIES = [
  { id: 'journal_reviewed', kind: 'paper', label: '学術雑誌等に発表した論文［査読有］', reviewed: true },
  { id: 'journal_unreviewed', kind: 'paper', label: '学術雑誌等に発表した論文［査読無］', reviewed: false },
  { id: 'conf_dom_oral', kind: 'conference', label: '国内学会等における発表［口頭発表］', scope: 'domestic' },
  { id: 'conf_dom_poster', kind: 'conference', label: '国内学会等における発表［ポスター発表］', scope: 'domestic' },
  { id: 'conf_intl_oral', kind: 'conference', label: '国際学会における発表［口頭発表］', scope: 'international' },
  { id: 'conf_intl_poster', kind: 'conference', label: '国際学会における発表［ポスター発表］', scope: 'international' },
  { id: 'symposium', kind: 'other', label: 'シンポジウム・ワークショップ・招待・依頼講演等' },
  { id: 'lecture', kind: 'other', label: '講義・実習（集中講義等）' },
  { id: 'grant', kind: 'other', label: '競争的資金の獲得' },
  { id: 'award', kind: 'other', label: '受賞' },
  { id: 'other', kind: 'other', label: 'その他の業績' },
];

export const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

export function kindOf(categoryId) {
  return CATEGORY_MAP[categoryId]?.kind ?? 'other';
}

/** 出力時の所属の階層の表し方 */
export const AFF_DISPLAY_OPTIONS = [
  { value: 'full', label: 'すべての階層（機関＋学部・専攻・部門）' },
  { value: 'top', label: '最上位（機関名）のみ' },
  { value: 'leaf', label: '登録した階層のみ（最下位）' },
];

// ══ 既定のデータベース ══

export function emptyDb() {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: {
      selfNames: ['儀武滉大', '儀武 滉大', 'Gibu, K.', 'Gibu K', 'Kodai Gibu', 'Gibu, Kodai'],
      affDisplay: 'full',
    },
    masters: {
      /** {id, name, nameEn, affiliationIds:[]} */
      persons: [],
      /** {id, name, shortName, nameEn, shortNameEn, parentId} — parentId で階層を表す */
      affiliations: [],
      /** {id, name, abbr} */
      journals: [],
      /** {id, name} */
      conferences: [],
    },
    achievements: [],
    updatedAt: null,
  };
}

let seq = 0;
export function newId(prefix = 'id') {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

// ══ 業績レコードの雛形 ══

export function emptyAuthor() {
  return { personId: '', freeName: '', freeNameEn: '', affiliationIds: [], freeAffiliation: '' };
}

export function emptyAchievement(categoryId = 'journal_reviewed') {
  return {
    id: newId('ach'),
    categoryId,
    lang: 'auto',
    authors: [emptyAuthor()],
    title: '',
    journalId: '',
    freeJournal: '',
    year: '',
    month: '',
    day: '',
    volume: '',
    issue: '',
    pages: '',
    reviewed: true,
    doi: '',
    conferenceId: '',
    freeConference: '',
    presentationNumber: '',
    venue: '',
    note: '',
    createdAt: new Date().toISOString(),
  };
}

// ══ 保存・読み込み ══

export function loadDb() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyDb();
    return migrate(JSON.parse(raw));
  } catch {
    return emptyDb();
  }
}

export function saveDb(db) {
  db.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    return true;
  } catch {
    return false;
  }
}

/**
 * 旧バージョンのデータを現行スキーマへ変換する。
 *  v1 → v2: 「A・B」形式の所属文字列を所属マスタへ登録し ID 参照に置き換える
 *  v2 → v3: 所属の英語名称・英語略称、業績の表記言語を追加
 *  v3 → v4: 所属に上位の所属（parentId）を追加。既存の所属はすべて最上位になる
 */
export function migrate(data) {
  const base = emptyDb();
  if (!data || typeof data !== 'object') return base;
  const db = {
    ...base,
    ...data,
    profile: { ...base.profile, ...(data.profile ?? {}) },
    masters: { ...base.masters, ...(data.masters ?? {}) },
    achievements: Array.isArray(data.achievements) ? data.achievements : [],
  };
  if (!AFF_DISPLAY_OPTIONS.some((o) => o.value === db.profile.affDisplay)) db.profile.affDisplay = 'full';
  db.masters.persons = (db.masters.persons ?? []).map((p) => ({
    id: p.id ?? newId('per'), name: p.name ?? '', nameEn: p.nameEn ?? '',
    affiliationIds: Array.isArray(p.affiliationIds) ? p.affiliationIds : [],
  }));
  db.masters.affiliations = (db.masters.affiliations ?? []).map((a) => ({
    id: a.id ?? newId('aff'), name: a.name ?? '', shortName: a.shortName ?? '',
    nameEn: a.nameEn ?? '', shortNameEn: a.shortNameEn ?? '', parentId: a.parentId ?? '',
  }));
  // 存在しない上位、自分自身、循環を指す parentId は最上位へ戻す
  const ids = new Set(db.masters.affiliations.map((a) => a.id));
  db.masters.affiliations.forEach((a) => {
    if (a.parentId && (!ids.has(a.parentId) || a.parentId === a.id)) a.parentId = '';
  });
  db.masters.affiliations.forEach((a) => {
    if (a.parentId && isCyclic(db, a.id)) a.parentId = '';
  });
  db.masters.journals = (db.masters.journals ?? []).map((j) => ({
    id: j.id ?? newId('jnl'), name: j.name ?? '', abbr: j.abbr ?? '',
  }));
  db.masters.conferences = (db.masters.conferences ?? []).map((c) => ({
    id: c.id ?? newId('cnf'), name: c.name ?? '',
  }));
  db.achievements = db.achievements.map((a) => {
    const rec = { ...emptyAchievement(a.categoryId), ...a };
    if (!['auto', 'ja', 'en'].includes(rec.lang)) rec.lang = 'auto';
    rec.authors = (rec.authors ?? []).map((au) => resolveLegacyAffiliations(db, { ...emptyAuthor(), ...au }));
    return rec;
  });
  db.schemaVersion = SCHEMA_VERSION;
  return db;
}

// ══ マスタ操作 ══

const isBlank = (v) => (Array.isArray(v) ? v.length === 0 : String(v ?? '').trim() === '');
const tr = (v) => String(v ?? '').trim();

/** 名称からマスタを検索し、無ければ追加して ID を返す（空欄の項目は補完する） */
export function upsertMaster(list, fields, keyField = 'name', prefix = 'm') {
  const key = String(fields[keyField] ?? '').trim();
  if (key === '') return '';
  const hit = list.find((x) => String(x[keyField]).trim() === key);
  if (hit) {
    Object.entries(fields).forEach(([k, v]) => {
      if (k !== keyField && !isBlank(v) && isBlank(hit[k])) hit[k] = v;
    });
    return hit.id;
  }
  const item = { id: newId(prefix), ...fields };
  list.push(item);
  return item.id;
}

export function findById(list, id) {
  return list.find((x) => x.id === id) ?? null;
}

// ══ 所属の階層 ══

/** 所属の上位をたどって循環しているか */
function isCyclic(db, id) {
  const seen = new Set();
  let cur = findById(db.masters.affiliations, id);
  while (cur && cur.parentId) {
    if (seen.has(cur.id)) return true;
    seen.add(cur.id);
    cur = findById(db.masters.affiliations, cur.parentId);
    if (cur && cur.id === id) return true;
  }
  return false;
}

/**
 * 所属の階層パス（最上位 → 指定の所属）を返す。
 * 例: [東京大学, 大学院理学系研究科, 生物科学専攻]
 */
export function affiliationPath(db, id) {
  const path = [];
  const seen = new Set();
  let cur = findById(db.masters.affiliations, id);
  while (cur && !seen.has(cur.id) && path.length < MAX_AFF_DEPTH) {
    path.unshift(cur);
    seen.add(cur.id);
    cur = cur.parentId ? findById(db.masters.affiliations, cur.parentId) : null;
  }
  return path;
}

/** 所属の深さ（最上位 = 0） */
export function affiliationDepth(db, id) {
  return Math.max(affiliationPath(db, id).length - 1, 0);
}

/** 直下の所属 */
export function childAffiliations(db, id) {
  return db.masters.affiliations.filter((a) => (a.parentId || '') === (id || ''));
}

/** すべての下位の所属の ID（自分は含まない） */
export function descendantIds(db, id) {
  const out = [];
  const walk = (pid) => {
    childAffiliations(db, pid).forEach((c) => {
      if (out.includes(c.id) || c.id === id) return;
      out.push(c.id);
      walk(c.id);
    });
  };
  walk(id);
  return out;
}

/** parentId を上位に設定してよいか（自分自身・自分の下位は不可） */
export function canSetParent(db, id, parentId) {
  if (!parentId) return true;
  if (parentId === id) return false;
  if (!findById(db.masters.affiliations, parentId)) return false;
  if (descendantIds(db, id).includes(parentId)) return false;
  return affiliationDepth(db, parentId) + 1 < MAX_AFF_DEPTH;
}

/**
 * 所属を階層順（親の直後に子）に並べ、深さを付けて返す。
 * 同じ階層の中では名称順。上位が存在しない所属は最上位として扱う。
 * @returns {{aff, depth}[]}
 */
export function affiliationTree(db) {
  const list = db.masters.affiliations;
  const ids = new Set(list.map((a) => a.id));
  const byName = (a, b) => a.name.localeCompare(b.name, 'ja');
  const out = [];
  const visited = new Set();
  const walk = (aff, depth) => {
    if (visited.has(aff.id)) return;
    visited.add(aff.id);
    out.push({ aff, depth });
    list.filter((c) => c.parentId === aff.id).sort(byName).forEach((c) => walk(c, depth + 1));
  };
  list.filter((a) => !a.parentId || !ids.has(a.parentId)).sort(byName).forEach((a) => walk(a, 0));
  // 循環などで到達できなかった所属も漏らさない
  list.filter((a) => !visited.has(a.id)).sort(byName).forEach((a) => walk(a, 0));
  return out;
}

/** 所属マスタを階層順に並べた一覧 */
export function sortedAffiliations(db) {
  return affiliationTree(db).map((x) => x.aff);
}

// ══ 所属の登録（和文名称・略称 ＋ 英語名称・略称 ＋ 上位の所属）══

const AFF_FIELDS = ['shortName', 'nameEn', 'shortNameEn'];
const AFF_LABEL = { shortName: '略称', nameEn: '英語名称', shortNameEn: '英語略称' };

/**
 * 所属を登録する。
 *  - 同じ上位の中で和文名称が同じ所属は重複登録しない（別の大学の「理学部」は別の所属として扱う）
 *  - 英語名称だけが一致する同じ上位の所属もその所属とみなす
 *  - 空欄の略称・英語名称・英語略称は補完し、食い違いは conflicts に返す（updateExisting=true で上書き）
 * @param {{shortName?, nameEn?, shortNameEn?, parentId?}} fields
 */
export function addAffiliation(db, name, fields = {}, { updateExisting = false } = {}) {
  const f = typeof fields === 'string' ? { shortName: fields } : (fields ?? {});
  const n = tr(name);
  const parentId = tr(f.parentId);
  const incoming = Object.fromEntries(AFF_FIELDS.map((k) => [k, tr(f[k])]));
  if (n === '' && incoming.nameEn === '') throw new Error('所属の名称を入力してください。');
  if (parentId && !findById(db.masters.affiliations, parentId)) throw new Error('上位の所属が見つかりません。');
  if (parentId && affiliationDepth(db, parentId) + 1 >= MAX_AFF_DEPTH) {
    throw new Error(`所属の階層は ${MAX_AFF_DEPTH} 段までです。`);
  }

  const list = db.masters.affiliations;
  const hit = (n !== '' ? list.find((a) => a.name.trim() === n && (a.parentId || '') === parentId) : null)
    ?? (incoming.nameEn !== '' ? findAffiliationByEnglish(db, incoming.nameEn, parentId) : null);

  if (!hit) {
    const item = { id: newId('aff'), name: n || incoming.nameEn, ...incoming, parentId };
    list.push(item);
    return { id: item.id, created: true, updated: false, conflicts: [] };
  }
  let updated = false;
  const conflicts = [];
  AFF_FIELDS.forEach((k) => {
    const cur = tr(hit[k]);
    const inc = incoming[k];
    if (inc === '' || inc === cur) return;
    if (cur === '' || updateExisting) { hit[k] = inc; updated = true; return; }
    conflicts.push({ field: k, label: AFF_LABEL[k], current: cur, incoming: inc });
  });
  return { id: hit.id, created: false, updated, conflicts };
}

/**
 * 英語名称・英語略称（または和文名称）が一致する所属を探す（大文字小文字・空白を無視）。
 * parentId を指定するとその上位の直下に限る（null なら全階層・最上位を優先）。
 */
export function findAffiliationByEnglish(db, text, parentId = null) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s.,]+/g, '');
  const t = norm(text);
  if (t === '') return null;
  const match = (a) => [a.nameEn, a.shortNameEn, a.name].some((v) => norm(v) === t);
  if (parentId !== null) {
    return db.masters.affiliations.find((a) => (a.parentId || '') === (parentId || '') && match(a)) ?? null;
  }
  return sortedAffiliations(db).find(match) ?? null;
}

/** 1 つの所属の表示ラベル: 名称（略称） / English Name (Abbr) */
export function affiliationLabel(aff) {
  if (!aff) return '';
  const s = tr(aff.shortName);
  const ja = s ? `${aff.name}（${s}）` : aff.name;
  const en = tr(aff.nameEn);
  const se = tr(aff.shortNameEn);
  if (en === '' && se === '') return ja;
  return `${ja} / ${en || se}${en && se ? ` (${se})` : ''}`;
}

/** 階層を含めた表示ラベル: 東京大学 ＞ 大学院理学系研究科 ＞ 生物科学専攻 */
export function affiliationPathLabel(db, id, sep = ' ＞ ') {
  return affiliationPath(db, id).map((a) => a.name).join(sep);
}

/** 旧形式の所属文字列（「A・B」）を所属マスタ（最上位）へ登録し、affiliationIds へ移す */
export function resolveLegacyAffiliations(db, author) {
  const au = { ...emptyAuthor(), ...author };
  const ids = Array.isArray(au.affiliationIds) ? au.affiliationIds.slice() : [];
  const free = tr(au.freeAffiliation);
  if (free !== '') {
    free.split(/[・,、]/).map((x) => x.trim()).filter(Boolean).forEach((name) => {
      const id = addAffiliation(db, name, {}).id;
      if (id && !ids.includes(id)) ids.push(id);
    });
  }
  au.affiliationIds = ids;
  au.freeAffiliation = '';
  return au;
}

// ══ 人物の英語名 ══

function englishKey(family, given) {
  const f = String(family ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const g = String(given ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return f ? `${f}|${g.slice(0, 1)}` : '';
}

/** "Gibu, Kodai" / "Gibu, K." / "Kodai Gibu" を {family, given} に分解する */
export function splitEnglishName(text) {
  const s = tr(text);
  if (s === '') return { family: '', given: '' };
  if (s.includes(',')) {
    const [family, given] = s.split(',').map((x) => x.trim());
    return { family, given: given ?? '' };
  }
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { family: parts[0], given: '' };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
}

/** 英語名から登録済みの人物を探す（姓＋名の頭文字で照合） */
export function findPersonByEnglish(db, text) {
  const { family, given } = splitEnglishName(text);
  const key = englishKey(family, given);
  if (key === '') return null;
  return db.masters.persons.find((p) => [p.nameEn, p.name].filter((v) => tr(v) !== '').some((v) => {
    const s = splitEnglishName(v);
    return englishKey(s.family, s.given) === key;
  })) ?? null;
}

export function personLabel(p) {
  if (!p) return '';
  const en = tr(p.nameEn);
  return en ? `${p.name} / ${en}` : p.name;
}

// ══ 削除と使用件数 ══

/** マスタ項目を削除する。使用中（所属は下位の所属がある場合も）なら削除しない */
export function removeMaster(db, type, id) {
  const used = countMasterUsage(db, type, id);
  const children = type === 'affiliations' ? childAffiliations(db, id).length : 0;
  if (used > 0 || children > 0) return { removed: false, used, children };
  const list = db.masters[type];
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
  return { removed: true, used: 0, children: 0 };
}

/** マスタ項目が業績（と人物の既定所属）で何件使われているか */
export function countMasterUsage(db, type, id) {
  let n = 0;
  db.achievements.forEach((a) => {
    if (type === 'journals' && a.journalId === id) n += 1;
    if (type === 'conferences' && a.conferenceId === id) n += 1;
    if (type === 'persons' && (a.authors ?? []).some((au) => au.personId === id)) n += 1;
    if (type === 'affiliations' && (a.authors ?? []).some((au) => (au.affiliationIds ?? []).includes(id))) n += 1;
  });
  if (type === 'affiliations') n += db.masters.persons.filter((p) => (p.affiliationIds ?? []).includes(id)).length;
  return n;
}

// ══ 並べ替え ══

export function dateKey(a) {
  return (Number(a.year) || 0) * 10000 + (Number(a.month) || 0) * 100 + (Number(a.day) || 0);
}

export function groupByCategory(achievements, order = 'asc') {
  const map = new Map();
  CATEGORIES.forEach((c) => map.set(c.id, []));
  achievements.forEach((a) => {
    if (!map.has(a.categoryId)) map.set(a.categoryId, []);
    map.get(a.categoryId).push(a);
  });
  const sign = order === 'desc' ? -1 : 1;
  map.forEach((list) => list.sort((x, y) => sign * (dateKey(x) - dateKey(y))));
  return [...map.entries()]
    .filter(([, list]) => list.length > 0)
    .map(([id, list]) => ({ category: CATEGORY_MAP[id] ?? { id, label: id }, items: list }));
}

// ══ 集計 ══

export function summarize(db) {
  const byCategory = {};
  db.achievements.forEach((a) => { byCategory[a.categoryId] = (byCategory[a.categoryId] ?? 0) + 1; });
  const years = db.achievements.map((a) => Number(a.year)).filter((y) => y > 0);
  const affs = db.masters.affiliations;
  return {
    total: db.achievements.length,
    byCategory,
    minYear: years.length ? Math.min(...years) : null,
    maxYear: years.length ? Math.max(...years) : null,
    persons: db.masters.persons.length,
    personsWithEn: db.masters.persons.filter((p) => tr(p.nameEn) !== '').length,
    affiliations: affs.length,
    affiliationsTop: affs.filter((a) => !a.parentId).length,
    affiliationsWithEn: affs.filter((a) => tr(a.nameEn) !== '').length,
    journals: db.masters.journals.length,
    conferences: db.masters.conferences.length,
  };
}

// ══ エクスポート / インポート ══

export function exportJson(db) {
  return JSON.stringify({ ...db, exportedAt: new Date().toISOString() }, null, 2);
}

/**
 * JSON を読み込む。
 * @param {'replace'|'merge'} mode replace: 置き換え / merge: 既存に追記
 */
export function importJson(text, mode = 'replace', current = null) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('JSON として読み取れませんでした。ファイルの内容を確認してください。');
  }
  const incoming = migrate(parsed);
  if (mode === 'replace' || !current) return { db: incoming, added: incoming.achievements.length };

  const db = migrate(current);
  const idMap = { persons: {}, affiliations: {}, journals: {}, conferences: {} };
  // 所属は上位から順に取り込み、「同じ上位 × 同じ名称」でまとめる
  affiliationTree(incoming).forEach(({ aff }) => {
    const parentId = aff.parentId ? (idMap.affiliations[aff.parentId] ?? '') : '';
    idMap.affiliations[aff.id] = addAffiliation(db, aff.name, {
      shortName: aff.shortName, nameEn: aff.nameEn, shortNameEn: aff.shortNameEn, parentId,
    }).id;
  });
  ['journals', 'conferences'].forEach((type) => {
    incoming.masters[type].forEach((item) => {
      const { id, ...fields } = item;
      idMap[type][id] = upsertMaster(db.masters[type], fields, 'name', type.slice(0, 3));
    });
  });
  incoming.masters.persons.forEach((item) => {
    const { id, ...fields } = item;
    fields.affiliationIds = (fields.affiliationIds ?? []).map((x) => idMap.affiliations[x]).filter(Boolean);
    idMap.persons[id] = upsertMaster(db.masters.persons, fields, 'name', 'per');
  });
  const seen = new Set(db.achievements.map(signature));
  let added = 0;
  incoming.achievements.forEach((a) => {
    const conv = {
      ...a,
      id: newId('ach'),
      journalId: idMap.journals[a.journalId] ?? '',
      conferenceId: idMap.conferences[a.conferenceId] ?? '',
      authors: (a.authors ?? []).map((au) => ({
        ...au,
        personId: idMap.persons[au.personId] ?? '',
        affiliationIds: (au.affiliationIds ?? []).map((x) => idMap.affiliations[x] ?? '').filter(Boolean),
      })),
    };
    const sig = signature(conv);
    if (seen.has(sig)) return;
    seen.add(sig);
    db.achievements.push(conv);
    added += 1;
  });
  return { db, added };
}

export function signature(a) {
  return [a.categoryId, a.title, a.year, a.month, a.day, a.presentationNumber, a.note]
    .map((v) => String(v ?? '').trim()).join('|');
}
