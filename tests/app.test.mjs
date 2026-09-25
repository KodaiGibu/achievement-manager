/**
 * 業績管理アプリ — ロジック検証
 * 実行: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, CATEGORY_MAP, kindOf, emptyDb, emptyAchievement, emptyAuthor,
  upsertMaster, findById, removeMaster, countMasterUsage,
  groupByCategory, dateKey, summarize, exportJson, importJson, migrate, signature,
} from '../src/model.js';
import {
  formatAuthors, formatItem, formatDateJa, formatVolume, isSelf,
  buildList, buildCsv, journalLabel, conferenceLabel, defaultTitle,
  fileName, backupFileName, CSV_HEADER,
} from '../src/format.js';

/** テスト用のサンプル DB を組み立てる */
function sampleDb() {
  const db = emptyDb();
  const aist = upsertMaster(db.masters.affiliations, { name: '産業技術総合研究所', shortName: '産総研' }, 'name', 'aff');
  const utokyo = upsertMaster(db.masters.affiliations, { name: '東京大学', shortName: '東京大' }, 'name', 'aff');
  const me = upsertMaster(db.masters.persons, { name: '儀武滉大', nameEn: 'Gibu, K.', affiliationIds: [aist] }, 'name', 'per');
  const ig = upsertMaster(db.masters.persons, { name: '井口亮', nameEn: 'Iguchi, A.', affiliationIds: [aist] }, 'name', 'per');
  const sr = upsertMaster(db.masters.journals, { name: 'Scientific Reports', abbr: 'Sci Rep' }, 'name', 'jnl');
  const cf = upsertMaster(db.masters.conferences, { name: '日本生態学会第72回全国大会' }, 'name', 'cnf');

  const paper = emptyAchievement('journal_reviewed');
  Object.assign(paper, {
    authors: [{ ...emptyAuthor(), personId: me }, { ...emptyAuthor(), personId: ig }],
    title: 'Polyamine impact on physiology of early stages of reef-building corals',
    journalId: sr, year: '2024', volume: '14', issue: '1', pages: '23465',
  });
  const conf = emptyAchievement('conf_dom_oral');
  Object.assign(conf, {
    authors: [
      { ...emptyAuthor(), personId: me, affiliationIds: [utokyo, aist] },
      { ...emptyAuthor(), personId: ig, affiliationIds: [aist] },
    ],
    title: '南西諸島における造礁サンゴの細菌叢解析',
    conferenceId: cf, year: '2025', month: '3', day: '15', presentationNumber: 'I01-01',
  });
  const lec = emptyAchievement('lecture');
  Object.assign(lec, {
    authors: [{ ...emptyAuthor(), personId: me, affiliationIds: [aist] }],
    title: '沖縄県委託事業 令和6年度「健康・医療データサイエンス人材育成事業」',
    year: '2024', month: '10', day: '19', venue: 'オンラインセミナー',
    note: 'バイオインフォマティクス分野の2時間講義を3回担当．',
  });
  db.achievements.push(paper, conf, lec);
  return { db, ids: { aist, utokyo, me, ig, sr, cf }, paper, conf, lec };
}

// ══ 区分 ══
test('区分の定義と入力形式の対応', () => {
  assert.ok(CATEGORIES.length >= 8);
  assert.equal(kindOf('journal_reviewed'), 'paper');
  assert.equal(kindOf('journal_unreviewed'), 'paper');
  assert.equal(kindOf('conf_dom_oral'), 'conference');
  assert.equal(kindOf('conf_intl_poster'), 'conference');
  assert.equal(kindOf('lecture'), 'other');
  assert.equal(kindOf('unknown'), 'other');
  assert.equal(CATEGORY_MAP.journal_reviewed.reviewed, true);
  assert.equal(CATEGORY_MAP.journal_unreviewed.reviewed, false);
});

// ══ マスタの記憶 ══
test('マスタは名称一致で使い回され、重複登録されない', () => {
  const db = emptyDb();
  const a = upsertMaster(db.masters.journals, { name: 'Scientific Reports', abbr: 'Sci Rep' }, 'name', 'jnl');
  const b = upsertMaster(db.masters.journals, { name: 'Scientific Reports', abbr: '' }, 'name', 'jnl');
  assert.equal(a, b);
  assert.equal(db.masters.journals.length, 1);
  assert.equal(db.masters.journals[0].abbr, 'Sci Rep');
});

test('マスタは後から入力された略称を補完する', () => {
  const db = emptyDb();
  upsertMaster(db.masters.journals, { name: 'PeerJ', abbr: '' }, 'name', 'jnl');
  upsertMaster(db.masters.journals, { name: 'PeerJ', abbr: 'PeerJ' }, 'name', 'jnl');
  assert.equal(db.masters.journals.length, 1);
  assert.equal(db.masters.journals[0].abbr, 'PeerJ');
});

test('使用中のマスタは削除できず、未使用なら削除できる', () => {
  const { db, ids } = sampleDb();
  assert.equal(countMasterUsage(db, 'journals', ids.sr), 1);
  const r1 = removeMaster(db, 'journals', ids.sr);
  assert.equal(r1.removed, false);
  assert.equal(r1.used, 1);

  const unused = upsertMaster(db.masters.journals, { name: 'Unused Journal', abbr: '' }, 'name', 'jnl');
  assert.equal(countMasterUsage(db, 'journals', unused), 0);
  assert.equal(removeMaster(db, 'journals', unused).removed, true);
  assert.equal(findById(db.masters.journals, unused), null);
});

test('共著者・所属の使用件数を数えられる', () => {
  const { db, ids } = sampleDb();
  assert.equal(countMasterUsage(db, 'persons', ids.me), 3);
  assert.equal(countMasterUsage(db, 'persons', ids.ig), 2);
  // 所属は業績での使用 + 人物マスタの既定所属
  assert.ok(countMasterUsage(db, 'affiliations', ids.aist) >= 2);
});

// ══ 自分の強調 ══
test('自分の氏名判定（空白の有無を無視）', () => {
  const { db } = sampleDb();
  assert.equal(isSelf(db, '儀武滉大'), true);
  assert.equal(isSelf(db, '儀武 滉大'), true);
  assert.equal(isSelf(db, 'Gibu, K.'), true);
  assert.equal(isSelf(db, '井口亮'), false);
  assert.equal(isSelf(db, ''), false);
});

test('出力で自分だけが太字＋下線になる', () => {
  const { db, paper } = sampleDb();
  const html = formatItem(db, paper, 'html');
  assert.ok(html.includes('<strong><u>儀武滉大</u></strong>'));
  assert.ok(html.includes('井口亮'));
  assert.ok(!html.includes('<strong><u>井口亮</u></strong>'));
  const md = formatItem(db, paper, 'markdown');
  assert.ok(md.startsWith('**<u>儀武滉大</u>**'));
});

// ══ 整形 ══
test('日付と巻号の整形', () => {
  assert.equal(formatDateJa({ year: '2025', month: '3', day: '15' }), '2025年3月15日');
  assert.equal(formatDateJa({ year: '2025', month: '3', day: '' }), '2025年3月');
  assert.equal(formatDateJa({ year: '2025', month: '', day: '' }), '2025年');
  assert.equal(formatDateJa({ year: '', month: '3', day: '1' }), '');
  assert.equal(formatVolume({ volume: '14', issue: '1' }), '14(1)');
  assert.equal(formatVolume({ volume: '49', issue: '' }), '49');
  assert.equal(formatVolume({ volume: '', issue: '' }), '');
});

test('論文の出力が添付の業績目録と同じ並びになる', () => {
  const { db, paper } = sampleDb();
  assert.equal(formatItem(db, paper, 'plain'),
    '儀武滉大・井口亮 (2024). Polyamine impact on physiology of early stages of reef-building corals. '
    + 'Scientific Reports, 14(1), 23465.');
});

test('学会発表の出力（所属付き・「タイトル」・発表番号）', () => {
  const { db, conf } = sampleDb();
  assert.equal(formatItem(db, conf, 'plain'),
    '儀武滉大（東京大・産総研）・井口亮（産総研）.「南西諸島における造礁サンゴの細菌叢解析」. '
    + '日本生態学会第72回全国大会. 2025年3月15日. 発表番号I01-01.');
});

test('その他（講義）の出力に会場と備考が入る', () => {
  const { db, lec } = sampleDb();
  const t = formatItem(db, lec, 'plain');
  assert.ok(t.includes('儀武滉大（産総研）'));
  assert.ok(t.includes('2024年10月19日'));
  assert.ok(t.includes('オンラインセミナー'));
  assert.ok(t.includes('2時間講義を3回担当'));
});

test('著者が英語名のみなら英語表記の区切りになる', () => {
  const db = emptyDb();
  const me = upsertMaster(db.masters.persons, { name: 'Gibu, K.' }, 'name', 'per');
  const ka = upsertMaster(db.masters.persons, { name: 'Iguchi, A.' }, 'name', 'per');
  const a = emptyAchievement('journal_reviewed');
  Object.assign(a, {
    authors: [{ ...emptyAuthor(), personId: me }, { ...emptyAuthor(), personId: ka }],
    title: 'Test paper', freeJournal: 'PeerJ', year: '2020', volume: '8', pages: 'e8449',
  });
  assert.equal(formatItem(db, a, 'plain'), 'Gibu, K., Iguchi, A. (2020). Test paper. PeerJ, 8, e8449.');
});

test('DOI を付けると末尾に URL が入る', () => {
  const { db, paper } = sampleDb();
  const withDoi = { ...paper, doi: '10.1038/s41598-024-74596-x' };
  assert.ok(formatItem(db, withDoi, 'plain').endsWith('https://doi.org/10.1038/s41598-024-74596-x'));
});

test('ジャーナル・大会名はマスタ優先、未登録なら手入力値', () => {
  const { db, paper } = sampleDb();
  assert.equal(journalLabel(db, paper), 'Scientific Reports');
  assert.equal(journalLabel(db, paper, true), 'Sci Rep');
  const free = { ...emptyAchievement('journal_reviewed'), freeJournal: 'New Journal' };
  assert.equal(journalLabel(db, free), 'New Journal');
  const freeConf = { ...emptyAchievement('conf_dom_oral'), freeConference: '第1回大会' };
  assert.equal(conferenceLabel(db, freeConf), '第1回大会');
});

// ══ 並べ替え・グループ化 ══
test('区分ごとにまとめ、日付順に並ぶ', () => {
  const { db } = sampleDb();
  const asc = groupByCategory(db.achievements, 'asc');
  assert.equal(asc.length, 3);
  assert.equal(asc[0].category.id, 'journal_reviewed');
  assert.equal(asc[1].category.id, 'conf_dom_oral');
  assert.equal(asc[2].category.id, 'lecture');

  const more = emptyAchievement('conf_dom_oral');
  Object.assign(more, { title: '古い発表', year: '2021', month: '5', day: '29' });
  db.achievements.push(more);
  const g = groupByCategory(db.achievements, 'asc').find((x) => x.category.id === 'conf_dom_oral');
  assert.equal(g.items[0].title, '古い発表');
  const gd = groupByCategory(db.achievements, 'desc').find((x) => x.category.id === 'conf_dom_oral');
  assert.equal(gd.items[0].title, '南西諸島における造礁サンゴの細菌叢解析');
});

test('日付キーの比較', () => {
  assert.ok(dateKey({ year: '2025', month: '3', day: '15' }) > dateKey({ year: '2024', month: '12', day: '31' }));
  assert.ok(dateKey({ year: '2024', month: '10', day: '1' }) > dateKey({ year: '2024', month: '9', day: '30' }));
  assert.equal(dateKey({ year: '', month: '', day: '' }), 0);
});

// ══ 一覧出力 ══
test('業績リスト（Markdown）に見出しと項目が並ぶ', () => {
  const { db } = sampleDb();
  const md = buildList(db, 'markdown', { title: '業績目録（テスト）' });
  assert.ok(md.startsWith('# 業績目録（テスト）'));
  assert.ok(md.includes('## 学術雑誌等に発表した論文［査読有］'));
  assert.ok(md.includes('## 国内学会等における発表［口頭発表］'));
  assert.ok(md.includes('## 講義・実習（集中講義等）'));
  assert.ok(md.includes('**<u>儀武滉大</u>**'));
});

test('業績リスト（HTML）は単独で開ける完全な文書', () => {
  const { db } = sampleDb();
  const html = buildList(db, 'html');
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<h2>学術雑誌等に発表した論文［査読有］</h2>'));
  assert.ok(html.includes('<strong><u>儀武滉大</u></strong>'));
  assert.ok(html.includes('#b5b5ac'));
});

test('出力する区分を絞り込める', () => {
  const { db } = sampleDb();
  const md = buildList(db, 'markdown', { categoryIds: ['journal_reviewed'] });
  assert.ok(md.includes('学術雑誌等に発表した論文'));
  assert.ok(!md.includes('国内学会等における発表'));
});

test('CSV 出力の列構成と内容', () => {
  const { db } = sampleDb();
  const lines = buildCsv(db).trim().split('\r\n');
  assert.equal(lines[0], CSV_HEADER.join(','));
  assert.equal(lines.length, 4); // ヘッダ + 3件
  assert.ok(lines.every((l) => l.split(',').length >= CSV_HEADER.length));
  assert.ok(lines[1].includes('儀武滉大; 井口亮'));
  assert.ok(lines[1].includes('有'));
});

test('CSV: カンマを含む値はクォートされる', () => {
  const db = emptyDb();
  const a = emptyAchievement('other');
  Object.assign(a, { title: 'A, B and C', year: '2024' });
  db.achievements.push(a);
  assert.ok(buildCsv(db).includes('"A, B and C"'));
});

// ══ データ入出力 ══
test('JSON エクスポートと置き換え読み込み', () => {
  const { db } = sampleDb();
  const json = exportJson(db);
  const { db: restored } = importJson(json, 'replace');
  assert.equal(restored.achievements.length, 3);
  assert.equal(restored.masters.journals.length, 1);
  assert.equal(restored.masters.persons.length, 2);
  // 出力結果が一致する
  assert.equal(buildList(restored, 'plain', { title: 'x' }), buildList(db, 'plain', { title: 'x' }));
});

test('マージ読み込み: マスタは名称でまとめ、重複業績は追加しない', () => {
  const { db: a } = sampleDb();
  const { db: b } = sampleDb();
  const { db: merged, added } = importJson(exportJson(b), 'merge', a);
  assert.equal(added, 0, '同一内容は追加されない');
  assert.equal(merged.achievements.length, 3);
  assert.equal(merged.masters.journals.length, 1, 'ジャーナルが重複登録されない');
  assert.equal(merged.masters.persons.length, 2);
});

test('マージ読み込み: 新しい業績は追加され、参照も引き継がれる', () => {
  const { db: a } = sampleDb();
  const { db: b } = sampleDb();
  const extra = emptyAchievement('conf_intl_poster');
  const j = upsertMaster(b.masters.conferences, { name: '1st APBJC' }, 'name', 'cnf');
  const p = upsertMaster(b.masters.persons, { name: 'Kodai Gibu' }, 'name', 'per');
  Object.assign(extra, {
    authors: [{ ...emptyAuthor(), personId: p }],
    title: 'Microbiome Analysis of Reef-Building Corals',
    conferenceId: j, year: '2024', month: '10', day: '23', presentationNumber: '23-VI-4',
  });
  b.achievements.push(extra);

  const { db: merged, added } = importJson(exportJson(b), 'merge', a);
  assert.equal(added, 1);
  assert.equal(merged.achievements.length, 4);
  const hit = merged.achievements.find((x) => x.title.startsWith('Microbiome'));
  assert.equal(conferenceLabel(merged, hit), '1st APBJC', '大会名の参照が解決される');
});

test('旧データ・不正データの移行', () => {
  const old = { achievements: [{ categoryId: 'journal_reviewed', title: '旧データ', year: '2020' }] };
  const m = migrate(old);
  assert.equal(m.achievements.length, 1);
  assert.equal(m.achievements[0].title, '旧データ');
  assert.ok(Array.isArray(m.achievements[0].authors), '欠けたフィールドが補完される');
  assert.equal(m.masters.journals.length, 0);
  assert.equal(migrate(null).achievements.length, 0);
  assert.throws(() => importJson('これはJSONではない'), /JSON として読み取れません/);
});

test('重複判定のシグネチャ', () => {
  const a = emptyAchievement('journal_reviewed');
  Object.assign(a, { title: 'T', year: '2024' });
  const b = { ...a, id: 'other-id' };
  assert.equal(signature(a), signature(b));
  assert.notEqual(signature(a), signature({ ...a, year: '2025' }));
});

// ══ 集計・ファイル名 ══
test('登録状況の集計', () => {
  const { db } = sampleDb();
  const s = summarize(db);
  assert.equal(s.total, 3);
  assert.equal(s.byCategory.journal_reviewed, 1);
  assert.equal(s.minYear, 2024);
  assert.equal(s.maxYear, 2025);
  assert.equal(s.journals, 1);
  assert.equal(s.persons, 2);
});

test('ファイル名と既定の表題', () => {
  const d = new Date(2026, 8, 25);
  assert.equal(fileName('html', d), '業績目録_20260925.html');
  assert.equal(fileName('csv', d), '業績目録_20260925.csv');
  assert.equal(backupFileName(d), 'achievements_backup_20260925.json');
  assert.equal(defaultTitle(d), '業績目録（2026年9月25日現在）');
});

test('著者の所属は略称を優先し、複数所属は「・」で連結', () => {
  const { db, conf } = sampleDb();
  const { text } = formatAuthors(db, conf);
  assert.ok(text.startsWith('儀武滉大（東京大・産総研）'));
});

// ══════════════════════════════════════════
//  追加機能: DOI / BibTeX / RIS / 科研費 / 年度別集計
// ══════════════════════════════════════════
import { normalizeDoi, doiUrl, mapCrossrefMessage, fetchByDoi } from '../src/crossref.js';
import {
  citationKey, bibEntryType, toBibtex, buildBibtex,
  risType, toRis, buildRis,
  buildKakenhi, kakenhiFlags, KAKENHI_SECTIONS,
  fiscalYear, summarizeByYear, buildYearlyCsv, yearlyBar, exportFileName,
} from '../src/export-formats.js';

// ══ DOI の正規化 ══
test('DOI の正規化: URL・接頭辞・空白を取り除く', () => {
  assert.equal(normalizeDoi('10.1038/s41598-024-74596-x'), '10.1038/s41598-024-74596-x');
  assert.equal(normalizeDoi('https://doi.org/10.1038/s41598-024-74596-x'), '10.1038/s41598-024-74596-x');
  assert.equal(normalizeDoi('http://dx.doi.org/10.7717/peerj.8449'), '10.7717/peerj.8449');
  assert.equal(normalizeDoi('doi:10.1007/s11033-022-07743-0'), '10.1007/s11033-022-07743-0');
  assert.equal(normalizeDoi('  10.1234/abc  '), '10.1234/abc');
});

test('DOI の正規化: 不正な入力はエラー', () => {
  assert.throws(() => normalizeDoi(''), /DOI を入力してください/);
  assert.throws(() => normalizeDoi('not-a-doi'), /DOI の形式ではありません/);
  assert.throws(() => normalizeDoi('11.1234/abc'), /DOI の形式ではありません/);
  assert.equal(doiUrl('10.1234/abc'), 'https://doi.org/10.1234/abc');
  assert.equal(doiUrl('https://doi.org/10.1/x'), 'https://doi.org/10.1/x');
  assert.equal(doiUrl(''), '');
});

// ══ CrossRef 応答の変換 ══
const CROSSREF_SAMPLE = {
  DOI: '10.1038/s41598-024-74596-x',
  type: 'journal-article',
  title: ['Polyamine impact on physiology of early stages of reef-building corals'],
  'container-title': ['Scientific Reports'],
  'short-container-title': ['Sci Rep'],
  volume: '14',
  issue: '1',
  page: '23465',
  publisher: 'Springer Science and Business Media LLC',
  'published-print': { 'date-parts': [[2024, 10, 8]] },
  issued: { 'date-parts': [[2024, 10, 8]] },
  author: [
    { given: 'Kodai', family: 'Gibu', sequence: 'first', affiliation: [{ name: 'AIST' }] },
    { given: 'Akira', family: 'Iguchi', sequence: 'additional', affiliation: [] },
  ],
};

test('CrossRef 応答を入力欄の値へ変換できる', () => {
  const m = mapCrossrefMessage(CROSSREF_SAMPLE);
  assert.equal(m.title, 'Polyamine impact on physiology of early stages of reef-building corals');
  assert.equal(m.journal, 'Scientific Reports');
  assert.equal(m.journalAbbr, 'Sci Rep');
  assert.equal(m.year, '2024');
  assert.equal(m.month, '10');
  assert.equal(m.day, '8');
  assert.equal(m.volume, '14');
  assert.equal(m.issue, '1');
  assert.equal(m.pages, '23465');
  assert.equal(m.doi, '10.1038/s41598-024-74596-x');
  assert.equal(m.authors.length, 2);
  assert.equal(m.authors[0].name, 'Gibu, Kodai');
  assert.equal(m.authors[0].affiliation, 'AIST');
  assert.equal(m.authors[1].name, 'Iguchi, Akira');
});

test('CrossRef 応答: ページが無ければ論文番号を使い、issued で代替する', () => {
  const m = mapCrossrefMessage({
    title: ['T'], 'container-title': ['J'],
    'article-number': 'e8449', issued: { 'date-parts': [[2020, 1]] },
    author: [{ family: 'Mizuyama', given: 'M' }],
  });
  assert.equal(m.pages, 'e8449');
  assert.equal(m.year, '2020');
  assert.equal(m.month, '1');
  assert.equal(m.day, '');
  assert.throws(() => mapCrossrefMessage(null), /書誌情報を読み取れません/);
});

test('fetchByDoi: 正常応答を変換して返す', async () => {
  let calledUrl = '';
  const fake = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ status: 'ok', message: CROSSREF_SAMPLE }) };
  };
  const m = await fetchByDoi('https://doi.org/10.1038/s41598-024-74596-x', { fetchImpl: fake });
  assert.ok(calledUrl.startsWith('https://api.crossref.org/works/'));
  assert.ok(calledUrl.includes('10.1038'));
  assert.equal(m.journal, 'Scientific Reports');
});

test('fetchByDoi: 404・通信失敗・不正応答をわかりやすいエラーにする', async () => {
  const notFound = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(() => fetchByDoi('10.1234/none', { fetchImpl: notFound }),
    /CrossRef に登録されていません/);

  const serverErr = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => fetchByDoi('10.1234/x', { fetchImpl: serverErr }), /HTTP 500/);

  const netErr = async () => { throw new Error('network down'); };
  await assert.rejects(() => fetchByDoi('10.1234/x', { fetchImpl: netErr }), /接続できませんでした/);

  const badBody = async () => ({ ok: true, status: 200, json: async () => ({ status: 'error' }) });
  await assert.rejects(() => fetchByDoi('10.1234/x', { fetchImpl: badBody }), /書誌情報が含まれていません/);
});

test('fetchByDoi: mailto を付けると polite pool のクエリになる', async () => {
  let url = '';
  const fake = async (u) => {
    url = u;
    return { ok: true, status: 200, json: async () => ({ status: 'ok', message: CROSSREF_SAMPLE }) };
  };
  await fetchByDoi('10.1234/x', { fetchImpl: fake, mailto: 'a@b.jp' });
  assert.ok(url.includes('mailto=a%40b.jp'));
});

// ══ BibTeX ══
test('BibTeX: 種別と引用キー', () => {
  assert.equal(bibEntryType('journal_reviewed'), 'article');
  assert.equal(bibEntryType('conf_dom_oral'), 'inproceedings');
  assert.equal(bibEntryType('lecture'), 'misc');
  const { db, paper } = sampleDb();
  // 英語表記（nameEn）があれば ASCII キーになる
  assert.equal(citationKey(db, paper, new Set()), 'Gibu2024Polyamine');
});

test('BibTeX: 引用キーは重複しない', () => {
  const { db, paper } = sampleDb();
  const used = new Set();
  const k1 = citationKey(db, paper, used);
  const k2 = citationKey(db, paper, used);
  assert.notEqual(k1, k2);
  assert.equal(k2, `${k1}b`);
});

test('BibTeX: 論文エントリに誌名・巻号・DOI が入る', () => {
  const { db, paper } = sampleDb();
  const bib = toBibtex(db, { ...paper, doi: '10.1038/s41598-024-74596-x' }, new Set());
  assert.ok(bib.startsWith('@article{'));
  assert.ok(bib.includes('author = {儀武滉大 and 井口亮}'));
  assert.ok(bib.includes('journal = {Scientific Reports}'));
  assert.ok(bib.includes('shortjournal = {Sci Rep}'));
  assert.ok(bib.includes('volume = {14}'));
  assert.ok(bib.includes('number = {1}'));
  assert.ok(bib.includes('pages = {23465}'));
  assert.ok(bib.includes('doi = {10.1038/s41598-024-74596-x}'));
  assert.ok(bib.includes('url = {https://doi.org/10.1038'));
});

test('BibTeX: 学会発表は inproceedings で booktitle と発表番号が入る', () => {
  const { db, conf } = sampleDb();
  const bib = toBibtex(db, conf, new Set());
  assert.ok(bib.startsWith('@inproceedings{'));
  assert.ok(bib.includes('booktitle = {日本生態学会第72回全国大会}'));
  assert.ok(bib.includes('発表番号I01-01'));
});

test('BibTeX: 特殊文字がエスケープされる', () => {
  const db = emptyDb();
  const a = emptyAchievement('journal_reviewed');
  Object.assign(a, { title: 'A & B: 50% of #1', year: '2024' });
  const bib = toBibtex(db, a, new Set());
  assert.ok(bib.includes('\\&'));
  assert.ok(bib.includes('\\%'));
  assert.ok(bib.includes('\\#'));
});

test('BibTeX: ファイル全体に全件と区分コメントが入る', () => {
  const { db } = sampleDb();
  const bib = buildBibtex(db);
  assert.equal((bib.match(/^@/gm) ?? []).length, 3);
  assert.ok(bib.includes('% 学術雑誌等に発表した論文［査読有］'));
  assert.ok(bib.includes('Zotero'));
});

// ══ RIS ══
test('RIS: 種別タグと必須フィールド', () => {
  assert.equal(risType('journal_reviewed'), 'JOUR');
  assert.equal(risType('conf_intl_poster'), 'CPAPER');
  assert.equal(risType('lecture'), 'GEN');
  const { db, paper } = sampleDb();
  const ris = toRis(db, paper);
  assert.ok(ris.startsWith('TY  - JOUR'));
  assert.ok(ris.includes('AU  - 儀武滉大'));
  assert.ok(ris.includes('AU  - 井口亮'));
  assert.ok(ris.includes('JO  - Scientific Reports'));
  assert.ok(ris.includes('J2  - Sci Rep'));
  assert.ok(ris.includes('VL  - 14'));
  assert.ok(ris.includes('IS  - 1'));
  assert.ok(ris.includes('PY  - 2024'));
  assert.ok(ris.trim().endsWith('ER  -'));
});

test('RIS: ページ範囲は SP / EP に分割される', () => {
  const { db, paper } = sampleDb();
  const ris = toRis(db, { ...paper, pages: '60-65' });
  assert.ok(ris.includes('SP  - 60'));
  assert.ok(ris.includes('EP  - 65'));
  // 単一番号なら SP のみ
  assert.ok(toRis(db, paper).includes('SP  - 23465'));
});

test('RIS: 学会発表は T2 と発表番号、日付は DA 形式', () => {
  const { db, conf } = sampleDb();
  const ris = toRis(db, conf);
  assert.ok(ris.startsWith('TY  - CPAPER'));
  assert.ok(ris.includes('T2  - 日本生態学会第72回全国大会'));
  assert.ok(ris.includes('M1  - I01-01'));
  assert.ok(ris.includes('DA  - 2025/3/15//'));
});

test('RIS: 全件が ER で区切られる', () => {
  const { db } = sampleDb();
  const ris = buildRis(db);
  assert.equal((ris.match(/^TY {2}- /gm) ?? []).length, 3);
  assert.equal((ris.match(/^ER {2}- ?$/gm) ?? []).length, 3);
});

// ══ 科研費様式 ══
test('科研費: 区分が雑誌論文・学会発表・その他に振り分けられる', () => {
  assert.equal(KAKENHI_SECTIONS.length, 3);
  assert.ok(KAKENHI_SECTIONS[0].match('journal_reviewed'));
  assert.ok(KAKENHI_SECTIONS[1].match('conf_intl_oral'));
  assert.ok(KAKENHI_SECTIONS[2].match('lecture'));
  assert.ok(!KAKENHI_SECTIONS[0].match('conf_dom_oral'));
});

test('科研費: 査読・国際共著・招待講演の別を判定する', () => {
  const paper = { categoryId: 'journal_reviewed', reviewed: true, doi: '10.1/x' };
  const f1 = kakenhiFlags(paper);
  assert.equal(f1.reviewed, '有');
  assert.equal(f1.international, '該当しない');
  assert.ok(f1.openAccess.includes('オープンアクセス'));

  assert.equal(kakenhiFlags({ categoryId: 'journal_unreviewed', reviewed: false }).reviewed, '無');
  assert.equal(kakenhiFlags({ categoryId: 'conf_intl_poster' }).international, '該当する');
  assert.equal(kakenhiFlags({ categoryId: 'symposium' }).invited, '該当する');
});

test('科研費様式の本文に必要な項目が並ぶ', () => {
  const { db } = sampleDb();
  const t = buildKakenhi(db, { title: '研究発表' });
  assert.ok(t.startsWith('研究発表'));
  assert.ok(t.includes('〔雑誌論文〕'));
  assert.ok(t.includes('計1件'));
  assert.ok(t.includes('儀武滉大、井口亮'), '著者は読点区切り');
  assert.ok(t.includes('Scientific Reports'));
  assert.ok(t.includes('査読の有無：有'));
  assert.ok(t.includes('〔学会発表〕'));
  assert.ok(t.includes('国際学会：該当しない／招待講演：該当しない'));
  assert.ok(t.includes('〔その他〕'));
});

test('科研費: 区分を絞り込める', () => {
  const { db } = sampleDb();
  const t = buildKakenhi(db, { categoryIds: ['journal_reviewed'] });
  assert.ok(t.includes('〔雑誌論文〕'));
  assert.ok(!t.includes('〔学会発表〕'));
});

// ══ 年度別集計 ══
test('年度の判定（4月〜翌3月）', () => {
  assert.equal(fiscalYear({ year: '2025', month: '3' }), 2024, '3月は前年度');
  assert.equal(fiscalYear({ year: '2025', month: '4' }), 2025, '4月から新年度');
  assert.equal(fiscalYear({ year: '2024', month: '12' }), 2024);
  assert.equal(fiscalYear({ year: '2024', month: '' }), 2024, '月が無ければ暦年');
  assert.equal(fiscalYear({ year: '' }), null);
});

test('年度別集計: 年度と暦年で結果が変わる', () => {
  const { db } = sampleDb();
  // 論文2024(月なし) / 学会2025-03 / 講義2024-10
  const fis = summarizeByYear(db, 'fiscal');
  assert.equal(fis.rows.length, 1);
  assert.equal(fis.rows[0].year, 2024);
  assert.equal(fis.rows[0].total, 3, '2025年3月の発表は2024年度に入る');

  const cal = summarizeByYear(db, 'calendar');
  assert.equal(cal.rows.length, 2);
  assert.deepEqual(cal.rows.map((r) => r.year), [2024, 2025]);
  assert.equal(cal.rows[0].total, 2);
  assert.equal(cal.rows[1].total, 1);
});

test('年度別集計: 区分ごとの内訳と年未入力の除外', () => {
  const { db } = sampleDb();
  const noYear = emptyAchievement('other');
  Object.assign(noYear, { title: '年未入力', year: '' });
  db.achievements.push(noYear);

  const s = summarizeByYear(db, 'fiscal');
  assert.equal(s.rows.reduce((n, r) => n + r.total, 0), 3, '年が無い業績は集計対象外');
  assert.equal(s.total, 4, '総件数は全件');
  assert.equal(s.rows[0].byCategory.journal_reviewed, 1);
  assert.equal(s.rows[0].byCategory.conf_dom_oral, 1);
  assert.equal(s.rows[0].byCategory.lecture, 1);
  assert.ok(s.categories.includes('journal_reviewed'));
});

test('年度別集計 CSV: ヘッダ・明細・合計行', () => {
  const { db } = sampleDb();
  const lines = buildYearlyCsv(db, 'calendar').trim().split('\r\n');
  assert.ok(lines[0].startsWith('年,'));
  assert.ok(lines[0].endsWith(',合計'));
  assert.equal(lines.length, 4, 'ヘッダ + 2年 + 合計');
  assert.ok(lines[lines.length - 1].startsWith('合計,'));
  // 合計行の総件数が一致する
  const last = lines[lines.length - 1].split(',');
  assert.equal(last[last.length - 1], '3');
});

test('年度別の推移バー', () => {
  assert.equal(yearlyBar(0, 10).length, 0);
  assert.ok(yearlyBar(10, 10, 20).length > yearlyBar(2, 10, 20).length);
  assert.equal(yearlyBar(5, 0), '');
});

test('追加出力のファイル名', () => {
  const d = new Date(2026, 8, 25);
  assert.equal(exportFileName('bibtex', d), '業績目録_20260925.bib');
  assert.equal(exportFileName('ris', d), '業績目録_20260925.ris');
  assert.equal(exportFileName('kakenhi', d), '科研費様式_研究発表_20260925.txt');
  assert.equal(exportFileName('yearly', d), '年度別集計_20260925.csv');
});
