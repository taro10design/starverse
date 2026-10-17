// ---------------------------------------------------------------------------
// OpPacer — 星・線の操作の送信を小分けにする
//
// サーバーは接続ごとのトークンバケットでレート制限する（server/src/config.ts の RATE: 容量 200・毎秒 40 回復、
// COST: star / link / admire が 2、unstar / unlink が 1）。あふれた star / link には reject が返って取り消せるが、
// unstar / unlink は黙って捨てられる（通信仕様。取り消しは来ない）。そのため「自分の星を全部消す」
// 「幽霊を全部復活」「それらのアンドゥ / リドゥ」のような一括操作を一度に送ると、消したつもりの星が
// サーバーに残り、画面と食い違う。
//
// ここでは固定の窓（OP_WINDOW_MS）ごとに OP_CHUNK 件までしか送らず、超えた分は順番を保って次の窓に回す。
// 順番を保つため、待ちがある間は単発の操作も列の後ろに並べる（unstar の前に同じ id の star が届かないように）。
// 切断したら残りは捨てる（clear）。次の welcome で空の全体を受け取り、画面はサーバーにそろう。
// ---------------------------------------------------------------------------

// 1 窓で送る件数と窓の長さ。1 件のコストは最大 2 なので、1 窓で最大 40 トークン = 毎秒の回復量（40）に収まる。
// 位置（p: 毎秒最大 10 回・コスト 1）や pulse の分は容量 200 の余裕から出る。上限ぶんの一括操作
// （星 64 個 = 128 トークン）を続けて 2 回送っても容量を使い切らない。
// なぞりで星を置く速さ（StarTool の毎秒 20 個）はちょうど 1 窓に収まるので、普段の操作は待たされない
export const OP_CHUNK = 20;
export const OP_WINDOW_MS = 1000;

export class OpPacer {
  private queue: string[] = [];
  private sentInWindow = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private sendNow: (data: string) => void,
    private chunk = OP_CHUNK,
    private windowMs = OP_WINDOW_MS,
  ) {}

  // 送るのを待っている件数
  get waiting(): number {
    return this.queue.length;
  }

  push(data: string) {
    if (this.queue.length === 0 && this.sentInWindow < this.chunk) this.sendOne(data);
    else this.queue.push(data);
  }

  // 残りを捨て、窓も初期化する（切断したとき）
  clear() {
    this.queue = [];
    this.sentInWindow = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private sendOne(data: string) {
    this.sendNow(data);
    this.sentInWindow++;
    // 窓は最初の送信から始まる。窓が閉じたら、待っている分を次の窓で送る
    this.timer ??= setTimeout(() => this.nextWindow(), this.windowMs);
  }

  private nextWindow() {
    this.timer = null;
    this.sentInWindow = 0;
    while (this.sentInWindow < this.chunk) {
      const next = this.queue.shift();
      if (next === undefined) break;
      this.sendOne(next);
    }
  }
}
