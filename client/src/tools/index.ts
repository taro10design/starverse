import type { ToolName } from "../constants";
import type { Tool, ToolContext } from "./tool";
import { MoveTool } from "./move-tool";
import { StarTool } from "./star-tool";
import { LineTool } from "./line-tool";
import { EraseTool } from "./erase-tool";
import { GhostTool } from "./ghost-tool";

export type { Tool, ToolContext, PointerInfo, LinkPreview, Feedback } from "./tool";
export { HitTester } from "./hit";

// ツールを足すときは、tools/ にクラスを足してここに登録する（ToolName にも名前を足す）
export function createTools(ctx: ToolContext): Record<ToolName, Tool> {
  return {
    move: new MoveTool(ctx),
    star: new StarTool(ctx),
    line: new LineTool(ctx),
    erase: new EraseTool(ctx),
    ghost: new GhostTool(ctx),
  };
}
