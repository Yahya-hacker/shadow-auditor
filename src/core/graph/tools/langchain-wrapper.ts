/* eslint-disable @typescript-eslint/no-explicit-any */
import { DynamicStructuredTool } from "@langchain/core/tools";

export function wrapTool(aiTool: Record<string, any>, name: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    description: aiTool.description,
    async func(input: Record<string, any>) {
      const result = await aiTool.execute(input);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
    name,
    schema: aiTool.parameters || aiTool.inputSchema,
  });
}
