// localStorage の薄いラッパー。
// プライベートブラウズ・ストレージの無効化・容量超過では localStorage が例外を投げる。
// 保存できなくてもアプリが壊れないよう、握りつぶすのはここだけにする
// （読み取りは「無かった」ものとして扱い、書き込みは何もしない）。

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // ストレージが使えない環境
  }
}

function set(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 使えない・容量超過。保存できないだけで、動作には影響しない
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 使えない環境。消せないだけで、動作には影響しない
  }
}

// 形は保証しない（unknown を返す）。使う側で validate.ts の関数を使って確かめる
function getJSON(key: string): unknown {
  const raw = get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null; // 壊れたデータは無かったものとして扱う
  }
}

export const storage = {
  get,
  set,
  remove,
  getJSON,
  setJSON: (key: string, value: unknown) => set(key, JSON.stringify(value)),
};
