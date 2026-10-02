/**
 * 業績管理アプリ — データモデルとマスタ管理
 *
 * 保存データはすべてブラウザの localStorage に保持し、
 * JSON でのエクスポート / インポートによりアプリ更新をまたいで引き継げる。
 */

export const APP_TITLE = '業績管理アプリ';
export const SCHEMA_VERSION = 3;
export const STORAGE_KEY = 'achievement_db_v1';

// ══ 業績区分 ══

/**
 * kind: 入力フォームの種類（paper / conference / other）
 * scope: international の区分は既定で英語表記になる
 */
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

/** 区分 ID から入力フォームの種類を返す */
export function kindOf(categoryId) {
  return CATEGORY_MAP[categoryId]?.kind ?? 'other';
}

/** 表記言語の選択肢 */
export const LANG_OPTIONS = [
  { value: 'auto', label: '自動判定' },
  { value: 'ja', label: '日本語表記' },
  { value: 'en', label: '英語表記' },
];

// ══ 既定のデータベース ══

export function emptyDb() {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: {
      // 出力時に太字＋下線を付ける自分の表記（和文・英文の両方を登録）
      selfNames: ['儀武滉大', '儀武 滉大', 'Gibu, K.', 'Gibu K', 'Kodai Gibu', 'Gibu, Kodai'],
    },
    masters: {
      /** {id, name, nameEn, affiliationIds:[]} */
      persons: [],
      /** {id, name, shortName, nameEn, shortNameEn} */
      affiliations: [],
      /** {id, name, abbr} */
      journals: [],
      /** {id, name} 大会名・講義名 */
      conferences: [],
    },
    achievements: [],
    updatedAt: null,
  };
}

// ══ ID 採番 ══
let seq = 0;
export function newId(prefix = 'id') {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

// ══ 業績レコードの雛形 ══

/**
 * 共著者エントリ: { personId, freeName, freeNameEn, affiliationIds: [], freeAffiliation }
 *  - affiliationIds: 所属マスタの ID の配列（並び順がそのまま出力順）
 *  - freeAffiliation: 旧バージョンの「・」区切り文字列（移行処理でマスタへ変換される）
 */
export function emptyAuthor() {
  return { personId: '', freeName: '', freeNameEn: '', affiliationIds: [], freeAffiliation: '' };
}

export function emptyAchievement(categoryId = 'journal_reviewed') {
  return {
    id: newId('ach'),
    categoryId,
    lang: 'auto',            // 表記言語: auto / ja / en
    authors: [emptyAuthor()],
    // 論文
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
    // 学会
    conferenceId: '',
    freeConference: '',
    presentationNumber: '',
    venue: '',
    // その他
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
 *  v1 → v2: 共著者の freeAffiliation（「・」区切り文字列）を所属マスタへ登録し、ID 参照に置き換える
 *  v2 → v3: 所属に英語名称・英語略称、業績に表記言語（lang）を追加
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
  db.masters.persons = (db.masters.persons ?? []).map((p) => ({
    id: p.id ?? newId('per'), name: p.name ?? '', nameEn: p.nameEn ?? '',
    affiliationIds: Array.isArray(p.affiliationIds) ? p.affiliationIds : [],
  }));
  db.masters.affiliations = (db.masters.affiliations ?? []).map((a) => ({
    id: a.id ?? newId('aff'), name: a.name ?? '', shortName: a.shortName ?? '',
    nameEn: a.nameEn ?? '', shortNameEn: a.shortNameEn ?? '',
  }));
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

// ══ 所属の登録（和文名称・略称 ＋ 英語名称・略称）══

const AFF_FIELDS = ['shortName', 'nameEn', 'shortNameEn'];
const AFF_LABEL = { shortName: '略称', nameEn: '英語名称', shortNameEn: '英語略称' };

/**
 * 所属を登録する。
 *  - 和文名称（name）をキーに重複を防ぐ。英語名称だけが一致する既存項目もその所属とみなす
 *  - 既存項目で空欄の略称・英語名称・英語略称は補完する
 *  - 既に値があり入力値と異なる項目は conflicts に返し、updateExisting=true のときだけ上書きする
 * @param {{shortName?, nameEn?, shortNameEn?}} fields
 * @returns {{id, created, updated, conflicts:{field,label,current,incoming}[]}}
 */
export function addAffiliation(db, name, fields = {}, { updateExisting = false } = {}) {
  // 旧呼び出し addAffiliation(db, name, '略称') との互換
  const f = typeof fields === 'string' ? { shortName: fields } : (fields ?? {});
  const n = String(name ?? '').trim();
  const incoming = Object.fromEntries(AFF_FIELDS.map((k) => [k, String(f[k] ?? '').trim()]));
  if (n === '' && incoming.nameEn === '') throw new Error('所属の名称を入力してください。');

  const list = db.masters.affiliations;
  const hit = (n !== '' ? list.find((a) => a.name.trim() === n) : null)
    ?? (incoming.nameEn !== '' ? findAffiliationByEnglish(db, incoming.nameEn) : null);

  if (!hit) {
    const item = { id: newId('aff'), name: n || incoming.nameEn, ...incoming };
    list.push(item);
    return { id: item.id, created: true, updated: false, conflicts: [] };
  }
  let updated = false;
  const conflicts = [];
  AFF_FIELDS.forEach((k) => {
    const cur = String(hit[k] ?? '').trim();
    const inc = incoming[k];
    if (inc === '' || inc === cur) return;
    if (cur === '' || updateExisting) { hit[k] = inc; updated = true; return; }
    conflicts.push({ field: k, label: AFF_LABEL[k], current: cur, incoming: inc });
  });
  return { id: hit.id, created: false, updated, conflicts };
}

/** 英語名称・英語略称（または和文名称）が一致する所属を探す（大文字小文字・空白を無視） */
export function findAffiliationByEnglish(db, text) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s.,]+/g, '');
  const t = norm(text);
  if (t === '') return null;
  return db.masters.affiliations.find((a) => [a.nameEn, a.shortNameEn, a.name].some((v) => norm(v) === t)) ?? null;
}

/** 所属の表示ラベル: 名称（略称） / English Name (Abbr) */
export function affiliationLabel(aff) {
  if (!aff) return '';
  const s = String(aff.shortName ?? '').trim();
  const ja = s ? `${aff.name}（${s}）` : aff.name;
  const en = String(aff.nameEn ?? '').trim();
  const se = String(aff.shortNameEn ?? '').trim();
  if (en === '' && se === '') return ja;
  return `${ja} / ${en || se}${en && se ? ` (${se})` : ''}`;
}

/** 所属マスタを名称順に並べた一覧 */
export function sortedAffiliations(db) {
  return db.masters.affiliations.slice().sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

/** 旧形式の所属文字列（「A・B」）を所属マスタへ登録し、affiliationIds へ移す */
export function resolveLegacyAffiliations(db, author) {
  const au = { ...emptyAuthor(), ...author };
  const ids = Array.isArray(au.affiliationIds) ? au.affiliationIds.slice() : [];
  const free = String(au.freeAffiliation ?? '').trim();
  if (free !== '') {
    free.split(/[・,、]/).map((x) => x.trim()).filter(Boolean).forEach((name) => {
      const id = upsertMaster(db.masters.affiliations,
        { name, shortName: '', nameEn: '', shortNameEn: '' }, 'name', 'aff');
      if (id && !ids.includes(id)) ids.push(id);
    });
  }
  au.affiliationIds = ids;
  au.freeAffiliation = '';
  return au;
}

// ══ 人物の英語名 ══

/** 英語名の比較用キー（姓 + 名の頭文字） */
function englishKey(family, given) {
  const f = String(family ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const g = String(given ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return f ? `${f}|${g.slice(0, 1)}` : '';
}

/** "Gibu, Kodai" / "Gibu, K." / "Kodai Gibu" を {family, given} に分解する */
export function splitEnglishName(text) {
  const s = String(text ?? '').trim();
  if (s === '') return { family: '', given: '' };
  if (s.includes(',')) {
    const [family, given] = s.split(',').map((x) => x.trim());
    return { family, given: given ?? '' };
  }
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { family: parts[0], given: '' };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
}

/**
 * 英語名から登録済みの人物を探す。
 * "Gibu, Kodai" と "Gibu, K." と "Kodai Gibu" を同一人物とみなす（姓＋名の頭文字で照合）。
 */
export function findPersonByEnglish(db, text) {
  const { family, given } = splitEnglishName(text);
  const key = englishKey(family, given);
  if (key === '') return null;
  return db.masters.persons.find((p) => {
    const cands = [p.nameEn, p.name].filter((v) => String(v ?? '').trim() !== '');
    return cands.some((v) => {
      const s = splitEnglishName(v);
      return englishKey(s.family, s.given) === key;
    });
  }) ?? null;
}

/** 人物の表示ラベル（氏名 / English） */
export function personLabel(p) {
  if (!p) return '';
  const en = String(p.nameEn ?? '').trim();
  return en ? `${p.name} / ${en}` : p.name;
}

// ══ 削除と使用件数 ══

/** マスタ項目を削除する。使用中の業績があれば削除せず件数を返す */
export function removeMaster(db, type, id) {
  const used = countMasterUsage(db, type, id);
  if (used > 0) return { removed: false, used };
  const list = db.masters[type];
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
  return { removed: true, used: 0 };
}

/** マスタ項目が業績（と人物の既定所属）で何件使われているか数える */
export function countMasterUsage(db, type, id) {
  let n = 0;
  db.achievements.forEach((a) => {
    if (type === 'journals' && a.journalId === id) n += 1;
    if (type === 'conferences' && a.conferenceId === id) n += 1;
    if (type === 'persons' && (a.authors ?? []).some((au) => au.personId === id)) n += 1;
    if (type === 'affiliations' && (a.authors ?? []).some((au) => (au.affiliationIds ?? []).includes(id))) n += 1;
  });
  if (type === 'affiliations') {
    n += db.masters.persons.filter((p) => (p.affiliationIds ?? []).includes(id)).length;
  }
  return n;
}

// ══ 並べ替え ══

export function dateKey(a) {
  const y = Number(a.year) || 0;
  const m = Number(a.month) || 0;
  const d = Number(a.day) || 0;
  return y * 10000 + m * 100 + d;
}

/** 業績を区分ごとにまとめ、指定順で並べる */
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
  return {
    total: db.achievements.length,
    byCategory,
    minYear: years.length ? Math.min(...years) : null,
    maxYear: years.length ? Math.max(...years) : null,
    persons: db.masters.persons.length,
    personsWithEn: db.masters.persons.filter((p) => String(p.nameEn ?? '').trim() !== '').length,
    affiliations: db.masters.affiliations.length,
    affiliationsWithEn: db.masters.affiliations.filter((a) => String(a.nameEn ?? '').trim() !== '').length,
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
  ['affiliations', 'journals', 'conferences'].forEach((type) => {
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

/** 重複判定用のシグネチャ */
export function signature(a) {
  return [a.categoryId, a.title, a.year, a.month, a.day, a.presentationNumber, a.note]
    .map((v) => String(v ?? '').trim()).join('|');
}
