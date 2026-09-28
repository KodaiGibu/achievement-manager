/**
 * 業績管理アプリ — ロジック検証
 * 実行: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, CATEGORY_MAP, kindOf, emptyDb, emptyAchievement, emptyAuthor,
  upsertMaster, findById, removeMaster, countMasterUsage,
  addAffiliation, affiliationLabel, sortedAffiliations, resolveLegacyAffiliations,
  groupByCategory, dateKey, summarize, exportJson, importJson, migrate, signature, SCHEMA_VERSION,
} from '../src/model.js';
import {
  formatAuthors, formatItem, formatDateJa, formatVolume, isSelf,
  buildList, buildCsv, journalLabel, conferenceLabel, defaultTitle,
  fileName, backupFileName, authorAffiliation, CSV_HEADER,
} from '../src/format.js';
import { normalizeDoi, doiUrl, mapCrossrefMessage, fetchByDoi } from '../src/crossref.js';
import {
  citationKey, bibEntryType, toBibtex, buildBibtex,
  risType, toRis, buildRis,
  buildKakenhi, kakenhiFlags, KAKENHI_SECTIONS,
  fiscalYear, summarizeByYear, buildYearlyCsv, yearlyBar, exportFileName,
} from '../src/export-formats.js';

/** テスト用のサンプル DB を組み立てる */
function sampleDb() {
  const db = emptyDb();
  const aist = addAffiliation(db, '産業技術総合研究所', '産総研').id;
  const utokyo = addAffiliation(db, '東京大学', '東京大').id;
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

// ══════════════════════════════════════════
//  所属の個別登録・略称・選択
// ══════════════════════════════════════════

test('所属: 名称と略称の組で新規登録できる', () => {
  const db = emptyDb();
  const r = addAffiliation(db, '産業技術総合研究所', '産総研');
  assert.equal(r.created, true);
  assert.equal(db.masters.affiliations.length, 1);
  const a = findById(db.masters.affiliations, r.id);
  assert.equal(a.name, '産業技術総合研究所');
  assert.equal(a.shortName, '産総研');
});

test('所属: 同じ名称は重複登録されず、既存の ID を返す', () => {
  const db = emptyDb();
  const a = addAffiliation(db, '東京大学', '東京大');
  const b = addAffiliation(db, ' 東京大学 ', '');
  assert.equal(a.id, b.id);
  assert.equal(b.created, false);
  assert.equal(db.masters.affiliations.length, 1);
});

test('所属: 略称が空の既存項目には、後から略称を補完する', () => {
  const db = emptyDb();
  const a = addAffiliation(db, '琉球大学', '');
  const b = addAffiliation(db, '琉球大学', '琉大');
  assert.equal(a.id, b.id);
  assert.equal(b.updated, true);
  assert.equal(findById(db.masters.affiliations, a.id).shortName, '琉大');
});

test('所属: 略称が食い違うときは確認用に既存値を返し、指定時のみ更新する', () => {
  const db = emptyDb();
  const a = addAffiliation(db, '産業技術総合研究所', '産総研');
  const b = addAffiliation(db, '産業技術総合研究所', 'AIST');
  assert.equal(b.conflict, '産総研', '食い違いを通知');
  assert.equal(b.updated, false);
  assert.equal(findById(db.masters.affiliations, a.id).shortName, '産総研', '勝手に変わらない');

  const c = addAffiliation(db, '産業技術総合研究所', 'AIST', { updateShortName: true });
  assert.equal(c.updated, true);
  assert.equal(findById(db.masters.affiliations, a.id).shortName, 'AIST');
});

test('所属: 名称が空ならエラー', () => {
  assert.throws(() => addAffiliation(emptyDb(), '  ', '略'), /所属の名称を入力/);
});

test('所属: 表示ラベルと名称順の一覧', () => {
  const db = emptyDb();
  addAffiliation(db, '琉球大学', '琉大');
  addAffiliation(db, 'OIST', '');
  addAffiliation(db, '東京大学', '東京大');
  assert.equal(affiliationLabel(db.masters.affiliations[0]), '琉球大学（琉大）');
  assert.equal(affiliationLabel(db.masters.affiliations[1]), 'OIST', '略称が無ければ名称のみ');
  assert.equal(affiliationLabel(null), '');
  const names = sortedAffiliations(db).map((a) => a.name);
  assert.equal(names.length, 3);
  assert.deepEqual([...names].sort((x, y) => x.localeCompare(y, 'ja')), names, '名称順に並ぶ');
});

test('所属: 過去の所属を選んだ著者は略称付きで出力される', () => {
  const { db, ids } = sampleDb();
  // 新しい著者が「過去の所属」2件を選択したケース
  const a = emptyAchievement('conf_dom_poster');
  const newcomer = upsertMaster(db.masters.persons, { name: '新規太郎' }, 'name', 'per');
  Object.assign(a, {
    authors: [{ ...emptyAuthor(), personId: newcomer, affiliationIds: [ids.aist, ids.utokyo] }],
    title: 'テスト発表', year: '2026', month: '9', day: '1',
  });
  assert.equal(authorAffiliation(db, a.authors[0]), '産総研・東京大', '略称を選択順に連結');
  assert.equal(authorAffiliation(db, a.authors[0], false), '産業技術総合研究所・東京大学', '正式名称も取得可');
  assert.ok(formatItem(db, a, 'plain').startsWith('新規太郎（産総研・東京大）'));
});

test('所属: 略称を変更するとすべての業績の出力に反映される', () => {
  const { db, ids, conf } = sampleDb();
  findById(db.masters.affiliations, ids.aist).shortName = 'AIST';
  assert.ok(formatItem(db, conf, 'plain').includes('儀武滉大（東京大・AIST）'));
  assert.ok(formatItem(db, conf, 'plain').includes('井口亮（AIST）'));
});

test('所属: 略称が無い所属は正式名称で出力される', () => {
  const db = emptyDb();
  const id = addAffiliation(db, '沖縄科学技術大学院大学', '').id;
  const au = { ...emptyAuthor(), freeName: 'A', affiliationIds: [id] };
  assert.equal(authorAffiliation(db, au), '沖縄科学技術大学院大学');
});

test('旧形式の所属文字列（「・」区切り）をマスタへ移行する', () => {
  const db = emptyDb();
  const existing = addAffiliation(db, '東京大学', '東京大').id;
  const au = resolveLegacyAffiliations(db, { freeName: 'X', affiliationIds: [], freeAffiliation: '東京大学・産業技術総合研究所' });
  assert.equal(au.freeAffiliation, '');
  assert.equal(au.affiliationIds.length, 2);
  assert.equal(au.affiliationIds[0], existing, '既存の所属は再利用される');
  assert.equal(db.masters.affiliations.length, 2, '新しい所属だけが追加される');
  // 同じ所属が重複しても 1 件にまとまる
  const au2 = resolveLegacyAffiliations(db, { freeName: 'Y', affiliationIds: [existing], freeAffiliation: '東京大学' });
  assert.deepEqual(au2.affiliationIds, [existing]);
});

test('スキーマ v1 のデータを読み込むと所属がマスタ参照に変換される', () => {
  const v1 = {
    schemaVersion: 1,
    masters: { persons: [], affiliations: [], journals: [], conferences: [] },
    achievements: [{
      categoryId: 'conf_dom_oral', title: '旧発表', year: '2021',
      authors: [{ personId: '', freeName: '儀武滉大', affiliationIds: [], freeAffiliation: '琉球大学・東京大学' }],
    }],
  };
  const db = migrate(v1);
  assert.equal(db.schemaVersion, SCHEMA_VERSION);
  assert.equal(db.masters.affiliations.length, 2);
  const au = db.achievements[0].authors[0];
  assert.equal(au.affiliationIds.length, 2);
  assert.equal(au.freeAffiliation, '');
  assert.equal(authorAffiliation(db, au), '琉球大学・東京大学');
});

test('マージ読み込み: 共著者の既定の所属も新しい ID に置き換わる', () => {
  const current = emptyDb();
  addAffiliation(current, '別の大学', '');
  const incoming = emptyDb();
  const aff = addAffiliation(incoming, '琉球大学', '琉大').id;
  incoming.masters.persons.push({ id: 'p1', name: '山田花子', nameEn: '', affiliationIds: [aff] });

  const { db } = importJson(exportJson(incoming), 'merge', current);
  const p = db.masters.persons.find((x) => x.name === '山田花子');
  const a = findById(db.masters.affiliations, p.affiliationIds[0]);
  assert.ok(a, '参照先の所属が存在する');
  assert.equal(a.name, '琉球大学');
  assert.equal(a.shortName, '琉大');
});

test('所属は人物の既定所属として使われていると削除できない', () => {
  const db = emptyDb();
  const aff = addAffiliation(db, '琉球大学', '琉大').id;
  db.masters.persons.push({ id: 'p1', name: 'A', nameEn: '', affiliationIds: [aff] });
  assert.equal(countMasterUsage(db, 'affiliations', aff), 1);
  assert.equal(removeMaster(db, 'affiliations', aff).removed, false);
  db.masters.persons[0].affiliationIds = [];
  assert.equal(removeMaster(db, 'affiliations', aff).removed, true);
});

// ══════════════════════════════════════════
//  既存機能
// ══════════════════════════════════════════

test('区分の定義と入力形式の対応', () => {
  assert.ok(CATEGORIES.length >= 8);
  assert.equal(kindOf('journal_reviewed'), 'paper');
  assert.equal(kindOf('conf_dom_oral'), 'conference');
  assert.equal(kindOf('lecture'), 'other');
  assert.equal(kindOf('unknown'), 'other');
  assert.equal(CATEGORY_MAP.journal_unreviewed.reviewed, false);
});

test('マスタは名称一致で使い回され、略称は後から補完される', () => {
  const db = emptyDb();
  const a = upsertMaster(db.masters.journals, { name: 'PeerJ', abbr: '' }, 'name', 'jnl');
  const b = upsertMaster(db.masters.journals, { name: 'PeerJ', abbr: 'PeerJ' }, 'name', 'jnl');
  assert.equal(a, b);
  assert.equal(db.masters.journals.length, 1);
  assert.equal(db.masters.journals[0].abbr, 'PeerJ');
});

test('upsertMaster: 空の配列フィールドは補完され、既存の配列は保持される', () => {
  const db = emptyDb();
  upsertMaster(db.masters.persons, { name: 'A', affiliationIds: [] }, 'name', 'per');
  upsertMaster(db.masters.persons, { name: 'A', affiliationIds: ['x'] }, 'name', 'per');
  assert.deepEqual(db.masters.persons[0].affiliationIds, ['x']);
  upsertMaster(db.masters.persons, { name: 'A', affiliationIds: ['y'] }, 'name', 'per');
  assert.deepEqual(db.masters.persons[0].affiliationIds, ['x'], '既に値があれば上書きしない');
});

test('使用中のマスタは削除できず、未使用なら削除できる', () => {
  const { db, ids } = sampleDb();
  assert.equal(countMasterUsage(db, 'journals', ids.sr), 1);
  assert.equal(removeMaster(db, 'journals', ids.sr).removed, false);
  const unused = upsertMaster(db.masters.journals, { name: 'Unused', abbr: '' }, 'name', 'jnl');
  assert.equal(removeMaster(db, 'journals', unused).removed, true);
  assert.equal(findById(db.masters.journals, unused), null);
  assert.equal(countMasterUsage(db, 'persons', ids.me), 3);
});

test('自分の氏名判定と太字＋下線', () => {
  const { db, paper } = sampleDb();
  assert.equal(isSelf(db, '儀武 滉大'), true);
  assert.equal(isSelf(db, '井口亮'), false);
  const html = formatItem(db, paper, 'html');
  assert.ok(html.includes('<strong><u>儀武滉大</u></strong>'));
  assert.ok(!html.includes('<strong><u>井口亮</u></strong>'));
});

test('日付と巻号の整形', () => {
  assert.equal(formatDateJa({ year: '2025', month: '3', day: '15' }), '2025年3月15日');
  assert.equal(formatDateJa({ year: '2025', month: '3', day: '' }), '2025年3月');
  assert.equal(formatDateJa({ year: '', month: '3', day: '1' }), '');
  assert.equal(formatVolume({ volume: '14', issue: '1' }), '14(1)');
  assert.equal(formatVolume({ volume: '49', issue: '' }), '49');
});

test('論文・学会・講義の出力書式', () => {
  const { db, paper, conf, lec } = sampleDb();
  assert.equal(formatItem(db, paper, 'plain'),
    '儀武滉大・井口亮 (2024). Polyamine impact on physiology of early stages of reef-building corals. '
    + 'Scientific Reports, 14(1), 23465.');
  assert.equal(formatItem(db, conf, 'plain'),
    '儀武滉大（東京大・産総研）・井口亮（産総研）.「南西諸島における造礁サンゴの細菌叢解析」. '
    + '日本生態学会第72回全国大会. 2025年3月15日. 発表番号I01-01.');
  const t = formatItem(db, lec, 'plain');
  assert.ok(t.includes('儀武滉大（産総研）'));
  assert.ok(t.includes('オンラインセミナー'));
});

test('英語名のみの著者はカンマ区切り、DOI は URL で付与', () => {
  const db = emptyDb();
  const a = emptyAchievement('journal_reviewed');
  Object.assign(a, {
    authors: [{ ...emptyAuthor(), freeName: 'Gibu, K.' }, { ...emptyAuthor(), freeName: 'Iguchi, A.' }],
    title: 'Test paper', freeJournal: 'PeerJ', year: '2020', volume: '8', pages: 'e8449', doi: '10.7717/peerj.8449',
  });
  assert.equal(formatItem(db, a, 'plain'),
    'Gibu, K., Iguchi, A. (2020). Test paper. PeerJ, 8, e8449. https://doi.org/10.7717/peerj.8449');
});

test('ジャーナル・大会名はマスタ優先、未登録なら手入力値', () => {
  const { db, paper } = sampleDb();
  assert.equal(journalLabel(db, paper), 'Scientific Reports');
  assert.equal(journalLabel(db, paper, true), 'Sci Rep');
  assert.equal(conferenceLabel(db, { ...emptyAchievement('conf_dom_oral'), freeConference: '第1回大会' }), '第1回大会');
});

test('区分ごとのグループ化と日付順', () => {
  const { db } = sampleDb();
  const more = emptyAchievement('conf_dom_oral');
  Object.assign(more, { title: '古い発表', year: '2021', month: '5', day: '29' });
  db.achievements.push(more);
  const asc = groupByCategory(db.achievements, 'asc');
  assert.equal(asc[0].category.id, 'journal_reviewed');
  assert.equal(asc.find((x) => x.category.id === 'conf_dom_oral').items[0].title, '古い発表');
  assert.ok(dateKey({ year: '2025', month: '3', day: '15' }) > dateKey({ year: '2024', month: '12', day: '31' }));
});

test('業績リスト（Markdown / HTML）と区分の絞り込み', () => {
  const { db } = sampleDb();
  const md = buildList(db, 'markdown', { title: '業績目録（テスト）' });
  assert.ok(md.startsWith('# 業績目録（テスト）'));
  assert.ok(md.includes('## 国内学会等における発表［口頭発表］'));
  const html = buildList(db, 'html');
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('#b5b5ac'));
  const only = buildList(db, 'markdown', { categoryIds: ['journal_reviewed'] });
  assert.ok(!only.includes('国内学会等における発表'));
});

test('CSV 出力（所属は正式名称）', () => {
  const { db } = sampleDb();
  const lines = buildCsv(db).trim().split('\r\n');
  assert.equal(lines[0], CSV_HEADER.join(','));
  assert.equal(lines.length, 4);
  assert.ok(lines.some((l) => l.includes('東京大学; 産業技術総合研究所')));
});

test('JSON の置き換え・マージ読み込み', () => {
  const { db } = sampleDb();
  const { db: restored } = importJson(exportJson(db), 'replace');
  assert.equal(buildList(restored, 'plain', { title: 'x' }), buildList(db, 'plain', { title: 'x' }));
  const { db: b } = sampleDb();
  const { db: merged, added } = importJson(exportJson(b), 'merge', db);
  assert.equal(added, 0);
  assert.equal(merged.masters.affiliations.length, 2, '所属が重複登録されない');
  assert.throws(() => importJson('これはJSONではない'), /JSON として読み取れません/);
});

test('重複判定・集計・ファイル名', () => {
  const a = emptyAchievement('journal_reviewed');
  Object.assign(a, { title: 'T', year: '2024' });
  assert.equal(signature(a), signature({ ...a, id: 'x' }));
  const { db } = sampleDb();
  const s = summarize(db);
  assert.equal(s.total, 3);
  assert.equal(s.affiliations, 2);
  const d = new Date(2026, 8, 25);
  assert.equal(fileName('html', d), '業績目録_20260925.html');
  assert.equal(backupFileName(d), 'achievements_backup_20260925.json');
  assert.equal(defaultTitle(d), '業績目録（2026年9月25日現在）');
});

test('formatAuthors: 所属は略称を優先し「・」で連結', () => {
  const { db, conf } = sampleDb();
  assert.ok(formatAuthors(db, conf).text.startsWith('儀武滉大（東京大・産総研）'));
});

// ══ DOI / CrossRef ══
test('DOI の正規化と URL 化', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1038/s41598-024-74596-x'), '10.1038/s41598-024-74596-x');
  assert.equal(normalizeDoi('doi:10.1007/s11033-022-07743-0'), '10.1007/s11033-022-07743-0');
  assert.throws(() => normalizeDoi(''), /DOI を入力してください/);
  assert.throws(() => normalizeDoi('not-a-doi'), /DOI の形式ではありません/);
  assert.equal(doiUrl('10.1234/abc'), 'https://doi.org/10.1234/abc');
});

const CROSSREF_SAMPLE = {
  DOI: '10.1038/s41598-024-74596-x',
  title: ['Polyamine impact on physiology of early stages of reef-building corals'],
  'container-title': ['Scientific Reports'],
  'short-container-title': ['Sci Rep'],
  volume: '14', issue: '1', page: '23465',
  'published-print': { 'date-parts': [[2024, 10, 8]] },
  author: [
    { given: 'Kodai', family: 'Gibu', affiliation: [{ name: 'AIST' }] },
    { given: 'Akira', family: 'Iguchi', affiliation: [] },
  ],
};

test('CrossRef 応答の変換', () => {
  const m = mapCrossrefMessage(CROSSREF_SAMPLE);
  assert.equal(m.journal, 'Scientific Reports');
  assert.equal(m.journalAbbr, 'Sci Rep');
  assert.deepEqual([m.year, m.month, m.day], ['2024', '10', '8']);
  assert.equal(m.authors[0].name, 'Gibu, Kodai');
  assert.equal(m.authors[0].affiliation, 'AIST');
  const n = mapCrossrefMessage({ title: ['T'], 'article-number': 'e8449', issued: { 'date-parts': [[2020, 1]] } });
  assert.equal(n.pages, 'e8449');
  assert.equal(n.day, '');
});

test('CrossRef の所属は所属マスタに記憶できる', () => {
  const db = emptyDb();
  const m = mapCrossrefMessage(CROSSREF_SAMPLE);
  const r = addAffiliation(db, m.authors[0].affiliation, '');
  assert.equal(r.created, true);
  assert.equal(findById(db.masters.affiliations, r.id).name, 'AIST');
});

test('fetchByDoi: 正常応答・異常系・mailto', async () => {
  let url = '';
  const ok = async (u) => { url = u; return { ok: true, status: 200, json: async () => ({ status: 'ok', message: CROSSREF_SAMPLE }) }; };
  const m = await fetchByDoi('10.1038/s41598-024-74596-x', { fetchImpl: ok, mailto: 'a@b.jp' });
  assert.equal(m.journal, 'Scientific Reports');
  assert.ok(url.startsWith('https://api.crossref.org/works/'));
  assert.ok(url.includes('mailto=a%40b.jp'));
  await assert.rejects(() => fetchByDoi('10.1234/x', { fetchImpl: async () => ({ ok: false, status: 404 }) }),
    /CrossRef に登録されていません/);
  await assert.rejects(() => fetchByDoi('10.1234/x', { fetchImpl: async () => ({ ok: false, status: 500 }) }), /HTTP 500/);
  await assert.rejects(() => fetchByDoi('10.1234/x', { fetchImpl: async () => { throw new Error('x'); } }),
    /接続できませんでした/);
  await assert.rejects(() => fetchByDoi('10.1234/x', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'error' }) }),
  }), /書誌情報が含まれていません/);
});

// ══ BibTeX / RIS ══
test('BibTeX: 種別・ASCII 引用キー・重複回避', () => {
  assert.equal(bibEntryType('journal_reviewed'), 'article');
  assert.equal(bibEntryType('conf_dom_oral'), 'inproceedings');
  assert.equal(bibEntryType('lecture'), 'misc');
  const { db, paper } = sampleDb();
  const used = new Set();
  assert.equal(citationKey(db, paper, used), 'Gibu2024Polyamine');
  assert.equal(citationKey(db, paper, used), 'Gibu2024Polyamineb');
});

test('BibTeX: エントリ内容と特殊文字', () => {
  const { db, paper, conf } = sampleDb();
  const bib = toBibtex(db, { ...paper, doi: '10.1038/s41598-024-74596-x' }, new Set());
  assert.ok(bib.includes('journal = {Scientific Reports}'));
  assert.ok(bib.includes('shortjournal = {Sci Rep}'));
  assert.ok(bib.includes('url = {https://doi.org/10.1038'));
  assert.ok(toBibtex(db, conf, new Set()).includes('booktitle = {日本生態学会第72回全国大会}'));
  const x = emptyAchievement('journal_reviewed');
  Object.assign(x, { title: 'A & B: 50% of #1', year: '2024' });
  const s = toBibtex(emptyDb(), x, new Set());
  assert.ok(s.includes('\\&') && s.includes('\\%') && s.includes('\\#'));
  assert.equal((buildBibtex(db).match(/^@/gm) ?? []).length, 3);
});

test('RIS: 種別・ページ分割・学会', () => {
  assert.equal(risType('journal_reviewed'), 'JOUR');
  assert.equal(risType('conf_intl_poster'), 'CPAPER');
  const { db, paper, conf } = sampleDb();
  const r = toRis(db, { ...paper, pages: '60-65' });
  assert.ok(r.includes('SP  - 60') && r.includes('EP  - 65'));
  assert.ok(r.includes('J2  - Sci Rep'));
  const c = toRis(db, conf);
  assert.ok(c.includes('T2  - 日本生態学会第72回全国大会'));
  assert.ok(c.includes('DA  - 2025/3/15//'));
  assert.equal((buildRis(db).match(/^ER {2}- ?$/gm) ?? []).length, 3);
});

// ══ 科研費 ══
test('科研費様式: 区分振り分けとフラグ', () => {
  assert.equal(KAKENHI_SECTIONS.length, 3);
  assert.equal(kakenhiFlags({ categoryId: 'journal_reviewed', reviewed: true }).reviewed, '有');
  assert.equal(kakenhiFlags({ categoryId: 'conf_intl_poster' }).international, '該当する');
  assert.equal(kakenhiFlags({ categoryId: 'symposium' }).invited, '該当する');
  const { db } = sampleDb();
  const t = buildKakenhi(db, { title: '研究発表' });
  assert.ok(t.includes('〔雑誌論文〕　計1件'));
  assert.ok(t.includes('儀武滉大、井口亮'));
  assert.ok(t.includes('国際学会：該当しない／招待講演：該当しない'));
  assert.ok(!buildKakenhi(db, { categoryIds: ['journal_reviewed'] }).includes('〔学会発表〕'));
});

// ══ 年度別集計 ══
test('年度の判定と年度／暦年の集計', () => {
  assert.equal(fiscalYear({ year: '2025', month: '3' }), 2024);
  assert.equal(fiscalYear({ year: '2025', month: '4' }), 2025);
  assert.equal(fiscalYear({ year: '2024', month: '' }), 2024);
  assert.equal(fiscalYear({ year: '' }), null);
  const { db } = sampleDb();
  const fis = summarizeByYear(db, 'fiscal');
  assert.equal(fis.rows.length, 1);
  assert.equal(fis.rows[0].total, 3);
  const cal = summarizeByYear(db, 'calendar');
  assert.deepEqual(cal.rows.map((r) => r.year), [2024, 2025]);
});

test('年度別集計 CSV とバー・ファイル名', () => {
  const { db } = sampleDb();
  const lines = buildYearlyCsv(db, 'calendar').trim().split('\r\n');
  assert.ok(lines[0].startsWith('年,'));
  assert.ok(lines[lines.length - 1].startsWith('合計,'));
  assert.equal(yearlyBar(0, 10).length, 0);
  assert.ok(yearlyBar(10, 10).length > yearlyBar(2, 10).length);
  const d = new Date(2026, 8, 25);
  assert.equal(exportFileName('bibtex', d), '業績目録_20260925.bib');
  assert.equal(exportFileName('kakenhi', d), '科研費様式_研究発表_20260925.txt');
});
