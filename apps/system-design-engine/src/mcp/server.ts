import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SupermemorySync } from "../knowledge/sync.js";

export function createMcpServer() {
  const server = new McpServer({
    name: "System Design Engine",
    version: "1.0.0",
  });

  const syncEngine = new SupermemorySync();

  server.registerTool(
    "get_system_design_context",
    {
      description: "PRIMARY TOOL FOR AI CODING AGENTS. Call this tool FIRST to retrieve structured architectural context (services, database entities, web clients, endpoints, data schemas, and test cases/scenarios) for a given project. Use this before writing implementation code or test cases to ensure full alignment with system design specifications and test contracts.",
      inputSchema: {
        projectId: z.string().describe("The ID of the project to retrieve context for"),
        query: z.string().describe("The specific query to search the architecture for (e.g., 'How does authentication work?', 'User service schema', or 'Endpoint test cases')")
      }
    },
    async ({ projectId, query }) => {
      try {
        const context = await syncEngine.buildCodingContext(projectId, query);
        return {
          content: [{ type: "text", text: JSON.stringify(context, null, 2) }]
        };
      } catch (error: any) {
         return {
            content: [{ type: "text", text: `Error retrieving context: ${error.message}` }],
            isError: true
         }
      }
    }
  );

  server.registerTool(
    "search_system_design_memories",
    {
      description: "Granular search tool for AI coding agents. Call this tool to perform raw vector searches against the project architecture knowledge base for specific endpoints, data schemas, entity fields, or custom test case requirements. Returns matching chunks and metadata.",
      inputSchema: {
        projectId: z.string().describe("The ID of the project to search"),
        query: z.string().describe("The search query string (e.g., 'Payment endpoint test cases', 'Redis stream config', or 'User table columns')")
      }
    },
    async ({ projectId, query }) => {
      try {
        const results = await syncEngine.searchMemories(projectId, query);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
        };
      } catch (error: any) {
         return {
            content: [{ type: "text", text: `Error searching memories: ${error.message}` }],
            isError: true
         }
      }
    }
  );

  return server;
}

export async function startStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("System Design Engine MCP Server running on stdio");
}
