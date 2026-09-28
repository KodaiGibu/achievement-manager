/**
 * 業績管理アプリ — 出力整形
 *
 * 業績目録の区分ごとの見出しと箇条書きを生成する。
 * 自分の氏名は太字＋下線で強調する。
 */
import { findById, groupByCategory, kindOf } from './model.js';

// ══ 著者の整形 ══

/** 著者エントリの表示名を返す（マスタ優先・英語表記の指定も可） */
export function authorName(db, author, lang = 'ja') {
  const p = findById(db.masters.persons, author.personId);
  if (p) {
    if (lang === 'en' && String(p.nameEn ?? '').trim() !== '') return p.nameEn.trim();
    return p.name;
  }
  return String(author.freeName ?? '').trim();
}

/** 著者エントリの所属表記（略称があれば略称を優先・複数所属は「・」連結） */
export function authorAffiliation(db, author, useShort = true) {
  const names = (author.affiliationIds ?? []).map((id) => {
    const a = findById(db.masters.affiliations, id);
    if (!a) return '';
    return useShort && String(a.shortName ?? '').trim() !== '' ? a.shortName.trim() : a.name;
  }).filter((s) => s !== '');
  const free = String(author.freeAffiliation ?? '').trim();
  if (free !== '') names.push(free);
  return names.join('・');
}

/** 自分の氏名かどうか（profile.selfNames と空白を除いて一致） */
export function isSelf(db, name) {
  const n = String(name ?? '').trim();
  if (n === '') return false;
  return (db.profile.selfNames ?? []).some((s) => {
    const t = String(s).trim();
    return t !== '' && n.replace(/\s+/g, '') === t.replace(/\s+/g, '');
  });
}

/**
 * 著者一覧を整形する。
 * @param {'ja'|'en'} lang ja: 「・」連結 / en: カンマ連結
 */
export function formatAuthors(db, achievement, { lang = 'ja', withAffiliation = true } = {}) {
  const parts = (achievement.authors ?? []).map((au) => {
    const name = authorName(db, au, lang);
    return { name, affiliation: withAffiliation ? authorAffiliation(db, au) : '', self: isSelf(db, name) };
  }).filter((p) => p.name !== '');
  const sep = lang === 'en' ? ', ' : '・';
  const text = parts.map((p) => (p.affiliation ? `${p.name}（${p.affiliation}）` : p.name)).join(sep);
  return { text, parts };
}

// ══ 日付・巻号 ══

/** 2024年3月28日 の形式（月日が無ければ省略） */
export function formatDateJa(a) {
  const y = String(a.year ?? '').trim();
  if (y === '') return '';
  const m = String(a.month ?? '').trim();
  const d = String(a.day ?? '').trim();
  let s = `${y}年`;
  if (m !== '') s += `${Number(m)}月`;
  if (m !== '' && d !== '') s += `${Number(d)}日`;
  return s;
}

/** 巻(号) の形式。号が無ければ巻のみ */
export function formatVolume(a) {
  const v = String(a.volume ?? '').trim();
  const i = String(a.issue ?? '').trim();
  if (v === '' && i === '') return '';
  if (i === '') return v;
  if (v === '') return `(${i})`;
  return `${v}(${i})`;
}

/** 著者名に日本語が含まれなければ英語表記とみなす */
function detectLang(db, a) {
  const names = (a.authors ?? []).map((au) => authorName(db, au)).join('');
  return /[ぁ-んァ-ヶ一-龠]/.test(names) ? 'ja' : 'en';
}

/** ジャーナル名（preferAbbr=true なら略称を優先） */
export function journalLabel(db, a, preferAbbr = false) {
  const j = findById(db.masters.journals, a.journalId);
  if (j) {
    const abbr = String(j.abbr ?? '').trim();
    return preferAbbr && abbr !== '' ? abbr : j.name;
  }
  return String(a.freeJournal ?? '').trim();
}

/** 大会名 */
export function conferenceLabel(db, a) {
  const c = findById(db.masters.conferences, a.conferenceId);
  if (c) return c.name;
  return String(a.freeConference ?? '').trim();
}

// ══ 1件分の整形 ══

/**
 * 業績 1 件をテキスト片の配列で返す。
 * 各片は {text, bold, underline, italic} を持つ中間表現。
 */
export function formatItemParts(db, a) {
  const kind = kindOf(a.categoryId);
  const out = [];
  const push = (text, opts = {}) => { if (text !== '') out.push({ text, ...opts }); };

  const lang = detectLang(db, a);
  const { parts } = formatAuthors(db, a, {
    lang,
    withAffiliation: kind === 'conference' || kind === 'other',
  });
  parts.forEach((p, i) => {
    if (i > 0) push(lang === 'en' ? ', ' : '・');
    const label = p.affiliation ? `${p.name}（${p.affiliation}）` : p.name;
    push(label, p.self ? { bold: true, underline: true } : {});
  });

  const title = String(a.title ?? '').trim();

  if (kind === 'paper') {
    const y = String(a.year ?? '').trim();
    push(y !== '' ? ` (${y}).` : '.');
    if (title !== '') {
      push(` ${title}`);
      if (!/[.。]$/.test(title)) push('.');
    }
    const jn = journalLabel(db, a);
    if (jn !== '') { push(' '); push(jn, { italic: true }); }
    const vol = formatVolume(a);
    if (vol !== '') push(`, ${vol}`);
    const pg = String(a.pages ?? '').trim();
    if (pg !== '') push(`, ${pg}`);
    push('.');
    const doi = String(a.doi ?? '').trim();
    if (doi !== '') push(` ${doi.startsWith('http') ? doi : `https://doi.org/${doi}`}`);
    return out;
  }

  if (kind === 'conference') {
    push('.');
    if (title !== '') push(`「${title}」.`);
    const cn = conferenceLabel(db, a);
    if (cn !== '') push(` ${cn}.`);
    const date = formatDateJa(a);
    if (date !== '') push(` ${date}.`);
    const venue = String(a.venue ?? '').trim();
    if (venue !== '') push(` ${venue}.`);
    const num = String(a.presentationNumber ?? '').trim();
    if (num !== '') push(` 発表番号${num}.`);
    return out;
  }

  // その他（講義・シンポジウム等）
  push('．');
  if (title !== '') push(`${title}．`);
  const cn = conferenceLabel(db, a);
  if (cn !== '') push(` ${cn}．`);
  const date = formatDateJa(a);
  if (date !== '') push(` ${date}．`);
  const venue = String(a.venue ?? '').trim();
  if (venue !== '') push(` ${venue}．`);
  const note = String(a.note ?? '').trim();
  if (note !== '') push(` ${note}`);
  return out;
}

// ══ 出力形式ごとの変換 ══

const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function partsToHtml(parts) {
  return parts.map((p) => {
    let t = escHtml(p.text);
    if (p.italic) t = `<em>${t}</em>`;
    if (p.underline) t = `<u>${t}</u>`;
    if (p.bold) t = `<strong>${t}</strong>`;
    return t;
  }).join('');
}
function partsToMarkdown(parts) {
  return parts.map((p) => {
    let t = p.text;
    if (p.italic) t = `_${t}_`;
    if (p.underline) t = `<u>${t}</u>`;
    if (p.bold) t = `**${t}**`;
    return t;
  }).join('');
}
function partsToPlain(parts) {
  return parts.map((p) => p.text).join('');
}

/** 1件分のテキストを指定形式で返す */
export function formatItem(db, a, format = 'plain') {
  const parts = formatItemParts(db, a);
  if (format === 'html') return partsToHtml(parts);
  if (format === 'markdown') return partsToMarkdown(parts);
  return partsToPlain(parts);
}

/**
 * 業績リスト全体を生成する。
 * @param {'html'|'markdown'|'plain'} format
 */
export function buildList(db, format = 'markdown', opts = {}) {
  const { order = 'asc', title = null, categoryIds = null } = opts;
  const items = categoryIds
    ? db.achievements.filter((a) => categoryIds.includes(a.categoryId))
    : db.achievements;
  const groups = groupByCategory(items, order);
  const heading = title ?? defaultTitle();

  if (format === 'html') {
    const body = groups.map((g) => {
      const lis = g.items.map((a) => `    <li>${partsToHtml(formatItemParts(db, a))}</li>`).join('\n');
      return `  <h2>${escHtml(g.category.label)}</h2>\n  <ul>\n${lis}\n  </ul>`;
    }).join('\n');
    return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>${escHtml(heading)}</title>
<style>
body{font-family:'Segoe UI','Meiryo',serif;margin:30px;line-height:1.8;color:#2b2b28}
h1{font-size:1.3em;border-bottom:2px solid #b5b5ac;padding-bottom:6px}
h2{font-size:1.02em;margin-top:1.6em;background:#eeeeea;border-left:5px solid #b5b5ac;padding:5px 10px}
ul{padding-left:1.4em}
li{margin-bottom:.7em;text-indent:-1em;padding-left:1em;list-style:none}
li::before{content:"・";margin-right:.1em}
@media print{body{margin:16mm}}
</style></head>
<body>
  <h1>${escHtml(heading)}</h1>
${body}
</body></html>
`;
  }

  if (format === 'markdown') {
    const body = groups.map((g) => {
      const lis = g.items.map((a) => `- ${partsToMarkdown(formatItemParts(db, a))}`).join('\n');
      return `## ${g.category.label}\n\n${lis}`;
    }).join('\n\n');
    return `# ${heading}\n\n${body}\n`;
  }

  const body = groups.map((g) => {
    const lis = g.items.map((a) => `・${partsToPlain(formatItemParts(db, a))}`).join('\n');
    return `【${g.category.label}】\n${lis}`;
  }).join('\n\n');
  return `${heading}\n\n${body}\n`;
}

/** 既定の表題（作成日入り） */
export function defaultTitle(d = new Date()) {
  return `業績目録（${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日現在）`;
}

// ══ CSV 出力 ══

export const CSV_HEADER = [
  '区分', '著者', '所属', 'タイトル', 'ジャーナル/大会名', 'ジャーナル略称',
  '年', '月', '日', '巻', '号', 'ページ/文献番号', '発表番号', '査読', 'DOI', '会場', '備考',
];

function escCsv(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 業績一覧を CSV で返す（UTF-8 BOM は呼び出し側で付与） */
export function buildCsv(db, opts = {}) {
  const { order = 'asc', categoryIds = null } = opts;
  const items = categoryIds
    ? db.achievements.filter((a) => categoryIds.includes(a.categoryId))
    : db.achievements;
  const groups = groupByCategory(items, order);
  const lines = [CSV_HEADER.join(',')];
  groups.forEach((g) => {
    g.items.forEach((a) => {
      const { parts } = formatAuthors(db, a, { withAffiliation: false });
      // 所属は1件ずつ取り出し、正式名称で重複を除いて並べる
      const affs = (a.authors ?? []).flatMap((au) => authorAffiliation(db, au, false).split('・'))
        .map((s) => s.trim()).filter((s) => s !== '');
      const j = findById(db.masters.journals, a.journalId);
      lines.push([
        g.category.label,
        parts.map((p) => p.name).join('; '),
        [...new Set(affs)].join('; '),
        a.title,
        kindOf(a.categoryId) === 'paper' ? journalLabel(db, a) : conferenceLabel(db, a),
        j ? j.abbr : '',
        a.year, a.month, a.day, a.volume, a.issue, a.pages, a.presentationNumber,
        kindOf(a.categoryId) === 'paper' ? (a.reviewed ? '有' : '無') : '',
        a.doi, a.venue, a.note,
      ].map(escCsv).join(','));
    });
  });
  return lines.join('\r\n') + '\r\n';
}

/** 出力ファイル名 */
export function fileName(ext, d = new Date()) {
  const p2 = (x) => String(x).padStart(2, '0');
  return `業績目録_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.${ext}`;
}

/** バックアップのファイル名 */
export function backupFileName(d = new Date()) {
  const p2 = (x) => String(x).padStart(2, '0');
  return `achievements_backup_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.json`;
}
