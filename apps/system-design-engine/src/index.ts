import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { createGraph, systemPromptTemplate } from './ai/agent.js';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

const app = new Hono();

app.get('/', (c) => {
  return c.text('System Design Engine is running!');
});

app.post('/canvas-ai', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, messages, canvasStateContext, convexUrl: bodyConvexUrl, token, viewportCenter } = body;

    if (!messages || !projectId) {
      return c.text("Missing required fields", 400);
    }

    const convexUrl = bodyConvexUrl || process.env.CONVEX_URL;
    if (!convexUrl) {
      return c.text("Missing CONVEX_URL environment variable", 500);
    }

    const agent = createGraph();
    
    // Prepare initial state
    const formattedMessages = [
      new SystemMessage(systemPromptTemplate(canvasStateContext || "Canvas is empty.")),
      ...messages.map((m: any) => m.role === 'user' ? new HumanMessage(m.content) : new HumanMessage(m.content)) // Simplified
    ];

    const graphStream = await agent.streamEvents(
      { 
        messages: formattedMessages,
        projectId,
        convexUrl,
        token,
        viewportCenter
      },
      { version: 'v2' }
    );

    c.header('Content-Type', 'application/x-ndjson');
    c.header('Cache-Control', 'no-cache');

    return stream(c, async (streamWriter: any) => {
      for await (const event of graphStream) {
        if (event.event === 'on_chat_model_stream') {
          const chunk = event.data.chunk;
          if (chunk.content) {
            await streamWriter.write(JSON.stringify({ type: 'text', content: chunk.content }) + '\n');
          }
          if (chunk.tool_calls && chunk.tool_calls.length > 0) {
             for (const call of chunk.tool_calls) {
               const name = call.name;
               // We no longer need to translate and send CanvasOperation
               // because the tools apply mutations directly to Convex.
               // We just stream a notification to the frontend that a tool was used.
               await streamWriter.write(JSON.stringify({ type: 'tool_call', name }) + '\n');
             }
          }
        }
      }
    });

  } catch (error) {
    console.error("API error:", error);
    return c.text("Internal Server Error", 500);
  }
});

const port = 3002;
console.log(`System Design Engine is running on port ${port}`);

serve({
  fetch: app.fetch,
  port
});
