/**
 * 業績管理アプリ — データモデルとマスタ管理
 *
 * 保存データはすべてブラウザの localStorage に保持し、
 * JSON でのエクスポート / インポートによりアプリ更新をまたいで引き継げる。
 */

export const APP_TITLE = '業績管理アプリ';
export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'achievement_db_v1';

// ══ 業績区分 ══

/**
 * kind: 入力フォームの種類（paper / conference / other）
 * category: 出力時の見出し
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
      // 出力時に太字＋下線を付ける自分の表記（複数登録可・部分一致で判定）
      selfNames: ['儀武滉大', 'Gibu, K.', 'Gibu K', 'Kodai Gibu', '儀武 滉大'],
      defaultAffiliation: '',
    },
    masters: {
      /** {id, name, nameEn, affiliationIds:[]} */
      persons: [],
      /** {id, name, shortName} */
      affiliations: [],
      /** {id, name, abbr} */
      journals: [],
      /** {id, name} 大会名 */
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
 * 共著者エントリ: { personId, affiliationIds: [] }
 * personId が空の場合は freeName（マスタ未登録の手入力）を使う
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
 * 将来スキーマを変更した場合はここに移行処理を追加する。
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
  // 欠けているフィールドを補完する
  db.achievements = db.achievements.map((a) => ({ ...emptyAchievement(a.categoryId), ...a }));
  db.masters.persons = (db.masters.persons ?? []).map((p) => ({
    id: p.id ?? newId('per'), name: p.name ?? '', nameEn: p.nameEn ?? '',
    affiliationIds: p.affiliationIds ?? [],
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
    // 追加情報（略称など）が新しく入力されていれば補完する
    Object.entries(fields).forEach(([k, v]) => {
      if (k !== keyField && String(v ?? '').trim() !== '' && String(hit[k] ?? '').trim() === '') {
        hit[k] = v;
      }
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

/** マスタ項目を削除する。使用中の業績があれば削除せず件数を返す */
export function removeMaster(db, type, id) {
  const used = countMasterUsage(db, type, id);
  if (used > 0) return { removed: false, used };
  const list = db.masters[type];
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
  return { removed: true, used: 0 };
}

/** マスタ項目が業績で何件使われているか数える */
export function countMasterUsage(db, type, id) {
  let n = 0;
  db.achievements.forEach((a) => {
    if (type === 'journals' && a.journalId === id) n += 1;
    if (type === 'conferences' && a.conferenceId === id) n += 1;
    if (type === 'persons' && (a.authors ?? []).some((au) => au.personId === id)) n += 1;
    if (type === 'affiliations') {
      const inAuthors = (a.authors ?? []).some((au) => (au.affiliationIds ?? []).includes(id));
      if (inAuthors) n += 1;
    }
  });
  if (type === 'affiliations') {
    // 人物マスタの所属としての使用も数える
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
 * @param {string} text
 * @param {'replace'|'merge'} mode replace: 置き換え / merge: 既存に追記
 * @param {object} current 現在の DB（merge 時に使用）
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
  const keyOf = { persons: 'name', affiliations: 'name', journals: 'name', conferences: 'name' };
  Object.keys(idMap).forEach((type) => {
    incoming.masters[type].forEach((item) => {
      const { id, ...fields } = item;
      idMap[type][id] = upsertMaster(db.masters[type], fields, keyOf[type], type.slice(0, 3));
    });
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
