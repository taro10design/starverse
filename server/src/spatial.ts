// 空間ハッシュ。全組み合わせ O(n²) を避け、近くの星だけを見て密集度を数える。

export interface Point {
  x: number;
  y: number;
}

// 各点の「半径 r 以内にある他の点の数」を返す。キーは id
export function crowdCounts<T extends Point & { id: string }>(items: Iterable<T>, r: number): Map<string, number> {
  const cell = (v: number) => Math.floor(v / r);
  const key = (cx: number, cy: number) => cx * 1_000_000 + cy; // |cell| < 1e6 の範囲では一意
  const grid = new Map<number, T[]>();
  const list: T[] = [];
  for (const it of items) {
    list.push(it);
    const k = key(cell(it.x), cell(it.y));
    const bucket = grid.get(k);
    if (bucket) bucket.push(it);
    else grid.set(k, [it]);
  }

  const r2 = r * r;
  const counts = new Map<string, number>();
  for (const it of list) {
    const cx = cell(it.x);
    const cy = cell(it.y);
    let n = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(key(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const o of bucket) {
          if (o === it) continue;
          const ox = o.x - it.x;
          const oy = o.y - it.y;
          if (ox * ox + oy * oy < r2) n++;
        }
      }
    }
    counts.set(it.id, n);
  }
  return counts;
}

// 視界 [x0,y0,x1,y1] に余白を足した範囲に点があるか。view が無ければ常に true
export function inView(view: readonly [number, number, number, number] | null, x: number, y: number, margin: number): boolean {
  if (!view) return true;
  const [x0, y0, x1, y1] = view;
  const mx = (x1 - x0) * margin;
  const my = (y1 - y0) * margin;
  return x >= x0 - mx && x <= x1 + mx && y >= y0 - my && y <= y1 + my;
}
