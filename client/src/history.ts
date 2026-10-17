// ---------------------------------------------------------------------------
// History — アンドゥ / リドゥ
// ---------------------------------------------------------------------------
export interface Op {
  undo: () => void;
  redo: () => void;
  // サーバーへ何も送らない、自分の画面だけの操作（幽霊を忘れる など）。切断中でも戻せる
  local?: boolean;
}

export class History {
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];

  constructor(private onChange: () => void) {}
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  pushOp(op: Op) {
    this.undoStack.push(op);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.onChange();
  }
  // canSend が false（切断中）なら、先頭がローカルだけの操作のときだけ戻す（順序は飛ばさない）
  undo(canSend = true) {
    const op = this.undoStack.at(-1);
    if (!op || (!canSend && !op.local)) return;
    this.undoStack.pop();
    op.undo();
    this.redoStack.push(op);
    this.onChange();
  }
  redo(canSend = true) {
    const op = this.redoStack.at(-1);
    if (!op || (!canSend && !op.local)) return;
    this.redoStack.pop();
    op.redo();
    this.undoStack.push(op);
    this.onChange();
  }
}
