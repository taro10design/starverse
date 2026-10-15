// ---------------------------------------------------------------------------
// History — アンドゥ / リドゥ
// ---------------------------------------------------------------------------
export class History {
  constructor(onChange) {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = onChange;
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  pushOp(op) {
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
