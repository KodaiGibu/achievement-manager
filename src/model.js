/**
 * 業績管理アプリ — データモデルとマスタ管理
 *
 * 保存データはすべてブラウザの localStorage に保持し、
 * JSON でのエクスポート / インポートによりアプリ更新をまたいで引き継げる。
 */

export const APP_TITLE = '業績管理アプリ';
export const SCHEMA_VERSION = 2;
export const STORAGE_KEY = 'achievement_db_v1';

// ══ 業績区分 ══

/**
 * kind: 入力フォームの種類（paper / conference / other）
 * label: 出力時の見出し
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

// ══ 既定のデータベース ══

export function emptyDb() {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: {
      // 出力時に太字＋下線を付ける自分の表記（複数登録可）
      selfNames: ['儀武滉大', 'Gibu, K.', 'Gibu K', 'Kodai Gibu', '儀武 滉大'],
    },
    masters: {
      /** {id, name, nameEn, affiliationIds:[]} */
      persons: [],
      /** {id, name, shortName} */
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
 * 共著者エントリ: { personId, freeName, affiliationIds: [], freeAffiliation }
 *  - affiliationIds: 所属マスタの ID の配列（並び順がそのまま出力順）
 *  - freeAffiliation: 旧バージョンの「・」区切り文字列（移行処理でマスタへ変換される）
 */
export function emptyAuthor() {
  return { personId: '', freeName: '', affiliationIds: [], freeAffiliation: '' };
}

export function emptyAchievement(categoryId = 'journal_reviewed') {
  return {
    id: newId('ach'),
    categoryId,
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
  }));
  db.masters.journals = (db.masters.journals ?? []).map((j) => ({
    id: j.id ?? newId('jnl'), name: j.name ?? '', abbr: j.abbr ?? '',
  }));
  db.masters.conferences = (db.masters.conferences ?? []).map((c) => ({
    id: c.id ?? newId('cnf'), name: c.name ?? '',
  }));
  // 欠けているフィールドを補完し、旧形式の所属文字列をマスタへ移す
  db.achievements = db.achievements.map((a) => {
    const rec = { ...emptyAchievement(a.categoryId), ...a };
    rec.authors = (rec.authors ?? []).map((au) => resolveLegacyAffiliations(db, { ...emptyAuthor(), ...au }));
    return rec;
  });
  db.schemaVersion = SCHEMA_VERSION;
  return db;
}

// ══ マスタ操作 ══

/** 名称からマスタを検索し、無ければ追加して ID を返す（記憶機能の中核） */
export function upsertMaster(list, fields, keyField = 'name', prefix = 'm') {
  const key = String(fields[keyField] ?? '').trim();
  if (key === '') return '';
  const hit = list.find((x) => String(x[keyField]).trim() === key);
  if (hit) {
    // 既存項目で空欄の情報（略称など）があれば補完する
    Object.entries(fields).forEach(([k, v]) => {
      if (k === keyField) return;
      const incomingEmpty = Array.isArray(v) ? v.length === 0 : String(v ?? '').trim() === '';
      const currentEmpty = Array.isArray(hit[k]) ? hit[k].length === 0 : String(hit[k] ?? '').trim() === '';
      if (!incomingEmpty && currentEmpty) hit[k] = v;
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

// ══ 所属の登録 ══

/**
 * 所属を名称と略称の組で登録する。
 *  - 同じ名称が既にあれば、その項目を使う（重複登録しない）
 *  - 略称が入力され、既存の略称が空なら補完する
 *  - 略称が入力され、既存の略称と異なる場合は updateShortName=true のときだけ更新する
 * @returns {{id:string, created:boolean, updated:boolean, conflict:string}} conflict は既存の略称（食い違い時）
 */
export function addAffiliation(db, name, shortName = '', { updateShortName = false } = {}) {
  const n = String(name ?? '').trim();
  const s = String(shortName ?? '').trim();
  if (n === '') throw new Error('所属の名称を入力してください。');
  const list = db.masters.affiliations;
  const hit = list.find((a) => a.name.trim() === n);
  if (!hit) {
    const item = { id: newId('aff'), name: n, shortName: s };
    list.push(item);
    return { id: item.id, created: true, updated: false, conflict: '' };
  }
  const current = String(hit.shortName ?? '').trim();
  if (s === '' || s === current) return { id: hit.id, created: false, updated: false, conflict: '' };
  if (current === '') {
    hit.shortName = s;
    return { id: hit.id, created: false, updated: true, conflict: '' };
  }
  if (updateShortName) {
    hit.shortName = s;
    return { id: hit.id, created: false, updated: true, conflict: '' };
  }
  return { id: hit.id, created: false, updated: false, conflict: current };
}

/** 所属の表示ラベル（名称（略称）） */
export function affiliationLabel(aff) {
  if (!aff) return '';
  const s = String(aff.shortName ?? '').trim();
  return s ? `${aff.name}（${s}）` : aff.name;
}

/** 所属マスタを名称順（五十音・アルファベット）に並べた一覧 */
export function sortedAffiliations(db) {
  return db.masters.affiliations.slice().sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

/**
 * 旧形式の所属文字列（「A・B」）を所属マスタへ登録し、affiliationIds へ移す。
 * 既に ID がある場合はその後ろに追加し、重複は除く。
 */
export function resolveLegacyAffiliations(db, author) {
  const au = { ...emptyAuthor(), ...author };
  const ids = Array.isArray(au.affiliationIds) ? au.affiliationIds.slice() : [];
  const free = String(au.freeAffiliation ?? '').trim();
  if (free !== '') {
    free.split(/[・,、]/).map((x) => x.trim()).filter(Boolean).forEach((name) => {
      const id = upsertMaster(db.masters.affiliations, { name, shortName: '' }, 'name', 'aff');
      if (id && !ids.includes(id)) ids.push(id);
    });
  }
  au.affiliationIds = ids;
  au.freeAffiliation = '';
  return au;
}

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

/** 発表日（年・月・日）を比較用の数値に変換する */
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
  db.achievements.forEach((a) => {
    byCategory[a.categoryId] = (byCategory[a.categoryId] ?? 0) + 1;
  });
  const years = db.achievements.map((a) => Number(a.year)).filter((y) => y > 0);
  return {
    total: db.achievements.length,
    byCategory,
    minYear: years.length ? Math.min(...years) : null,
    maxYear: years.length ? Math.max(...years) : null,
    persons: db.masters.persons.length,
    affiliations: db.masters.affiliations.length,
    journals: db.masters.journals.length,
    conferences: db.masters.conferences.length,
  };
}

// ══ エクスポート / インポート ══

/** バックアップ用 JSON 文字列 */
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
  // マスタは名称一致でまとめ、ID の対応表を作る
  const idMap = { persons: {}, affiliations: {}, journals: {}, conferences: {} };
  // 所属を先に処理し、人物の既定所属を新しい ID へ置き換える
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
  // 業績を取り込む（同一内容の重複は除外）
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
