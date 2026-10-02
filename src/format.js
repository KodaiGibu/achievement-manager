/**
 * 業績管理アプリ — 出力整形
 *
 * 業績ごとの「表記言語」（自動 / 日本語 / 英語）に応じて著者名・所属を和文または英文で出力する。
 * 所属は階層（機関 ＞ 学部 ＞ 専攻 など）をたどって組み立てる。自分の氏名は太字＋下線で強調する。
 */
import { CATEGORY_MAP, findById, groupByCategory, kindOf, affiliationPath } from './model.js';

const hasJa = (s) => /[ぁ-んァ-ヶ一-龠々ー]/.test(String(s ?? ''));
const t = (v) => String(v ?? '').trim();

// ══ 表記言語 ══

/**
 * 業績の表記言語を決める。
 *  - lang が 'ja' / 'en' ならそのまま
 *  - 'auto': 国際学会は英語。それ以外はタイトルと掲載誌・大会名に日本語を含まなければ英語
 */
export function resolveLang(db, a) {
  if (a.lang === 'ja' || a.lang === 'en') return a.lang;
  if (CATEGORY_MAP[a.categoryId]?.scope === 'international') return 'en';
  const venue = kindOf(a.categoryId) === 'paper' ? journalLabel(db, a) : conferenceLabel(db, a);
  const text = `${t(a.title)}${t(venue)}`;
  if (text === '') return 'ja';
  return hasJa(text) ? 'ja' : 'en';
}

// ══ 著者 ══

export function authorName(db, author, lang = 'ja') {
  const p = findById(db.masters.persons, author.personId);
  const ja = t(p ? p.name : author.freeName);
  const en = t(p ? p.nameEn : '') || t(author.freeNameEn);
  if (lang === 'en') return en || ja;
  return ja || en;
}

export function hasEnglishName(db, author) {
  const p = findById(db.masters.persons, author.personId);
  return t(p ? p.nameEn : '') !== '' || t(author.freeNameEn) !== '';
}

// ══ 所属 ══

/**
 * 1 つの所属（階層の 1 段）の表記。
 *  ja: 略称 → 名称（useShort=false なら名称）
 *  en: 英語略称 → 英語名称 → 和文（英語が未登録の場合）
 */
export function affiliationText(aff, lang = 'ja', useShort = true) {
  if (!aff) return '';
  if (lang === 'en') {
    const en = useShort ? (t(aff.shortNameEn) || t(aff.nameEn)) : (t(aff.nameEn) || t(aff.shortNameEn));
    if (en) return en;
  }
  return useShort ? (t(aff.shortName) || t(aff.name)) : t(aff.name);
}

/** 出力に使う階層の段を選ぶ（full: すべて / top: 最上位のみ / leaf: 最下位のみ） */
export function pickPath(path, display = 'full') {
  if (!path.length) return [];
  if (display === 'top') return [path[0]];
  if (display === 'leaf') return [path[path.length - 1]];
  return path;
}

/**
 * 所属 1 件を階層込みで表記する。
 *  ja: 上位 → 下位の順に半角スペースで連結（東京大学 理学系研究科 生物科学専攻）
 *  en: 下位 → 上位の順にカンマで連結（Dept. of Biological Sciences, Grad. Sch. of Science, UTokyo）
 */
export function affiliationPathText(db, id, lang = 'ja', useShort = true, display = null) {
  const mode = display ?? db.profile?.affDisplay ?? 'full';
  const parts = pickPath(affiliationPath(db, id), mode)
    .map((a) => affiliationText(a, lang, useShort)).filter((s) => s !== '');
  if (lang === 'en') return parts.reverse().join(', ');
  return parts.join(' ');
}

/**
 * 著者の所属の表記。複数所属の区切りは ja:「・」/ en:「, 」。
 * 英語で階層を含む（カンマを使う）所属がある場合は、区切りを「; 」にして読み違いを防ぐ。
 */
export function authorAffiliation(db, author, useShort = true, lang = 'ja', display = null) {
  const names = (author.affiliationIds ?? [])
    .map((id) => affiliationPathText(db, id, lang, useShort, display)).filter((s) => s !== '');
  const free = t(author.freeAffiliation);
  if (free !== '') names.push(free);
  if (lang === 'en') return names.join(names.some((s) => s.includes(',')) ? '; ' : ', ');
  return names.join('・');
}

/** 自分の氏名かどうか（profile.selfNames と空白を除いて一致） */
export function isSelf(db, name) {
  const n = t(name).replace(/\s+/g, '');
  if (n === '') return false;
  return (db.profile.selfNames ?? []).some((s) => {
    const x = t(s).replace(/\s+/g, '');
    return x !== '' && n === x;
  });
}

export function isSelfAuthor(db, author) {
  return isSelf(db, authorName(db, author, 'ja')) || isSelf(db, authorName(db, author, 'en'));
}

export function formatAuthors(db, achievement, { lang = 'ja', withAffiliation = true } = {}) {
  const parts = (achievement.authors ?? []).map((au) => ({
    name: authorName(db, au, lang),
    affiliation: withAffiliation ? authorAffiliation(db, au, true, lang) : '',
    self: isSelfAuthor(db, au),
  })).filter((p) => p.name !== '');
  const text = parts.map((p) => authorLabel(p, lang)).join(lang === 'en' ? ', ' : '・');
  return { text, parts };
}

function authorLabel(p, lang) {
  if (!p.affiliation) return p.name;
  return lang === 'en' ? `${p.name} (${p.affiliation})` : `${p.name}（${p.affiliation}）`;
}

// ══ 日付・巻号・誌名 ══

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export function formatDateJa(a) {
  const y = t(a.year);
  if (y === '') return '';
  const m = t(a.month);
  const d = t(a.day);
  let s = `${y}年`;
  if (m !== '') s += `${Number(m)}月`;
  if (m !== '' && d !== '') s += `${Number(d)}日`;
  return s;
}

export function formatDateEn(a) {
  const y = t(a.year);
  if (y === '') return '';
  const m = Number(t(a.month));
  const d = t(a.day);
  if (!m || m < 1 || m > 12) return y;
  return d !== '' ? `${Number(d)} ${MONTHS_EN[m - 1]} ${y}` : `${MONTHS_EN[m - 1]} ${y}`;
}

export function formatDate(a, lang) {
  return lang === 'en' ? formatDateEn(a) : formatDateJa(a);
}

export function formatVolume(a) {
  const v = t(a.volume);
  const i = t(a.issue);
  if (v === '' && i === '') return '';
  if (i === '') return v;
  if (v === '') return `(${i})`;
  return `${v}(${i})`;
}

export function journalLabel(db, a, preferAbbr = false) {
  const j = findById(db.masters.journals, a.journalId);
  if (j) {
    const abbr = t(j.abbr);
    return preferAbbr && abbr !== '' ? abbr : j.name;
  }
  return t(a.freeJournal);
}

export function conferenceLabel(db, a) {
  const c = findById(db.masters.conferences, a.conferenceId);
  if (c) return c.name;
  return t(a.freeConference);
}

// ══ 1件分の整形 ══

export function formatItemParts(db, a) {
  const kind = kindOf(a.categoryId);
  const lang = resolveLang(db, a);
  const en = lang === 'en';
  const out = [];
  const push = (text, opts = {}) => { if (text !== '') out.push({ text, ...opts }); };

  const { parts } = formatAuthors(db, a, { lang, withAffiliation: kind === 'conference' || kind === 'other' });
  parts.forEach((p, i) => {
    if (i > 0) push(en ? ', ' : '・');
    push(authorLabel(p, lang), p.self ? { bold: true, underline: true } : {});
  });

  const title = t(a.title);
  const date = formatDate(a, lang);
  const venue = t(a.venue);

  if (kind === 'paper') {
    const y = t(a.year);
    push(y !== '' ? ` (${y}).` : '.');
    if (title !== '') {
      push(` ${title}`);
      if (!/[.。?!]$/.test(title)) push('.');
    }
    const jn = journalLabel(db, a);
    if (jn !== '') { push(' '); push(jn, { italic: true }); }
    const vol = formatVolume(a);
    if (vol !== '') push(`, ${vol}`);
    const pg = t(a.pages);
    if (pg !== '') push(`, ${pg}`);
    push('.');
    const doi = t(a.doi);
    if (doi !== '') push(` ${doi.startsWith('http') ? doi : `https://doi.org/${doi}`}`);
    return out;
  }

  const cn = conferenceLabel(db, a);
  const num = t(a.presentationNumber);

  if (kind === 'conference') {
    push('.');
    if (en) {
      if (title !== '') push(` "${title}".`);
      if (cn !== '') push(` ${cn}.`);
      if (date !== '') push(` ${date}.`);
      if (venue !== '') push(` ${venue}.`);
      if (num !== '') push(` No. ${num}.`);
    } else {
      if (title !== '') push(`「${title}」.`);
      if (cn !== '') push(` ${cn}.`);
      if (date !== '') push(` ${date}.`);
      if (venue !== '') push(` ${venue}.`);
      if (num !== '') push(` 発表番号${num}.`);
    }
    return out;
  }

  const sep = en ? '.' : '．';
  push(sep);
  if (title !== '') push(`${en ? ' ' : ''}${title}${sep}`);
  if (cn !== '') push(` ${cn}${sep}`);
  if (date !== '') push(` ${date}${sep}`);
  if (venue !== '') push(` ${venue}${sep}`);
  const note = t(a.note);
  if (note !== '') push(` ${note}`);
  return out;
}

// ══ 出力形式ごとの変換 ══

const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function partsToHtml(parts) {
  return parts.map((p) => {
    let x = escHtml(p.text);
    if (p.italic) x = `<em>${x}</em>`;
    if (p.underline) x = `<u>${x}</u>`;
    if (p.bold) x = `<strong>${x}</strong>`;
    return x;
  }).join('');
}
function partsToMarkdown(parts) {
  return parts.map((p) => {
    let x = p.text;
    if (p.italic) x = `_${x}_`;
    if (p.underline) x = `<u>${x}</u>`;
    if (p.bold) x = `**${x}**`;
    return x;
  }).join('');
}
const partsToPlain = (parts) => parts.map((p) => p.text).join('');

export function formatItem(db, a, format = 'plain') {
  const parts = formatItemParts(db, a);
  if (format === 'html') return partsToHtml(parts);
  if (format === 'markdown') return partsToMarkdown(parts);
  return partsToPlain(parts);
}

export function buildList(db, format = 'markdown', opts = {}) {
  const { order = 'asc', title = null, categoryIds = null } = opts;
  const items = categoryIds ? db.achievements.filter((a) => categoryIds.includes(a.categoryId)) : db.achievements;
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
    const body = groups.map((g) => `## ${g.category.label}\n\n${
      g.items.map((a) => `- ${partsToMarkdown(formatItemParts(db, a))}`).join('\n')}`).join('\n\n');
    return `# ${heading}\n\n${body}\n`;
  }
  const body = groups.map((g) => `【${g.category.label}】\n${
    g.items.map((a) => `・${partsToPlain(formatItemParts(db, a))}`).join('\n')}`).join('\n\n');
  return `${heading}\n\n${body}\n`;
}

export function defaultTitle(d = new Date()) {
  return `業績目録（${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日現在）`;
}

// ══ CSV ══

export const CSV_HEADER = [
  '区分', '表記', '著者', '著者（英語）', '所属', '所属（英語）', 'タイトル', 'ジャーナル/大会名', 'ジャーナル略称',
  '年', '月', '日', '巻', '号', 'ページ/文献番号', '発表番号', '査読', 'DOI', '会場', '備考',
];

function escCsv(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 所属を 1 件ずつ（階層をすべて含む正式名称で）重複を除いて並べる */
function uniqueAffiliations(db, a, lang) {
  const names = [];
  (a.authors ?? []).forEach((au) => (au.affiliationIds ?? []).forEach((id) => {
    const s = affiliationPathText(db, id, lang, false, 'full');
    if (s && !names.includes(s)) names.push(s);
  }));
  return names;
}

export function buildCsv(db, opts = {}) {
  const { order = 'asc', categoryIds = null } = opts;
  const items = categoryIds ? db.achievements.filter((a) => categoryIds.includes(a.categoryId)) : db.achievements;
  const lines = [CSV_HEADER.join(',')];
  groupByCategory(items, order).forEach((g) => g.items.forEach((a) => {
    const names = (lang) => (a.authors ?? []).map((au) => authorName(db, au, lang)).filter(Boolean).join('; ');
    const j = findById(db.masters.journals, a.journalId);
    lines.push([
      g.category.label, resolveLang(db, a) === 'en' ? '英語' : '日本語',
      names('ja'), names('en'),
      uniqueAffiliations(db, a, 'ja').join('; '), uniqueAffiliations(db, a, 'en').join('; '),
      a.title, kindOf(a.categoryId) === 'paper' ? journalLabel(db, a) : conferenceLabel(db, a),
      j ? j.abbr : '', a.year, a.month, a.day, a.volume, a.issue, a.pages, a.presentationNumber,
      kindOf(a.categoryId) === 'paper' ? (a.reviewed ? '有' : '無') : '', a.doi, a.venue, a.note,
    ].map(escCsv).join(','));
  }));
  return lines.join('\r\n') + '\r\n';
}

export function fileName(ext, d = new Date()) {
  const p2 = (x) => String(x).padStart(2, '0');
  return `業績目録_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.${ext}`;
}

export function backupFileName(d = new Date()) {
  const p2 = (x) => String(x).padStart(2, '0');
  return `achievements_backup_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.json`;
}
