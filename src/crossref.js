/**
 * 業績管理アプリ — DOI から書誌情報を取得（CrossRef REST API）
 *
 * 参考: https://api.crossref.org/  （/works/{doi} で 1 件のメタデータを取得）
 * 利用時は mailto を付けた "polite pool" を使う（推奨されている作法）。
 */

export const CROSSREF_BASE = 'https://api.crossref.org/works/';

/**
 * 入力された DOI 文字列を正規化する。
 * URL 形式（https://doi.org/10.xxxx/yyyy）や "doi:" 接頭辞も受け付ける。
 * @returns {string} 正規化された DOI（例: 10.1038/s41598-024-74596-x）
 * @throws {Error} DOI として解釈できない場合
 */
export function normalizeDoi(input) {
  let s = String(input ?? '').trim();
  if (s === '') throw new Error('DOI を入力してください。');
  s = s.replace(/^\s*doi\s*:\s*/i, '');
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  s = s.replace(/\s+/g, '');
  if (!/^10\.\d{4,9}\/\S+$/.test(s)) {
    throw new Error(`DOI の形式ではありません（入力値: ${input}）。例: 10.1038/s41598-024-74596-x`);
  }
  return s;
}

/** DOI から表示用の URL を作る */
export function doiUrl(doi) {
  const d = String(doi ?? '').trim();
  if (d === '') return '';
  if (/^https?:\/\//i.test(d)) return d;
  return `https://doi.org/${d}`;
}

/**
 * CrossRef の 1 件分メタデータ（message）を、アプリの業績フィールドへ変換する。
 * @param {object} msg CrossRef の message オブジェクト
 * @returns {{title,journal,journalAbbr,year,month,day,volume,issue,pages,doi,publisher,type,authors}}
 */
export function mapCrossrefMessage(msg) {
  if (!msg || typeof msg !== 'object') throw new Error('書誌情報を読み取れませんでした。');

  const firstOf = (v) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
  const title = String(firstOf(msg.title)).trim();
  const journal = String(firstOf(msg['container-title'])).trim();
  const journalAbbr = String(firstOf(msg['short-container-title'])).trim();

  // 発行日は published-print / published-online / issued の順で探す
  const dateParts = msg['published-print']?.['date-parts']?.[0]
    ?? msg['published-online']?.['date-parts']?.[0]
    ?? msg.issued?.['date-parts']?.[0]
    ?? [];
  const [year = '', month = '', day = ''] = dateParts.map((n) => (n == null ? '' : String(n)));

  // ページが無い場合は論文番号（article-number）を使う
  const pages = String(msg.page ?? msg['article-number'] ?? '').trim();

  const authors = (msg.author ?? []).map((a) => {
    const family = String(a.family ?? '').trim();
    const given = String(a.given ?? '').trim();
    const name = family && given ? `${family}, ${given}` : (family || given || String(a.name ?? '').trim());
    return {
      name,
      family,
      given,
      // 所属は配列で入ることがある（先頭のみ採用）
      affiliation: String(a.affiliation?.[0]?.name ?? '').trim(),
    };
  }).filter((a) => a.name !== '');

  return {
    title,
    journal,
    journalAbbr,
    year,
    month,
    day,
    volume: String(msg.volume ?? '').trim(),
    issue: String(msg.issue ?? '').trim(),
    pages,
    doi: String(msg.DOI ?? '').trim(),
    publisher: String(msg.publisher ?? '').trim(),
    type: String(msg.type ?? '').trim(),
    authors,
  };
}

/**
 * DOI から書誌情報を取得する。
 * @param {string} doiInput DOI（URL 形式も可）
 * @param {{mailto?:string, fetchImpl?:Function, signal?:AbortSignal}} opts
 * @returns {Promise<object>} mapCrossrefMessage の戻り値
 */
export async function fetchByDoi(doiInput, opts = {}) {
  const doi = normalizeDoi(doiInput);
  const fetchImpl = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new Error('この環境ではネットワーク取得を利用できません。');

  const mailto = String(opts.mailto ?? '').trim();
  const url = CROSSREF_BASE + encodeURIComponent(doi) + (mailto ? `?mailto=${encodeURIComponent(mailto)}` : '');

  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: opts.signal,
    });
  } catch (e) {
    throw new Error('CrossRef に接続できませんでした。ネットワーク接続を確認してください。');
  }
  if (res.status === 404) throw new Error(`この DOI は CrossRef に登録されていません（${doi}）。`);
  if (!res.ok) throw new Error(`CrossRef から取得できませんでした（HTTP ${res.status}）。`);

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('CrossRef の応答を解釈できませんでした。');
  }
  if (!json || json.status !== 'ok' || !json.message) {
    throw new Error('CrossRef の応答に書誌情報が含まれていません。');
  }
  return mapCrossrefMessage(json.message);
}
