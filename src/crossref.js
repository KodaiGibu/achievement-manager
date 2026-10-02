/**
 * 業績管理アプリ — DOI から書誌情報を取得（CrossRef REST API）
 *
 * 参考: https://api.crossref.org/  （/works/{doi} で 1 件のメタデータを取得）
 */

export const CROSSREF_BASE = 'https://api.crossref.org/works/';

/** DOI 文字列を正規化する（URL 形式や "doi:" 接頭辞も受け付ける） */
export function normalizeDoi(input) {
  let s = String(input ?? '').trim();
  if (s === '') throw new Error('DOI を入力してください。');
  s = s.replace(/^\s*doi\s*:\s*/i, '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/\s+/g, '');
  if (!/^10\.\d{4,9}\/\S+$/.test(s)) {
    throw new Error(`DOI の形式ではありません（入力値: ${input}）。例: 10.1038/s41598-024-74596-x`);
  }
  return s;
}

export function doiUrl(doi) {
  const d = String(doi ?? '').trim();
  if (d === '') return '';
  return /^https?:\/\//i.test(d) ? d : `https://doi.org/${d}`;
}

/** CrossRef の message オブジェクトを業績フィールドへ変換する */
export function mapCrossrefMessage(msg) {
  if (!msg || typeof msg !== 'object') throw new Error('書誌情報を読み取れませんでした。');
  const firstOf = (v) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
  const dateParts = msg['published-print']?.['date-parts']?.[0]
    ?? msg['published-online']?.['date-parts']?.[0]
    ?? msg.issued?.['date-parts']?.[0] ?? [];
  const [year = '', month = '', day = ''] = dateParts.map((n) => (n == null ? '' : String(n)));
  const authors = (msg.author ?? []).map((a) => {
    const family = String(a.family ?? '').trim();
    const given = String(a.given ?? '').trim();
    const name = family && given ? `${family}, ${given}` : (family || given || String(a.name ?? '').trim());
    return { name, family, given, affiliation: String(a.affiliation?.[0]?.name ?? '').trim() };
  }).filter((a) => a.name !== '');
  return {
    title: String(firstOf(msg.title)).trim(),
    journal: String(firstOf(msg['container-title'])).trim(),
    journalAbbr: String(firstOf(msg['short-container-title'])).trim(),
    year, month, day,
    volume: String(msg.volume ?? '').trim(),
    issue: String(msg.issue ?? '').trim(),
    pages: String(msg.page ?? msg['article-number'] ?? '').trim(),
    doi: String(msg.DOI ?? '').trim(),
    publisher: String(msg.publisher ?? '').trim(),
    type: String(msg.type ?? '').trim(),
    authors,
  };
}

export async function fetchByDoi(doiInput, opts = {}) {
  const doi = normalizeDoi(doiInput);
  const fetchImpl = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new Error('この環境ではネットワーク取得を利用できません。');
  const mailto = String(opts.mailto ?? '').trim();
  const url = CROSSREF_BASE + encodeURIComponent(doi) + (mailto ? `?mailto=${encodeURIComponent(mailto)}` : '');
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: opts.signal });
  } catch {
    throw new Error('CrossRef に接続できませんでした。ネットワーク接続を確認してください。');
  }
  if (res.status === 404) throw new Error(`この DOI は CrossRef に登録されていません（${doi}）。`);
  if (!res.ok) throw new Error(`CrossRef から取得できませんでした（HTTP ${res.status}）。`);
  let json;
  try { json = await res.json(); } catch { throw new Error('CrossRef の応答を解釈できませんでした。'); }
  if (!json || json.status !== 'ok' || !json.message) throw new Error('CrossRef の応答に書誌情報が含まれていません。');
  return mapCrossrefMessage(json.message);
}
