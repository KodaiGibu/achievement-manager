/**
 * 業績管理アプリ — 追加の出力形式
 *
 *  - BibTeX / RIS（Zotero・EndNote などの文献管理ソフト向け）
 *  - 科研費様式（研究業績欄）
 *  - 年度別集計
 */
import { CATEGORY_MAP, kindOf, findById, groupByCategory } from './model.js';
import {
  formatAuthors, formatItem, formatDateJa, formatVolume,
  journalLabel, conferenceLabel, authorName,
} from './format.js';
import { doiUrl } from './crossref.js';

// ══════════ BibTeX ══════════

/** BibTeX で特殊な意味を持つ文字を退避する */
function escBib(s) {
  return String(s ?? '')
    .replace(/[\\]/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/**
 * 引用キー（著者姓 + 年 + タイトル先頭語）を作る。
 * BibTeX のキーは ASCII が安全なため、英語表記があればそれを優先し、
 * 日本語しか無い場合は連番付きのローマ字キーにフォールバックする。
 */
export function citationKey(db, a, used = new Set()) {
  const first = (a.authors ?? [])[0];
  // 英語表記（nameEn）があれば優先して使う
  const p = first ? findById(db.masters.persons, first.personId) : null;
  const enName = p && String(p.nameEn ?? '').trim() !== '' ? p.nameEn.trim() : '';
  const rawName = enName || (first ? authorName(db, first) : '');
  const asciiName = rawName.split(/[,\s]/)[0].replace(/[^A-Za-z0-9]/g, '');

  const year = String(a.year ?? '').trim() || 'nd';
  const title = String(a.title ?? '').trim();
  const asciiWord = (title.split(/\s+/).find((w) => /[A-Za-z]/.test(w)) ?? '')
    .replace(/[^A-Za-z0-9]/g, '').slice(0, 12);

  let base;
  if (asciiName !== '') {
    base = `${asciiName}${year}${asciiWord}`;
  } else {
    // 日本語のみ: item + 年 + 通し番号で一意にする
    base = `item${year}`;
  }
  let key = base;
  let n = 1;
  while (used.has(key)) { n += 1; key = `${base}${String.fromCharCode(96 + n)}`; }
  used.add(key);
  return key;
}

/** BibTeX のエントリ種別を決める */
export function bibEntryType(categoryId) {
  const kind = kindOf(categoryId);
  if (kind === 'paper') return 'article';
  if (kind === 'conference') return 'inproceedings';
  return 'misc';
}

/** 著者を BibTeX の and 連結にする */
function bibAuthors(db, a) {
  return (a.authors ?? []).map((au) => authorName(db, au)).filter((s) => s !== '').join(' and ');
}

/** 業績 1 件を BibTeX エントリにする */
export function toBibtex(db, a, used = new Set()) {
  const type = bibEntryType(a.categoryId);
  const key = citationKey(db, a, used);
  const fields = [];
  const put = (k, v) => {
    const s = String(v ?? '').trim();
    if (s !== '') fields.push(`  ${k} = {${escBib(s)}}`);
  };

  put('author', bibAuthors(db, a));
  put('title', a.title);
  if (kindOf(a.categoryId) === 'paper') {
    put('journal', journalLabel(db, a));
    const j = findById(db.masters.journals, a.journalId);
    if (j && String(j.abbr ?? '').trim() !== '') put('shortjournal', j.abbr);
    put('volume', a.volume);
    put('number', a.issue);
    put('pages', a.pages);
  } else {
    put('booktitle', conferenceLabel(db, a));
    put('note', [a.presentationNumber ? `発表番号${a.presentationNumber}` : '', a.note]
      .filter((s) => String(s ?? '').trim() !== '').join(' '));
    put('address', a.venue);
  }
  put('year', a.year);
  put('month', a.month);
  put('doi', a.doi);
  if (String(a.doi ?? '').trim() !== '') put('url', doiUrl(a.doi));
  put('keywords', CATEGORY_MAP[a.categoryId]?.label ?? '');

  return `@${type}{${key},\n${fields.join(',\n')}\n}`;
}

/** 業績一覧を BibTeX ファイルの内容にする */
export function buildBibtex(db, opts = {}) {
  const { order = 'asc', categoryIds = null } = opts;
  const items = categoryIds
    ? db.achievements.filter((a) => categoryIds.includes(a.categoryId))
    : db.achievements;
  const groups = groupByCategory(items, order);
  const used = new Set();
  const blocks = [];
  groups.forEach((g) => {
    blocks.push(`% ${g.category.label}`);
    g.items.forEach((a) => blocks.push(toBibtex(db, a, used)));
    blocks.push('');
  });
  return `% 業績目録 BibTeX エクスポート（${new Date().toLocaleDateString('ja-JP')}）\n`
    + `% Zotero・EndNote などにそのまま読み込めます\n\n${blocks.join('\n')}`;
}

// ══════════ RIS ══════════

/** RIS のタグ種別 */
export function risType(categoryId) {
  const kind = kindOf(categoryId);
  if (kind === 'paper') return 'JOUR';
  if (kind === 'conference') return 'CPAPER';
  return 'GEN';
}

/** 業績 1 件を RIS レコードにする */
export function toRis(db, a) {
  const lines = [];
  const put = (tag, v) => {
    const s = String(v ?? '').trim();
    if (s !== '') lines.push(`${tag}  - ${s}`);
  };
  lines.push(`TY  - ${risType(a.categoryId)}`);
  (a.authors ?? []).forEach((au) => put('AU', authorName(db, au)));
  put('TI', a.title);
  if (kindOf(a.categoryId) === 'paper') {
    put('JO', journalLabel(db, a));
    const j = findById(db.masters.journals, a.journalId);
    if (j && String(j.abbr ?? '').trim() !== '') put('J2', j.abbr);
    put('VL', a.volume);
    put('IS', a.issue);
    // ページ範囲は SP / EP に分ける
    const pg = String(a.pages ?? '').trim();
    const m = pg.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (m) { put('SP', m[1]); put('EP', m[2]); } else put('SP', pg);
  } else {
    put('T2', conferenceLabel(db, a));
    put('CY', a.venue);
    put('M1', a.presentationNumber);
  }
  // 日付: PY は年、DA は YYYY/MM/DD//
  put('PY', a.year);
  const da = [a.year, a.month, a.day].map((v) => String(v ?? '').trim());
  if (da[0] !== '') put('DA', `${da[0]}/${da[1]}/${da[2]}//`);
  put('DO', a.doi);
  if (String(a.doi ?? '').trim() !== '') put('UR', doiUrl(a.doi));
  put('KW', CATEGORY_MAP[a.categoryId]?.label ?? '');
  put('N1', a.note);
  lines.push('ER  - ');
  return lines.join('\r\n');
}

/** 業績一覧を RIS ファイルの内容にする */
export function buildRis(db, opts = {}) {
  const { order = 'asc', categoryIds = null } = opts;
  const items = categoryIds
    ? db.achievements.filter((a) => categoryIds.includes(a.categoryId))
    : db.achievements;
  const groups = groupByCategory(items, order);
  const out = [];
  groups.forEach((g) => g.items.forEach((a) => out.push(toRis(db, a))));
  return out.join('\r\n\r\n') + '\r\n';
}

// ══════════ 科研費様式 ══════════

/**
 * 科研費（研究業績欄）の区分。
 * 「雑誌論文」「学会発表」「図書」「産業財産権」「その他」の枠に整理する。
 */
export const KAKENHI_SECTIONS = [
  {
    id: 'journal',
    label: '〔雑誌論文〕',
    match: (id) => kindOf(id) === 'paper',
  },
  {
    id: 'presentation',
    label: '〔学会発表〕',
    match: (id) => kindOf(id) === 'conference',
  },
  {
    id: 'others',
    label: '〔その他〕',
    match: (id) => kindOf(id) === 'other',
  },
];

/** 査読の有無・国際/国内・招待講演の別を判定する */
export function kakenhiFlags(a) {
  const cat = CATEGORY_MAP[a.categoryId] ?? {};
  const kind = kindOf(a.categoryId);
  return {
    reviewed: kind === 'paper' ? (a.reviewed ? '有' : '無') : '',
    international: cat.scope === 'international' ? '該当する' : '該当しない',
    invited: a.categoryId === 'symposium' ? '該当する' : '該当しない',
    openAccess: String(a.doi ?? '').trim() !== '' ? 'オープンアクセスとしている（また、その予定である）' : '',
  };
}

/**
 * 科研費様式のテキストを生成する。
 * 雑誌論文は「著者名／論文標題／雑誌名／巻／発行年／最初と最後の頁」、
 * 学会発表は「発表者名／学会等名／発表標題／発表年」の並びで記載する。
 */
export function buildKakenhi(db, opts = {}) {
  const { order = 'desc', categoryIds = null, title = null } = opts;
  const items = categoryIds
    ? db.achievements.filter((a) => categoryIds.includes(a.categoryId))
    : db.achievements;

  const head = title ?? `研究発表（${new Date().getFullYear()}年度 科研費様式）`;
  const out = [head, ''];

  KAKENHI_SECTIONS.forEach((sec) => {
    const list = items.filter((a) => sec.match(a.categoryId));
    if (!list.length) return;
    const sign = order === 'desc' ? -1 : 1;
    list.sort((x, y) => sign * ((Number(x.year) || 0) - (Number(y.year) || 0)));

    out.push(`${sec.label}　計${list.length}件`);
    out.push('');
    list.forEach((a, i) => {
      const authors = formatAuthors(db, a, { withAffiliation: false }).parts
        .map((p) => p.name).join('、');
      const f = kakenhiFlags(a);
      if (sec.id === 'journal') {
        out.push(`${i + 1}．${authors}`);
        out.push(`　　${a.title}`);
        out.push(`　　${journalLabel(db, a)}　${formatVolume(a)}　${a.year}年　${a.pages}`);
        const extra = [`査読の有無：${f.reviewed}`, `国際共著：${f.international}`];
        if (String(a.doi ?? '').trim() !== '') extra.unshift(`DOI：${a.doi}`);
        if (f.openAccess) extra.push(`オープンアクセス：${f.openAccess}`);
        out.push(`　　${extra.join('／')}`);
      } else if (sec.id === 'presentation') {
        out.push(`${i + 1}．${authors}`);
        out.push(`　　${a.title}`);
        out.push(`　　${conferenceLabel(db, a)}　${formatDateJa(a)}`);
        out.push(`　　国際学会：${f.international}／招待講演：${f.invited}`);
      } else {
        out.push(`${i + 1}．${authors}`);
        out.push(`　　${a.title}`);
        const line = [conferenceLabel(db, a), formatDateJa(a), a.venue, a.note]
          .map((s) => String(s ?? '').trim()).filter((s) => s !== '').join('　');
        if (line !== '') out.push(`　　${line}`);
      }
      out.push('');
    });
  });
  return out.join('\n');
}

// ══════════ 年度別集計 ══════════

/**
 * 年度を求める（日本の会計年度: 4月1日〜翌3月31日）。
 * 月が未入力の場合は暦年をそのまま年度とみなす。
 */
export function fiscalYear(a) {
  const y = Number(a.year);
  if (!y) return null;
  const m = Number(a.month);
  if (!m) return y;
  return m >= 4 ? y : y - 1;
}

/**
 * 年度別（または暦年別）の集計を返す。
 * @param {'fiscal'|'calendar'} basis
 * @returns {{rows:{year:number,total:number,byCategory:object}[], categories:string[], total:number}}
 */
export function summarizeByYear(db, basis = 'fiscal') {
  const map = new Map();
  const cats = new Set();
  db.achievements.forEach((a) => {
    const y = basis === 'fiscal' ? fiscalYear(a) : (Number(a.year) || null);
    if (y === null) return;
    if (!map.has(y)) map.set(y, { year: y, total: 0, byCategory: {} });
    const rec = map.get(y);
    rec.total += 1;
    rec.byCategory[a.categoryId] = (rec.byCategory[a.categoryId] ?? 0) + 1;
    cats.add(a.categoryId);
  });
  const rows = [...map.values()].sort((x, y) => x.year - y.year);
  // 表示順は CATEGORIES の並びに合わせる
  const categories = Object.keys(CATEGORY_MAP).filter((id) => cats.has(id));
  return { rows, categories, total: db.achievements.length };
}

/** 年度別集計を CSV にする */
export function buildYearlyCsv(db, basis = 'fiscal') {
  const { rows, categories } = summarizeByYear(db, basis);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [basis === 'fiscal' ? '年度' : '年', ...categories.map((c) => CATEGORY_MAP[c].label), '合計'];
  const lines = [header.map(esc).join(',')];
  rows.forEach((r) => {
    lines.push([r.year, ...categories.map((c) => r.byCategory[c] ?? 0), r.total].map(esc).join(','));
  });
  // 合計行
  const totals = categories.map((c) => rows.reduce((s, r) => s + (r.byCategory[c] ?? 0), 0));
  lines.push(['合計', ...totals, rows.reduce((s, r) => s + r.total, 0)].map(esc).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** 年度別の推移を簡易バーで表す（画面表示用の文字列） */
export function yearlyBar(count, max, width = 20) {
  if (max <= 0) return '';
  const n = Math.max(1, Math.round((count / max) * width));
  return '█'.repeat(count > 0 ? n : 0);
}

// ══════════ ファイル名 ══════════

export function exportFileName(kind, d = new Date()) {
  const p2 = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  const names = {
    bibtex: `業績目録_${stamp}.bib`,
    ris: `業績目録_${stamp}.ris`,
    kakenhi: `科研費様式_研究発表_${stamp}.txt`,
    yearly: `年度別集計_${stamp}.csv`,
  };
  return names[kind] ?? `export_${stamp}.txt`;
}
