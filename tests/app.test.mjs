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
  findAffiliationByEnglish, findPersonByEnglish, splitEnglishName, personLabel,
  groupByCategory, dateKey, summarize, exportJson, importJson, migrate, signature, SCHEMA_VERSION,
} from '../src/model.js';
import {
  formatAuthors, formatItem, formatDateJa, formatDateEn, formatVolume, isSelf, isSelfAuthor,
  buildList, buildCsv, journalLabel, conferenceLabel, defaultTitle, resolveLang,
  fileName, backupFileName, authorName, authorAffiliation, affiliationText, hasEnglishName, CSV_HEADER,
} from '../src/format.js';
import { normalizeDoi, doiUrl, mapCrossrefMessage, fetchByDoi } from '../src/crossref.js';
import {
  citationKey, bibEntryType, toBibtex, buildBibtex, risType, toRis, buildRis,
  buildKakenhi, kakenhiFlags, KAKENHI_SECTIONS,
  fiscalYear, summarizeByYear, buildYearlyCsv, yearlyBar, exportFileName,
} from '../src/export-formats.js';

const AIST = { shortName: '産総研', nameEn: 'National Institute of Advanced Industrial Science and Technology', shortNameEn: 'AIST' };
const UTOKYO = { shortName: '東京大', nameEn: 'The University of Tokyo', shortNameEn: 'UTokyo' };

/** テスト用のサンプル DB */
function sampleDb() {
  const db = emptyDb();
  const aist = addAffiliation(db, '産業技術総合研究所', AIST).id;
  const utokyo = addAffiliation(db, '東京大学', UTOKYO).id;
  const me = upsertMaster(db.masters.persons, { name: '儀武滉大', nameEn: 'Gibu, K.', affiliationIds: [aist] }, 'name', 'per');
  const ig = upsertMaster(db.masters.persons, { name: '井口亮', nameEn: 'Iguchi, A.', affiliationIds: [aist] }, 'name', 'per');
  const sr = upsertMaster(db.masters.journals, { name: 'Scientific Reports', abbr: 'Sci Rep' }, 'name', 'jnl');
  const cf = upsertMaster(db.masters.conferences, { name: '日本生態学会第72回全国大会' }, 'name', 'cnf');
  const ic = upsertMaster(db.masters.conferences, { name: '1st Asia-Pacific Biodiversity Joint Conference' }, 'name', 'cnf');

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
  const intl = emptyAchievement('conf_intl_oral');
  Object.assign(intl, {
    authors: conf.authors.map((a) => ({ ...a })),
    title: 'Microbiome Analysis of Reef-Building Corals',
    conferenceId: ic, year: '2024', month: '10', day: '23', presentationNumber: '23-VI-4',
  });
  const lec = emptyAchievement('lecture');
  Object.assign(lec, {
    authors: [{ ...emptyAuthor(), personId: me, affiliationIds: [aist] }],
    title: '沖縄県委託事業 令和6年度「健康・医療データサイエンス人材育成事業」',
    year: '2024', month: '10', day: '19', venue: 'オンラインセミナー',
    note: 'バイオインフォマティクス分野の2時間講義を3回担当．',
  });
  db.achievements.push(paper, conf, intl, lec);
  return { db, ids: { aist, utokyo, me, ig, sr, cf, ic }, paper, conf, intl, lec };
}

// ══════════════════════════════════════════
//  英名（著者・所属）
// ══════════════════════════════════════════

test('所属: 和文名称・略称と英語名称・英語略称を一緒に登録できる', () => {
  const db = emptyDb();
  const r = addAffiliation(db, '産業技術総合研究所', AIST);
  assert.equal(r.created, true);
  const a = findById(db.masters.affiliations, r.id);
  assert.deepEqual([a.name, a.shortName, a.nameEn, a.shortNameEn],
    ['産業技術総合研究所', '産総研', AIST.nameEn, 'AIST']);
});

test('所属: 英語名称が空の既存項目には後から補完し、食い違いは確認対象にする', () => {
  const db = emptyDb();
  const id = addAffiliation(db, '琉球大学', { shortName: '琉大' }).id;
  const r1 = addAffiliation(db, '琉球大学', { nameEn: 'University of the Ryukyus', shortNameEn: 'U-Ryukyu' });
  assert.equal(r1.id, id);
  assert.equal(r1.updated, true);
  assert.equal(findById(db.masters.affiliations, id).nameEn, 'University of the Ryukyus');

  const r2 = addAffiliation(db, '琉球大学', { shortNameEn: 'UR' });
  assert.equal(r2.conflicts.length, 1);
  assert.equal(r2.conflicts[0].label, '英語略称');
  assert.equal(r2.conflicts[0].current, 'U-Ryukyu');
  assert.equal(findById(db.masters.affiliations, id).shortNameEn, 'U-Ryukyu', '勝手に変わらない');
  addAffiliation(db, '琉球大学', { shortNameEn: 'UR' }, { updateExisting: true });
  assert.equal(findById(db.masters.affiliations, id).shortNameEn, 'UR');
});

test('所属: 旧形式の呼び出し addAffiliation(db, 名称, 略称) も使える', () => {
  const db = emptyDb();
  const r = addAffiliation(db, '東京大学', '東京大');
  assert.equal(findById(db.masters.affiliations, r.id).shortName, '東京大');
  assert.equal(addAffiliation(db, '東京大学', '東大').conflicts[0].label, '略称');
});

test('所属: 英語名称だけでも登録でき、英語名・英語略称から検索できる', () => {
  const db = emptyDb();
  const r = addAffiliation(db, '', { nameEn: 'Okinawa Institute of Science and Technology', shortNameEn: 'OIST' });
  assert.equal(findById(db.masters.affiliations, r.id).name, 'Okinawa Institute of Science and Technology');
  assert.equal(findAffiliationByEnglish(db, 'oist')?.id, r.id, '大文字小文字を無視');
  assert.equal(findAffiliationByEnglish(db, 'Okinawa  Institute of Science and Technology')?.id, r.id);
  // 英語名称が一致すれば、和文名称を伴う登録でも同じ所属になる
  const r2 = addAffiliation(db, '沖縄科学技術大学院大学', { nameEn: 'Okinawa Institute of Science and Technology' });
  assert.equal(r2.id, r.id);
  assert.throws(() => addAffiliation(db, '', {}), /所属の名称を入力/);
});

test('所属: 表示ラベルに和文と英文が並ぶ', () => {
  const db = emptyDb();
  const id = addAffiliation(db, '産業技術総合研究所', AIST).id;
  assert.equal(affiliationLabel(findById(db.masters.affiliations, id)),
    `産業技術総合研究所（産総研） / ${AIST.nameEn} (AIST)`);
  const j = addAffiliation(db, '琉球大学', '琉大').id;
  assert.equal(affiliationLabel(findById(db.masters.affiliations, j)), '琉球大学（琉大）');
});

test('所属の表記: 英語は英語略称→英語名称→和文の順', () => {
  const aff = { name: '産業技術総合研究所', shortName: '産総研', nameEn: 'AIST Full', shortNameEn: 'AIST' };
  assert.equal(affiliationText(aff, 'en', true), 'AIST');
  assert.equal(affiliationText(aff, 'en', false), 'AIST Full');
  assert.equal(affiliationText({ ...aff, shortNameEn: '' }, 'en', true), 'AIST Full');
  assert.equal(affiliationText({ name: '琉球大学', shortName: '琉大' }, 'en', true), '琉大', '英名が無ければ和文');
  assert.equal(affiliationText(aff, 'ja', true), '産総研');
});

test('英語名の分解と人物の照合（Gibu, Kodai / Gibu, K. / Kodai Gibu）', () => {
  assert.deepEqual(splitEnglishName('Gibu, Kodai'), { family: 'Gibu', given: 'Kodai' });
  assert.deepEqual(splitEnglishName('Kodai Gibu'), { family: 'Gibu', given: 'Kodai' });
  const { db, ids } = sampleDb();
  assert.equal(findPersonByEnglish(db, 'Gibu, Kodai')?.id, ids.me);
  assert.equal(findPersonByEnglish(db, 'Kodai Gibu')?.id, ids.me);
  assert.equal(findPersonByEnglish(db, 'GIBU, K.')?.id, ids.me);
  assert.equal(findPersonByEnglish(db, 'Gibu, Taro'), null, '名の頭文字が違えば別人');
  assert.equal(findPersonByEnglish(db, ''), null);
  assert.equal(personLabel(findById(db.masters.persons, ids.me)), '儀武滉大 / Gibu, K.');
});

test('著者名: 英語表記ならマスタの英名、未登録なら和文にフォールバック', () => {
  const { db, ids } = sampleDb();
  const au = { ...emptyAuthor(), personId: ids.me };
  assert.equal(authorName(db, au, 'ja'), '儀武滉大');
  assert.equal(authorName(db, au, 'en'), 'Gibu, K.');
  assert.equal(hasEnglishName(db, au), true);
  const noEn = upsertMaster(db.masters.persons, { name: '山田花子', nameEn: '' }, 'name', 'per');
  assert.equal(authorName(db, { ...emptyAuthor(), personId: noEn }, 'en'), '山田花子');
  assert.equal(authorName(db, { ...emptyAuthor(), freeName: '未登録', freeNameEn: 'Mitouroku, A.' }, 'en'), 'Mitouroku, A.');
});

// ══ 表記言語 ══
test('表記言語の自動判定', () => {
  const { db, paper, conf, intl, lec } = sampleDb();
  assert.equal(resolveLang(db, intl), 'en', '国際学会は英語');
  assert.equal(resolveLang(db, paper), 'en', '英文タイトル・英文誌は英語');
  assert.equal(resolveLang(db, conf), 'ja', '国内学会の日本語タイトルは日本語');
  assert.equal(resolveLang(db, lec), 'ja');
  const jaPaper = { ...paper, title: '造礁サンゴの研究', freeJournal: '日本サンゴ礁学会誌', journalId: '' };
  assert.equal(resolveLang(db, jaPaper), 'ja', '和文誌は日本語');
});

test('表記言語の手動指定が自動判定より優先される', () => {
  const { db, conf, intl } = sampleDb();
  assert.equal(resolveLang(db, { ...conf, lang: 'en' }), 'en');
  assert.equal(resolveLang(db, { ...intl, lang: 'ja' }), 'ja');
});

test('国際学会は著者・所属が英名で出力される', () => {
  const { db, intl } = sampleDb();
  assert.equal(formatItem(db, intl, 'plain'),
    'Gibu, K. (UTokyo, AIST), Iguchi, A. (AIST). "Microbiome Analysis of Reef-Building Corals". '
    + '1st Asia-Pacific Biodiversity Joint Conference. 23 October 2024. No. 23-VI-4.');
  assert.ok(formatItem(db, intl, 'html').startsWith('<strong><u>Gibu, K. (UTokyo, AIST)</u></strong>'),
    '英名でも自分が強調される');
});

test('英文誌の論文は著者が英名で出力される', () => {
  const { db, paper } = sampleDb();
  assert.equal(formatItem(db, paper, 'plain'),
    'Gibu, K., Iguchi, A. (2024). Polyamine impact on physiology of early stages of reef-building corals. '
    + 'Scientific Reports, 14(1), 23465.');
});

test('国内学会は従来どおり和文で出力される', () => {
  const { db, conf } = sampleDb();
  assert.equal(formatItem(db, conf, 'plain'),
    '儀武滉大（東京大・産総研）・井口亮（産総研）.「南西諸島における造礁サンゴの細菌叢解析」. '
    + '日本生態学会第72回全国大会. 2025年3月15日. 発表番号I01-01.');
});

test('同じ業績を日本語表記に切り替えると和文で出力される', () => {
  const { db, paper } = sampleDb();
  assert.ok(formatItem(db, { ...paper, lang: 'ja' }, 'plain').startsWith('儀武滉大・井口亮 (2024).'));
});

test('英語表記で英名が未登録の著者・所属は和文で出力される', () => {
  const { db, intl } = sampleDb();
  const yamada = upsertMaster(db.masters.persons, { name: '山田花子' }, 'name', 'per');
  const ryu = addAffiliation(db, '琉球大学', '琉大').id;
  const a = { ...intl, authors: [...intl.authors, { ...emptyAuthor(), personId: yamada, affiliationIds: [ryu] }] };
  assert.ok(formatItem(db, a, 'plain').includes('Iguchi, A. (AIST), 山田花子 (琉大).'));
});

test('自分の判定: 和文・英文どちらの表記でも自分とみなす', () => {
  const { db, ids } = sampleDb();
  assert.equal(isSelf(db, '儀武 滉大'), true);
  assert.equal(isSelf(db, 'Gibu, K.'), true);
  assert.equal(isSelfAuthor(db, { ...emptyAuthor(), personId: ids.me }), true);
  assert.equal(isSelfAuthor(db, { ...emptyAuthor(), personId: ids.ig }), false);
});

test('英語の日付表記', () => {
  assert.equal(formatDateEn({ year: '2024', month: '10', day: '23' }), '23 October 2024');
  assert.equal(formatDateEn({ year: '2024', month: '3', day: '' }), 'March 2024');
  assert.equal(formatDateEn({ year: '2024', month: '', day: '' }), '2024');
  assert.equal(formatDateEn({ year: '', month: '3', day: '1' }), '');
});

test('スキーマ v2 のデータを読み込むと英名の項目と表記言語が補われる', () => {
  const v2 = {
    schemaVersion: 2,
    masters: { persons: [], affiliations: [{ id: 'a1', name: '琉球大学', shortName: '琉大' }], journals: [], conferences: [] },
    achievements: [{ categoryId: 'conf_dom_oral', title: '旧発表', year: '2021', authors: [{ freeName: 'X', affiliationIds: ['a1'] }] }],
  };
  const db = migrate(v2);
  assert.equal(db.schemaVersion, SCHEMA_VERSION);
  assert.equal(db.masters.affiliations[0].nameEn, '');
  assert.equal(db.masters.affiliations[0].shortNameEn, '');
  assert.equal(db.achievements[0].lang, 'auto');
  assert.equal(db.achievements[0].authors[0].freeNameEn, '');
});

test('スキーマ v1 の「A・B」形式の所属文字列もマスタへ移行される', () => {
  const v1 = {
    schemaVersion: 1,
    achievements: [{ categoryId: 'conf_dom_oral', title: '旧', year: '2021',
      authors: [{ freeName: '儀武滉大', freeAffiliation: '琉球大学・東京大学' }] }],
  };
  const db = migrate(v1);
  assert.equal(db.masters.affiliations.length, 2);
  assert.equal(authorAffiliation(db, db.achievements[0].authors[0]), '琉球大学・東京大学');
  const au = resolveLegacyAffiliations(db, { freeName: 'Y', affiliationIds: [], freeAffiliation: '東京大学' });
  assert.equal(au.affiliationIds.length, 1);
});

test('マージ読み込みで英名が引き継がれる', () => {
  const current = emptyDb();
  addAffiliation(current, '産業技術総合研究所', '産総研');
  const incoming = emptyDb();
  addAffiliation(incoming, '産業技術総合研究所', AIST);
  incoming.masters.persons.push({ id: 'p1', name: '儀武滉大', nameEn: 'Gibu, K.', affiliationIds: [] });
  const { db } = importJson(exportJson(incoming), 'merge', current);
  assert.equal(db.masters.affiliations.length, 1);
  assert.equal(db.masters.affiliations[0].shortNameEn, 'AIST', '空欄の英語略称が補われる');
  assert.equal(db.masters.persons[0].nameEn, 'Gibu, K.');
});

test('CSV に和文・英文の著者と所属、表記言語が入る', () => {
  const { db } = sampleDb();
  const lines = buildCsv(db).trim().split('\r\n');
  assert.equal(lines[0], CSV_HEADER.join(','));
  const intlLine = lines.find((l) => l.includes('Microbiome'));
  assert.ok(intlLine.includes(',英語,'));
  assert.ok(intlLine.includes('儀武滉大; 井口亮'));
  assert.ok(intlLine.includes('"Gibu, K.; Iguchi, A."'));
  assert.ok(intlLine.includes('東京大学; 産業技術総合研究所'));
  assert.ok(intlLine.includes(`The University of Tokyo; ${AIST.nameEn}`));
});

test('BibTeX・RIS・科研費様式も表記言語に従う', () => {
  const { db, intl, conf } = sampleDb();
  assert.ok(toBibtex(db, intl, new Set()).includes('author = {Gibu, K. and Iguchi, A.}'));
  assert.ok(toBibtex(db, conf, new Set()).includes('author = {儀武滉大 and 井口亮}'));
  assert.ok(toRis(db, intl).includes('AU  - Gibu, K.'));
  const k = buildKakenhi(db);
  assert.ok(k.includes('Gibu, K., Iguchi, A.'));
  assert.ok(k.includes('儀武滉大、井口亮'));
  assert.ok(k.includes('23 October 2024'));
});

test('集計に英名の登録状況が入る', () => {
  const { db } = sampleDb();
  upsertMaster(db.masters.persons, { name: '山田花子' }, 'name', 'per');
  const s = summarize(db);
  assert.equal(s.persons, 3);
  assert.equal(s.personsWithEn, 2);
  assert.equal(s.affiliationsWithEn, 2);
});

// ══════════════════════════════════════════
//  既存機能
// ══════════════════════════════════════════

test('区分の定義と入力形式', () => {
  assert.ok(CATEGORIES.length >= 8);
  assert.equal(kindOf('journal_reviewed'), 'paper');
  assert.equal(kindOf('conf_intl_oral'), 'conference');
  assert.equal(kindOf('lecture'), 'other');
  assert.equal(CATEGORY_MAP.conf_intl_poster.scope, 'international');
});

test('マスタの重複防止と補完・使用件数・削除防止', () => {
  const db = emptyDb();
  const a = upsertMaster(db.masters.journals, { name: 'PeerJ', abbr: '' }, 'name', 'jnl');
  assert.equal(upsertMaster(db.masters.journals, { name: 'PeerJ', abbr: 'PeerJ' }, 'name', 'jnl'), a);
  assert.equal(db.masters.journals[0].abbr, 'PeerJ');
  const s = sampleDb();
  assert.equal(countMasterUsage(s.db, 'journals', s.ids.sr), 1);
  assert.equal(removeMaster(s.db, 'journals', s.ids.sr).removed, false);
  assert.ok(countMasterUsage(s.db, 'affiliations', s.ids.aist) >= 3);
  assert.equal(removeMaster(s.db, 'affiliations', s.ids.aist).removed, false);
});

test('所属の名称順一覧', () => {
  const { db } = sampleDb();
  const names = sortedAffiliations(db).map((a) => a.name);
  assert.deepEqual([...names].sort((x, y) => x.localeCompare(y, 'ja')), names);
});

test('日付・巻号・ジャーナル名', () => {
  assert.equal(formatDateJa({ year: '2025', month: '3', day: '15' }), '2025年3月15日');
  assert.equal(formatVolume({ volume: '14', issue: '1' }), '14(1)');
  const { db, paper } = sampleDb();
  assert.equal(journalLabel(db, paper, true), 'Sci Rep');
  assert.equal(conferenceLabel(db, { ...emptyAchievement('conf_dom_oral'), freeConference: 'X' }), 'X');
});

test('講義の出力に会場と備考が入る', () => {
  const { db, lec } = sampleDb();
  const t = formatItem(db, lec, 'plain');
  assert.ok(t.includes('儀武滉大（産総研）'));
  assert.ok(t.includes('オンラインセミナー'));
});

test('グループ化・並び順・リスト出力', () => {
  const { db } = sampleDb();
  const g = groupByCategory(db.achievements, 'asc');
  assert.equal(g[0].category.id, 'journal_reviewed');
  assert.ok(dateKey({ year: '2025', month: '3' }) > dateKey({ year: '2024', month: '12' }));
  const md = buildList(db, 'markdown', { title: 'T' });
  assert.ok(md.includes('## 国際学会における発表［口頭発表］'));
  assert.ok(md.includes('**<u>Gibu, K. (UTokyo, AIST)</u>**'));
  assert.ok(buildList(db, 'html').includes('#b5b5ac'));
  assert.ok(!buildList(db, 'markdown', { categoryIds: ['lecture'] }).includes('Microbiome'));
});

test('JSON の置き換え・重複除外・不正データ', () => {
  const { db } = sampleDb();
  const { db: r } = importJson(exportJson(db), 'replace');
  assert.equal(buildList(r, 'plain', { title: 'x' }), buildList(db, 'plain', { title: 'x' }));
  const { added } = importJson(exportJson(sampleDb().db), 'merge', db);
  assert.equal(added, 0);
  assert.throws(() => importJson('これはJSONではない'), /JSON として読み取れません/);
  assert.equal(signature({ ...db.achievements[0], id: 'x' }), signature(db.achievements[0]));
});

test('ファイル名と表題', () => {
  const d = new Date(2026, 8, 25);
  assert.equal(fileName('html', d), '業績目録_20260925.html');
  assert.equal(backupFileName(d), 'achievements_backup_20260925.json');
  assert.equal(defaultTitle(d), '業績目録（2026年9月25日現在）');
});

test('formatAuthors: 言語ごとの区切りと括弧', () => {
  const { db, conf } = sampleDb();
  assert.ok(formatAuthors(db, conf, { lang: 'ja' }).text.startsWith('儀武滉大（東京大・産総研）・'));
  assert.ok(formatAuthors(db, conf, { lang: 'en' }).text.startsWith('Gibu, K. (UTokyo, AIST), '));
});

// ══ DOI / CrossRef ══
test('DOI の正規化', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1038/s41598-024-74596-x'), '10.1038/s41598-024-74596-x');
  assert.equal(normalizeDoi('doi:10.1007/s11033-022-07743-0'), '10.1007/s11033-022-07743-0');
  assert.throws(() => normalizeDoi('not-a-doi'), /DOI の形式ではありません/);
  assert.equal(doiUrl('10.1234/abc'), 'https://doi.org/10.1234/abc');
});

const CROSSREF_SAMPLE = {
  DOI: '10.1038/s41598-024-74596-x',
  title: ['Polyamine impact'], 'container-title': ['Scientific Reports'], 'short-container-title': ['Sci Rep'],
  volume: '14', issue: '1', page: '23465',
  'published-print': { 'date-parts': [[2024, 10, 8]] },
  author: [
    { given: 'Kodai', family: 'Gibu', affiliation: [{ name: 'AIST' }] },
    { given: 'Taro', family: 'Newcomer', affiliation: [] },
  ],
};

test('CrossRef の英語著者名・所属を登録済みのマスタに紐づけられる', () => {
  const { db, ids } = sampleDb();
  const m = mapCrossrefMessage(CROSSREF_SAMPLE);
  assert.equal(findPersonByEnglish(db, m.authors[0].name)?.id, ids.me, '"Gibu, Kodai" → 儀武滉大');
  assert.equal(findPersonByEnglish(db, m.authors[1].name), null, '未登録の著者');
  assert.equal(findAffiliationByEnglish(db, m.authors[0].affiliation)?.id, ids.aist, '"AIST" → 産業技術総合研究所');
  const n = mapCrossrefMessage({ title: ['T'], 'article-number': 'e8449', issued: { 'date-parts': [[2020, 1]] } });
  assert.equal(n.pages, 'e8449');
});

test('fetchByDoi: 正常・異常系', async () => {
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', message: CROSSREF_SAMPLE }) });
  assert.equal((await fetchByDoi('10.1038/x', { fetchImpl: ok })).journal, 'Scientific Reports');
  await assert.rejects(() => fetchByDoi('10.1234/x', { fetchImpl: async () => ({ ok: false, status: 404 }) }), /登録されていません/);
  await assert.rejects(() => fetchByDoi('10.1234/x', { fetchImpl: async () => { throw new Error(); } }), /接続できませんでした/);
});

// ══ BibTeX / RIS / 科研費 / 年度別 ══
test('BibTeX: 英名を使った ASCII 引用キー', () => {
  assert.equal(bibEntryType('conf_dom_oral'), 'inproceedings');
  const { db, paper, conf } = sampleDb();
  const used = new Set();
  assert.equal(citationKey(db, paper, used), 'Gibu2024Polyamine');
  assert.equal(citationKey(db, paper, used), 'Gibu2024Polyamineb');
  assert.equal(citationKey(db, conf, new Set()), 'Gibu2025', '和文の業績でも英名からキーを作る');
  assert.equal((buildBibtex(db).match(/^@/gm) ?? []).length, 4);
});

test('RIS: 種別とページ分割', () => {
  assert.equal(risType('journal_reviewed'), 'JOUR');
  const { db, paper } = sampleDb();
  const r = toRis(db, { ...paper, pages: '60-65' });
  assert.ok(r.includes('SP  - 60') && r.includes('EP  - 65'));
  assert.equal((buildRis(db).match(/^ER {2}- ?$/gm) ?? []).length, 4);
});

test('科研費様式の区分とフラグ', () => {
  assert.equal(KAKENHI_SECTIONS.length, 3);
  assert.equal(kakenhiFlags({ categoryId: 'conf_intl_poster' }).international, '該当する');
  assert.equal(kakenhiFlags({ categoryId: 'journal_unreviewed', reviewed: false }).reviewed, '無');
});

test('年度別集計', () => {
  assert.equal(fiscalYear({ year: '2025', month: '3' }), 2024);
  assert.equal(fiscalYear({ year: '2025', month: '4' }), 2025);
  const { db } = sampleDb();
  assert.equal(summarizeByYear(db, 'fiscal').rows[0].total, 4);
  assert.deepEqual(summarizeByYear(db, 'calendar').rows.map((r) => r.year), [2024, 2025]);
  assert.ok(buildYearlyCsv(db, 'calendar').includes('合計'));
  assert.ok(yearlyBar(10, 10).length > yearlyBar(2, 10).length);
  assert.equal(exportFileName('ris', new Date(2026, 8, 25)), '業績目録_20260925.ris');
});
