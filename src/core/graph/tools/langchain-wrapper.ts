import { DynamicStructuredTool } from "@langchain/core/tools";

export function wrapTool(aiTool: any, name: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name,
    description: aiTool.description,
    schema: aiTool.parameters || aiTool.inputSchema,
    func: async (input: any) => {
      const result = await aiTool.execute(input);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  });
}
