/**
 * 業績管理アプリ — ロジック検証
 * 実行: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, kindOf, emptyDb, emptyAchievement, emptyAuthor,
  upsertMaster, findById, removeMaster, countMasterUsage,
  addAffiliation, affiliationLabel, affiliationPathLabel, sortedAffiliations, resolveLegacyAffiliations,
  affiliationPath, affiliationDepth, affiliationTree, childAffiliations, descendantIds, canSetParent,
  findAffiliationByEnglish, findPersonByEnglish, splitEnglishName,
  groupByCategory, dateKey, summarize, exportJson, importJson, migrate, signature, SCHEMA_VERSION, MAX_AFF_DEPTH,
} from '../src/model.js';
import {
  formatAuthors, formatItem, formatDateJa, formatDateEn, formatVolume, isSelf, isSelfAuthor,
  buildList, buildCsv, journalLabel, resolveLang, pickPath,
  fileName, backupFileName, authorName, authorAffiliation, affiliationText, affiliationPathText, CSV_HEADER,
} from '../src/format.js';
import { normalizeDoi, mapCrossrefMessage, fetchByDoi } from '../src/crossref.js';
import {
  citationKey, toBibtex, buildBibtex, toRis, buildRis, buildKakenhi, kakenhiFlags,
  fiscalYear, summarizeByYear, buildYearlyCsv, exportFileName,
} from '../src/export-formats.js';

/** 階層つきの所属を含むサンプル DB */
function sampleDb() {
  const db = emptyDb();
  const ut = addAffiliation(db, '東京大学', { shortName: '東京大', nameEn: 'The University of Tokyo', shortNameEn: 'UTokyo' }).id;
  const gs = addAffiliation(db, '大学院理学系研究科', { shortName: '院理', nameEn: 'Graduate School of Science', parentId: ut }).id;
  const dp = addAffiliation(db, '生物科学専攻', { nameEn: 'Department of Biological Sciences', parentId: gs }).id;
  const aist = addAffiliation(db, '産業技術総合研究所', {
    shortName: '産総研', nameEn: 'National Institute of Advanced Industrial Science and Technology', shortNameEn: 'AIST',
  }).id;
  const gsj = addAffiliation(db, '地質調査総合センター', { nameEn: 'Geological Survey of Japan', shortNameEn: 'GSJ', parentId: aist }).id;
  const me = upsertMaster(db.masters.persons, { name: '儀武滉大', nameEn: 'Gibu, K.', affiliationIds: [aist] }, 'name', 'per');
  const ig = upsertMaster(db.masters.persons, { name: '井口亮', nameEn: 'Iguchi, A.', affiliationIds: [gsj] }, 'name', 'per');
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
      { ...emptyAuthor(), personId: me, affiliationIds: [dp, gsj] },
      { ...emptyAuthor(), personId: ig, affiliationIds: [gsj] },
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
  db.achievements.push(paper, conf, intl);
  return { db, ids: { ut, gs, dp, aist, gsj, me, ig, sr, cf, ic }, paper, conf, intl };
}

// ══════════════════════════════════════════
//  所属の階層（今回追加）
// ══════════════════════════════════════════

test('階層: 上位の所属を指定して学部・専攻・部門を登録できる', () => {
  const { db, ids } = sampleDb();
  const dp = findById(db.masters.affiliations, ids.dp);
  assert.equal(dp.parentId, ids.gs);
  assert.deepEqual(affiliationPath(db, ids.dp).map((a) => a.name), ['東京大学', '大学院理学系研究科', '生物科学専攻']);
  assert.equal(affiliationDepth(db, ids.ut), 0);
  assert.equal(affiliationDepth(db, ids.dp), 2);
  assert.equal(affiliationPathLabel(db, ids.dp), '東京大学 ＞ 大学院理学系研究科 ＞ 生物科学専攻');
});

test('階層: 別の上位にある同名の所属は別の所属として登録される', () => {
  const db = emptyDb();
  const ut = addAffiliation(db, '東京大学', {}).id;
  const ku = addAffiliation(db, '京都大学', {}).id;
  const a = addAffiliation(db, '理学部', { parentId: ut });
  const b = addAffiliation(db, '理学部', { parentId: ku });
  assert.notEqual(a.id, b.id);
  assert.equal(addAffiliation(db, '理学部', { parentId: ut }).id, a.id, '同じ上位なら同じ所属');
  assert.equal(addAffiliation(db, '理学部', {}).created, true, '最上位の「理学部」はまた別');
});

test('階層: 存在しない上位・深すぎる階層はエラー', () => {
  const db = emptyDb();
  assert.throws(() => addAffiliation(db, 'X', { parentId: 'nope' }), /上位の所属が見つかりません/);
  let pid = '';
  for (let i = 0; i < MAX_AFF_DEPTH; i += 1) pid = addAffiliation(db, `L${i}`, { parentId: pid }).id;
  assert.throws(() => addAffiliation(db, 'too-deep', { parentId: pid }), /段までです/);
});

test('階層: 一覧は親の直後に子が並び、同じ階層は名称順', () => {
  const { db } = sampleDb();
  addAffiliation(db, '大学院農学生命科学研究科', { parentId: findById(db.masters.affiliations, sortedAffiliations(db)[2].id).id });
  const tree = affiliationTree(db).map(({ aff, depth }) => `${depth}:${aff.name}`);
  assert.deepEqual(tree.slice(0, 2), ['0:産業技術総合研究所', '1:地質調査総合センター']);
  assert.equal(tree[2], '0:東京大学');
  assert.ok(tree.indexOf('2:生物科学専攻') === tree.indexOf('1:大学院理学系研究科') + 1, '子は親の直後');
  assert.equal(sortedAffiliations(db).length, db.masters.affiliations.length);
});

test('階層: 下位の一覧と、上位にできない所属（自分自身・自分の下位）', () => {
  const { db, ids } = sampleDb();
  assert.deepEqual(childAffiliations(db, ids.ut).map((a) => a.name), ['大学院理学系研究科']);
  assert.deepEqual(descendantIds(db, ids.ut).sort(), [ids.gs, ids.dp].sort());
  assert.equal(canSetParent(db, ids.ut, ids.dp), false, '下位を上位にはできない');
  assert.equal(canSetParent(db, ids.ut, ids.ut), false);
  assert.equal(canSetParent(db, ids.dp, ids.aist), true, '別の機関の下へ移動はできる');
  assert.equal(canSetParent(db, ids.dp, ''), true);
});

test('階層: 下位の所属がある所属は削除できない', () => {
  const { db, ids } = sampleDb();
  const r = removeMaster(db, 'affiliations', ids.ut);
  assert.equal(r.removed, false);
  assert.equal(r.children, 1);
  const leaf = addAffiliation(db, '未使用の部門', { parentId: ids.aist }).id;
  assert.equal(removeMaster(db, 'affiliations', leaf).removed, true);
});

test('階層の表記: すべて / 最上位のみ / 最下位のみ（和文・英文）', () => {
  const { db, ids } = sampleDb();
  assert.equal(affiliationPathText(db, ids.dp, 'ja', true, 'full'), '東京大 院理 生物科学専攻');
  assert.equal(affiliationPathText(db, ids.dp, 'ja', false, 'full'), '東京大学 大学院理学系研究科 生物科学専攻');
  assert.equal(affiliationPathText(db, ids.dp, 'en', true, 'full'),
    'Department of Biological Sciences, Graduate School of Science, UTokyo', '英語は下位から上位の順');
  assert.equal(affiliationPathText(db, ids.dp, 'ja', true, 'top'), '東京大');
  assert.equal(affiliationPathText(db, ids.dp, 'ja', true, 'leaf'), '生物科学専攻');
  assert.deepEqual(pickPath([1, 2, 3], 'top'), [1]);
  assert.deepEqual(pickPath([1, 2, 3], 'leaf'), [3]);
  assert.deepEqual(pickPath([], 'full'), []);
});

test('階層の表記は profile.affDisplay の設定に従う', () => {
  const { db, conf } = sampleDb();
  assert.ok(formatItem(db, conf, 'plain').startsWith('儀武滉大（東京大 院理 生物科学専攻・産総研 地質調査総合センター）'));
  db.profile.affDisplay = 'top';
  assert.ok(formatItem(db, conf, 'plain').startsWith('儀武滉大（東京大・産総研）・井口亮（産総研）'));
  db.profile.affDisplay = 'leaf';
  assert.ok(formatItem(db, conf, 'plain').startsWith('儀武滉大（生物科学専攻・地質調査総合センター）'));
});

test('英語表記で階層を含む複数所属は「; 」で区切る', () => {
  const { db, intl } = sampleDb();
  assert.equal(formatItem(db, intl, 'plain'),
    'Gibu, K. (Department of Biological Sciences, Graduate School of Science, UTokyo; GSJ, AIST), '
    + 'Iguchi, A. (GSJ, AIST). "Microbiome Analysis of Reef-Building Corals". '
    + '1st Asia-Pacific Biodiversity Joint Conference. 23 October 2024. No. 23-VI-4.');
  db.profile.affDisplay = 'top';
  assert.ok(formatItem(db, intl, 'plain').startsWith('Gibu, K. (UTokyo, AIST), Iguchi, A. (AIST).'), '階層が無ければ「, 」');
});

test('英名が未登録の階層は和文で補う', () => {
  const { db, ids } = sampleDb();
  const sub = addAffiliation(db, 'サンゴ礁研究グループ', { parentId: ids.gsj }).id;
  assert.equal(affiliationPathText(db, sub, 'en', true, 'full'), 'サンゴ礁研究グループ, GSJ, AIST');
});

test('同じ上位で英語名称が一致する所属は同じ所属とみなす', () => {
  const { db, ids } = sampleDb();
  const r = addAffiliation(db, '', { nameEn: 'graduate school of science', parentId: ids.ut });
  assert.equal(r.id, ids.gs);
  assert.equal(findAffiliationByEnglish(db, 'GSJ')?.id, ids.gsj, '全階層から検索');
  assert.equal(findAffiliationByEnglish(db, 'GSJ', '')?.id ?? null, null, '最上位に限ると見つからない');
});

test('CSV の所属は常にすべての階層の正式名称', () => {
  const { db } = sampleDb();
  db.profile.affDisplay = 'top';
  const line = buildCsv(db).trim().split('\r\n').find((l) => l.includes('南西諸島'));
  assert.ok(line.includes('東京大学 大学院理学系研究科 生物科学専攻; 産業技術総合研究所 地質調査総合センター'));
});

test('移行: v3 以前の所属は最上位になり、不正な上位は解除される', () => {
  const v3 = {
    schemaVersion: 3,
    profile: { affDisplay: 'invalid' },
    masters: {
      affiliations: [
        { id: 'a1', name: '琉球大学', shortName: '琉大' },
        { id: 'a2', name: '理学部', parentId: 'missing' },
        { id: 'a3', name: 'A', parentId: 'a4' },
        { id: 'a4', name: 'B', parentId: 'a3' },
      ],
    },
    achievements: [],
  };
  const db = migrate(v3);
  assert.equal(db.schemaVersion, SCHEMA_VERSION);
  assert.equal(findById(db.masters.affiliations, 'a1').parentId, '');
  assert.equal(findById(db.masters.affiliations, 'a2').parentId, '', '存在しない上位は解除');
  const cyc = ['a3', 'a4'].map((id) => findById(db.masters.affiliations, id).parentId);
  assert.ok(cyc.includes(''), '循環は解消される');
  assert.equal(db.profile.affDisplay, 'full');
  assert.equal(affiliationTree(db).length, 4, '全件が一覧に出る');
});

test('マージ読み込み: 階層を保ったまま、同じ上位×同じ名称でまとめる', () => {
  const current = emptyDb();
  const ut = addAffiliation(current, '東京大学', {}).id;
  addAffiliation(current, '大学院理学系研究科', { parentId: ut });
  const { db: incoming } = sampleDb();
  const { db } = importJson(exportJson(incoming), 'merge', current);
  const names = affiliationTree(db).map(({ aff, depth }) => `${depth}:${aff.name}`);
  assert.equal(names.filter((n) => n === '0:東京大学').length, 1);
  assert.equal(names.filter((n) => n === '1:大学院理学系研究科').length, 1);
  assert.ok(names.includes('2:生物科学専攻'));
  const gs = db.masters.affiliations.find((a) => a.name === '大学院理学系研究科');
  assert.equal(gs.nameEn, 'Graduate School of Science', '空欄の英名が補われる');
  const conf = db.achievements.find((a) => a.title.startsWith('南西諸島'));
  assert.equal(affiliationPathLabel(db, conf.authors[0].affiliationIds[0]), '東京大学 ＞ 大学院理学系研究科 ＞ 生物科学専攻');
});

test('置き換え読み込みで階層と表示設定が保たれる', () => {
  const { db } = sampleDb();
  db.profile.affDisplay = 'leaf';
  const { db: r } = importJson(exportJson(db), 'replace');
  assert.equal(r.profile.affDisplay, 'leaf');
  assert.equal(buildList(r, 'plain', { title: 'x' }), buildList(db, 'plain', { title: 'x' }));
});

test('集計に機関（最上位）の件数が入る', () => {
  const { db } = sampleDb();
  const s = summarize(db);
  assert.equal(s.affiliations, 5);
  assert.equal(s.affiliationsTop, 2);
});

// ══════════════════════════════════════════
//  英名・表記言語
// ══════════════════════════════════════════

test('所属: 和英4項目の登録と、食い違いの確認', () => {
  const db = emptyDb();
  const id = addAffiliation(db, '琉球大学', { shortName: '琉大' }).id;
  assert.equal(addAffiliation(db, '琉球大学', { nameEn: 'University of the Ryukyus' }).updated, true);
  const r = addAffiliation(db, '琉球大学', { shortName: '琉球大' });
  assert.equal(r.conflicts[0].label, '略称');
  assert.equal(findById(db.masters.affiliations, id).shortName, '琉大');
  addAffiliation(db, '琉球大学', { shortName: '琉球大' }, { updateExisting: true });
  assert.equal(findById(db.masters.affiliations, id).shortName, '琉球大');
  assert.equal(findById(db.masters.affiliations, addAffiliation(db, '九州大学', '九大').id).shortName, '九大', '旧呼び出し');
  assert.throws(() => addAffiliation(db, '', {}), /所属の名称を入力/);
});

test('所属の表示ラベルと 1 段の表記', () => {
  const aff = { name: '産業技術総合研究所', shortName: '産総研', nameEn: 'AIST Full', shortNameEn: 'AIST' };
  assert.equal(affiliationLabel(aff), '産業技術総合研究所（産総研） / AIST Full (AIST)');
  assert.equal(affiliationText(aff, 'en', true), 'AIST');
  assert.equal(affiliationText(aff, 'en', false), 'AIST Full');
  assert.equal(affiliationText({ name: '琉球大学', shortName: '琉大' }, 'en', true), '琉大');
});

test('英語名の照合と著者名', () => {
  assert.deepEqual(splitEnglishName('Kodai Gibu'), { family: 'Gibu', given: 'Kodai' });
  const { db, ids } = sampleDb();
  assert.equal(findPersonByEnglish(db, 'Gibu, Kodai')?.id, ids.me);
  assert.equal(findPersonByEnglish(db, 'Gibu, Taro'), null);
  assert.equal(authorName(db, { ...emptyAuthor(), personId: ids.me }, 'en'), 'Gibu, K.');
  assert.equal(authorName(db, { ...emptyAuthor(), freeName: '未登録' }, 'en'), '未登録');
});

test('表記言語の自動判定と手動指定', () => {
  const { db, paper, conf, intl } = sampleDb();
  assert.equal(resolveLang(db, intl), 'en');
  assert.equal(resolveLang(db, paper), 'en');
  assert.equal(resolveLang(db, conf), 'ja');
  assert.equal(resolveLang(db, { ...conf, lang: 'en' }), 'en');
  assert.equal(resolveLang(db, { ...intl, lang: 'ja' }), 'ja');
});

test('英文誌の論文は英名で出力され、自分が強調される', () => {
  const { db, paper } = sampleDb();
  assert.equal(formatItem(db, paper, 'plain'),
    'Gibu, K., Iguchi, A. (2024). Polyamine impact on physiology of early stages of reef-building corals. '
    + 'Scientific Reports, 14(1), 23465.');
  assert.ok(formatItem(db, paper, 'html').startsWith('<strong><u>Gibu, K.</u></strong>'));
  assert.equal(isSelf(db, '儀武 滉大'), true);
  assert.equal(isSelfAuthor(db, paper.authors[1]), false);
});

test('日付の表記（和文・英文）', () => {
  assert.equal(formatDateJa({ year: '2025', month: '3', day: '15' }), '2025年3月15日');
  assert.equal(formatDateEn({ year: '2024', month: '10', day: '23' }), '23 October 2024');
  assert.equal(formatDateEn({ year: '2024', month: '3', day: '' }), 'March 2024');
  assert.equal(formatVolume({ volume: '14', issue: '1' }), '14(1)');
});

test('CSV に和英の著者・所属と表記言語の列が入る', () => {
  const { db } = sampleDb();
  const lines = buildCsv(db).trim().split('\r\n');
  assert.equal(lines[0], CSV_HEADER.join(','));
  const l = lines.find((x) => x.includes('Microbiome'));
  assert.ok(l.includes(',英語,'));
  assert.ok(l.includes('"Gibu, K.; Iguchi, A."'));
});

// ══════════════════════════════════════════
//  既存機能
// ══════════════════════════════════════════

test('区分と入力形式', () => {
  assert.ok(CATEGORIES.length >= 8);
  assert.equal(kindOf('journal_reviewed'), 'paper');
  assert.equal(kindOf('conf_intl_oral'), 'conference');
  assert.equal(kindOf('lecture'), 'other');
});

test('マスタの重複防止・使用件数・削除防止', () => {
  const db = emptyDb();
  const a = upsertMaster(db.masters.journals, { name: 'PeerJ', abbr: '' }, 'name', 'jnl');
  assert.equal(upsertMaster(db.masters.journals, { name: 'PeerJ', abbr: 'PeerJ' }, 'name', 'jnl'), a);
  const s = sampleDb();
  assert.equal(countMasterUsage(s.db, 'journals', s.ids.sr), 1);
  assert.equal(removeMaster(s.db, 'journals', s.ids.sr).removed, false);
  assert.ok(countMasterUsage(s.db, 'affiliations', s.ids.gsj) >= 3);
});

test('旧形式「A・B」の所属文字列は最上位の所属へ移行される', () => {
  const db = migrate({ schemaVersion: 1, achievements: [{ categoryId: 'conf_dom_oral', title: '旧', year: '2021',
    authors: [{ freeName: 'X', freeAffiliation: '琉球大学・東京大学' }] }] });
  assert.equal(db.masters.affiliations.length, 2);
  assert.ok(db.masters.affiliations.every((a) => a.parentId === ''));
  assert.equal(authorAffiliation(db, db.achievements[0].authors[0]), '琉球大学・東京大学');
  const au = resolveLegacyAffiliations(db, { freeName: 'Y', freeAffiliation: '東京大学' });
  assert.equal(au.affiliationIds.length, 1);
});

test('グループ化・並び順・リスト出力', () => {
  const { db } = sampleDb();
  assert.equal(groupByCategory(db.achievements, 'asc')[0].category.id, 'journal_reviewed');
  assert.ok(dateKey({ year: '2025', month: '3' }) > dateKey({ year: '2024', month: '12' }));
  const md = buildList(db, 'markdown', { title: 'T' });
  assert.ok(md.includes('## 国際学会における発表［口頭発表］'));
  assert.ok(buildList(db, 'html').includes('#b5b5ac'));
  assert.equal(journalLabel(db, db.achievements[0], true), 'Sci Rep');
});

test('JSON の重複除外と不正データ', () => {
  const { db } = sampleDb();
  assert.equal(importJson(exportJson(sampleDb().db), 'merge', db).added, 0);
  assert.throws(() => importJson('これはJSONではない'), /JSON として読み取れません/);
  assert.equal(signature({ ...db.achievements[0], id: 'x' }), signature(db.achievements[0]));
});

test('ファイル名', () => {
  const d = new Date(2026, 8, 25);
  assert.equal(fileName('html', d), '業績目録_20260925.html');
  assert.equal(backupFileName(d), 'achievements_backup_20260925.json');
  assert.equal(exportFileName('ris', d), '業績目録_20260925.ris');
});

test('formatAuthors: 言語ごとの区切り', () => {
  const { db, conf } = sampleDb();
  assert.ok(formatAuthors(db, conf, { lang: 'ja' }).text.includes('）・井口亮（'));
});

test('DOI と CrossRef', async () => {
  assert.equal(normalizeDoi('https://doi.org/10.1038/s41598-024-74596-x'), '10.1038/s41598-024-74596-x');
  assert.throws(() => normalizeDoi('x'), /DOI の形式ではありません/);
  const msg = {
    DOI: '10.1/x', title: ['T'], 'container-title': ['J'], 'published-print': { 'date-parts': [[2024, 10, 8]] },
    author: [{ given: 'Kodai', family: 'Gibu', affiliation: [{ name: 'GSJ' }] }],
  };
  const m = mapCrossrefMessage(msg);
  const { db, ids } = sampleDb();
  assert.equal(findPersonByEnglish(db, m.authors[0].name)?.id, ids.me);
  assert.equal(findAffiliationByEnglish(db, m.authors[0].affiliation)?.id, ids.gsj, '下位の所属にも紐づく');
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', message: msg }) });
  assert.equal((await fetchByDoi('10.1234/x', { fetchImpl: ok })).journal, 'J');
  await assert.rejects(() => fetchByDoi('10.1234/x', { fetchImpl: async () => ({ ok: false, status: 404 }) }), /登録されていません/);
});

test('BibTeX / RIS / 科研費様式', () => {
  const { db, paper, intl, conf } = sampleDb();
  assert.equal(citationKey(db, paper, new Set()), 'Gibu2024Polyamine');
  assert.ok(toBibtex(db, intl, new Set()).includes('author = {Gibu, K. and Iguchi, A.}'));
  assert.ok(toBibtex(db, conf, new Set()).includes('author = {儀武滉大 and 井口亮}'));
  assert.equal((buildBibtex(db).match(/^@/gm) ?? []).length, 3);
  assert.ok(toRis(db, { ...paper, pages: '60-65' }).includes('EP  - 65'));
  assert.equal((buildRis(db).match(/^ER {2}- ?$/gm) ?? []).length, 3);
  assert.equal(kakenhiFlags({ categoryId: 'conf_intl_poster' }).international, '該当する');
  assert.ok(buildKakenhi(db).includes('〔学会発表〕　計2件'));
});

test('年度別集計', () => {
  assert.equal(fiscalYear({ year: '2025', month: '3' }), 2024);
  const { db } = sampleDb();
  assert.equal(summarizeByYear(db, 'fiscal').rows[0].total, 3);
  assert.deepEqual(summarizeByYear(db, 'calendar').rows.map((r) => r.year), [2024, 2025]);
  assert.ok(buildYearlyCsv(db, 'calendar').includes('合計'));
});
