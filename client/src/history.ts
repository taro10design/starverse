// ---------------------------------------------------------------------------
// History — アンドゥ / リドゥ
// ---------------------------------------------------------------------------
export interface Op {
  undo: () => void;
  redo: () => void;
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
  undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    op.undo();
    this.redoStack.push(op);
    this.onChange();
  }
  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    op.redo();
    this.undoStack.push(op);
    this.onChange();
  }
}
