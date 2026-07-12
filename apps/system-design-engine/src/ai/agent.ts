import { ChatGroq } from "@langchain/groq";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { StateGraph, MessagesAnnotation, Annotation } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { ConvexHttpClient } from "convex/browser";
// Convex imports will just cast strings as any to avoid needing backend workspace dependency

import { BackendNodeType, BackendEdgeType } from "@workspace/canvas";

// Define the state schema for the LangGraph
export const GraphAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  projectId: Annotation<string>(),
  convexUrl: Annotation<string>(),
  token: Annotation<string>(),
  viewportCenter: Annotation<{ x: number, y: number }>(),
});

function getConvexClient(state: typeof GraphAnnotation.State) {
  if (!state.convexUrl) throw new Error("Missing convexUrl in state");
  const client = new ConvexHttpClient(state.convexUrl);
  if (state.token) {
    client.setAuth(state.token);
  }
  return client;
}

// ----------------------------------------------------------------------------
// CANVAS TOOLS (Direct Convex Mutations)
// ----------------------------------------------------------------------------

const addNodeTool = tool(
  async ({ type, label, data }, config) => {
    const state = config.configurable?.state as typeof GraphAnnotation.State;
    if (!state?.projectId) return "Error: projectId missing";
    const convex = getConvexClient(state);

    const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    
    // Offset slightly from center so multiple nodes don't stack exactly on top of each other
    const offset = Math.floor(Math.random() * 40) - 20; 
    const position = state.viewportCenter 
      ? { x: state.viewportCenter.x + offset, y: state.viewportCenter.y + offset }
      : { x: 100, y: 100 };
    
    // We use a high fractional index string so it appears on top (e.g., using "a0")
    // but typically the frontend manages fractional indexing.
    // For simplicity from AI, we'll assign a basic fractional string
    const fractionalIndex = "a0" + Date.now(); 

    const processedData = { label, graphPosition: position, ...data };
    
    // Ensure all messaging resources have IDs
    const resourceKeys = ["topics", "queues", "channels", "streams"];
    for (const key of resourceKeys) {
      if (Array.isArray(processedData[key])) {
        processedData[key] = processedData[key].map((item: any, i: number) => ({
          ...item,
          id: item.id || `res-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 7)}`
        }));
      }
    }

    try {
      await convex.mutation("canvas:upsertBackendNode" as any, {
        projectId: state.projectId as string,
        nodeId,
        type,
        position,
        data: processedData,
        fractionalIndex,
      });
      return `Added node ${label} of type ${type} with ID ${nodeId}`;
    } catch (e: any) {
      return `Failed to add node: ${e.message}`;
    }
  },
  {
    name: "add_node",
    description: `Add a node to the backend canvas. Node types:
- 'service': A backend API / microservice
- 'database': A database reference node
- 'sqs': Amazon SQS broker (stores queues in data.queues)
- 'redis-pubsub': Redis Pub/Sub broker (stores channels in data.channels)
- 'kafka': Apache Kafka broker (stores topics in data.topics [{ name, schema, version }]. Config in data.kafkaBroker { partitions, replication, batchSize, compression, ttl }, data.delivery, data.retention)
- 'redis-streams': Redis Streams broker (stores streams in data.streams)
- 'entity': A database table/schema entity
- 'webClient': A frontend client or page
- 'external': An external third-party API
- 'group': A logical grouping node`,
    schema: z.object({
      type: z.enum(["service", "database", "sqs", "redis-pubsub", "kafka", "redis-streams", "entity", "group", "webClient", "external"]),
      label: z.string().describe("Name of the node"),
      data: z.any().optional().describe("Additional data for the node. For 'entity': { columns: [{ name, type, isPrimaryKey, isForeignKey, isNotNull, isUnique }] }. For 'kafka': { topics: [{ name, schema, version }], kafkaBroker: { partitions, replication }, delivery, retention }."),
    }),
  }
);

const updateNodeTool = tool(
  async ({ id, changes }, config) => {
    const state = config.configurable?.state as typeof GraphAnnotation.State;
    if (!state?.projectId) return "Error: projectId missing";
    const convex = getConvexClient(state);

    try {
      // First, get the current node to preserve position and fractionalIndex
      // This requires a new query or passing data. To keep it simple, we use a targeted query or fallback.
      // Assuming upsertBackendNode can handle partial updates if we fetch first, 
      // but api.canvas.upsertBackendNode expects full data. 
      // We will need a specific update mutation, but for now we'll fetch elements, find node, and update.
      const elements: any = await convex.query("canvas:getBackendElements" as any, { projectId: state.projectId as string });
      const node = elements.nodes.find((n: any) => n.nodeId === id);
      
      if (!node) return `Error: Node ${id} not found`;

      const processedChanges = { ...changes };
      const resourceKeys = ["topics", "queues", "channels", "streams"];
      for (const key of resourceKeys) {
        if (Array.isArray(processedChanges[key])) {
          processedChanges[key] = processedChanges[key].map((item: any, i: number) => ({
            ...item,
            id: item.id || `res-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 7)}`
          }));
        }
      }

      await convex.mutation("canvas:upsertBackendNode" as any, {
        projectId: state.projectId as string,
        nodeId: id,
        type: node.type,
        position: node.position,
        data: { ...node.data, ...processedChanges },
        fractionalIndex: node.fractionalIndex,
      });
      return `Updated node ${id}`;
    } catch (e: any) {
      return `Failed to update node: ${e.message}`;
    }
  },
  {
    name: "update_node",
    description: "Update an existing node on the backend canvas. Only specify the fields you want to change.",
    schema: z.object({
      id: z.string(),
      changes: z.any().describe("Changes to the data. For 'kafka' topics/broker config, specify the full arrays/objects. E.g. { topics: [{ name, schema, version }] }"),
    }),
  }
);

const deleteNodeTool = tool(
  async ({ id }, config) => {
    const state = config.configurable?.state as typeof GraphAnnotation.State;
    if (!state?.projectId) return "Error: projectId missing";
    const convex = getConvexClient(state);

    try {
      await convex.mutation("canvas:removeBackendNode" as any, {
        projectId: state.projectId as string,
        nodeId: id,
      });
      return `Deleted node ${id}`;
    } catch (e: any) {
      return `Failed to delete node: ${e.message}`;
    }
  },
  {
    name: "delete_node",
    description: "Delete a node from the backend canvas.",
    schema: z.object({
      id: z.string(),
    }),
  }
);

const addEdgeTool = tool(
  async ({ source, target, type, data, sourceHandle, targetHandle }, config) => {
    const state = config.configurable?.state as typeof GraphAnnotation.State;
    if (!state?.projectId) return "Error: projectId missing";
    const convex = getConvexClient(state);
    
    const edgeId = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const fractionalIndex = "a0" + Date.now();

    try {
      await convex.mutation("canvas:upsertBackendEdge" as any, {
        projectId: state.projectId as string,
        edgeId,
        source,
        target,
        type,
        sourceHandle: sourceHandle || undefined,
        targetHandle: targetHandle || undefined,
        data: data || {},
        fractionalIndex,
      });
      return `Added edge from ${source} to ${target}`;
    } catch (e: any) {
      return `Failed to add edge: ${e.message}`;
    }
  },
  {
    name: "add_edge",
    description: "Connect two nodes on the backend canvas.",
    schema: z.object({
      source: z.string().describe("Source node ID"),
      target: z.string().describe("Target node ID"),
      type: z.enum(["connection", "foreign-key", "message"]),
      sourceHandle: z.string().optional(),
      targetHandle: z.string().optional(),
      data: z.any().optional(),
    }),
  }
);

const deleteEdgeTool = tool(
  async ({ id }, config) => {
    const state = config.configurable?.state as typeof GraphAnnotation.State;
    if (!state?.projectId) return "Error: projectId missing";
    const convex = getConvexClient(state);

    try {
      await convex.mutation("canvas:removeBackendEdge" as any, {
        projectId: state.projectId as string,
        edgeId: id,
      });
      return `Deleted edge ${id}`;
    } catch (e: any) {
      return `Failed to delete edge: ${e.message}`;
    }
  },
  {
    name: "delete_edge",
    description: "Delete an edge from the backend canvas.",
    schema: z.object({
      id: z.string(),
    }),
  }
);


const tools = [addNodeTool, updateNodeTool, deleteNodeTool, addEdgeTool, deleteEdgeTool];


// ----------------------------------------------------------------------------
// AGENT NODES
// ----------------------------------------------------------------------------

export function createGraph() {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_LLM_MODEL;
  if (!apiKey || !model) {
    throw new Error("Missing environment variables: GROQ_API_KEY or GROQ_LLM_MODEL");
  }
  
  const llm = new ChatGroq({
    apiKey,
    model,
    temperature: 0,
  });

  const modelWithTools = llm.bindTools(tools);
  
  // Custom tool node that injects state into tool config
  const customToolNode = async (state: typeof GraphAnnotation.State) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage || !('tool_calls' in lastMessage) || !Array.isArray((lastMessage as any).tool_calls) || (lastMessage as any).tool_calls.length === 0) {
      return { messages: [] };
    }
    
    const toolNode = new ToolNode(tools);
    return await toolNode.invoke(
      { messages: [lastMessage] },
      { configurable: { state } } // Inject state into config
    );
  };

  // Node: Intent Identifier
  const intentIdentifier = async (state: typeof GraphAnnotation.State) => {
    // Only run intent identifier if the last message is from a human
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage || lastMessage.getType() !== "human") return { messages: [] };

    const intentPrompt = new SystemMessage(
      `Analyze the user's message and determine the intent.
Available Intents:
- CREATE_SYSTEM: The user wants to build a new system architecture, add nodes, or create a new design from scratch.
- EDIT_SYSTEM: The user wants to modify the existing system (update nodes, delete nodes, connect nodes, auto-layout).
- CHAT: The user is just asking a question, making a general comment, or having a conversation that does NOT require modifying the canvas.

Return ONLY the exact string of the intent (e.g. CREATE_SYSTEM).`
    );

    const response = await llm.invoke([intentPrompt, lastMessage]);
    
    // We append a system message indicating the path, but the graph router will use the string directly.
    return { messages: [new AIMessage({ content: `[INTENT:${response.content.toString().trim()}]` })] };
  };

  // Node: Chat Agent (No Tools)
  const chatAgent = async (state: typeof GraphAnnotation.State) => {
    const response = await llm.invoke(state.messages);
    return { messages: [response] };
  };

  // Node: System Creator / Editor (With Tools)
  const canvasAgent = async (state: typeof GraphAnnotation.State) => {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  };

  // Router
  const routeIntent = (state: typeof GraphAnnotation.State) => {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) return "chatAgent";
    
    const content = lastMessage.content.toString();
    if (content.includes("[INTENT:CREATE_SYSTEM]") || content.includes("[INTENT:EDIT_SYSTEM]")) {
      return "canvasAgent";
    }
    return "chatAgent";
  };
  
  const shouldContinue = (state: typeof GraphAnnotation.State) => {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && "tool_calls" in lastMessage && Array.isArray(lastMessage.tool_calls) && lastMessage.tool_calls.length > 0) {
      return "tools";
    }
    return "__end__";
  };

  const workflow = new StateGraph(GraphAnnotation)
    .addNode("intentIdentifier", intentIdentifier)
    .addNode("chatAgent", chatAgent)
    .addNode("canvasAgent", canvasAgent)
    .addNode("tools", customToolNode)
    
    .addEdge("__start__", "intentIdentifier")
    .addConditionalEdges("intentIdentifier", routeIntent)
    
    .addEdge("chatAgent", "__end__")
    
    .addConditionalEdges("canvasAgent", shouldContinue)
    
    .addEdge("tools", "canvasAgent");

  return workflow.compile();
}

export const systemPromptTemplate = (canvasStateContext: string) =>{

  return `You are an expert AI software architect and UI designer. 
    Your job is to assist the user in designing their system using the provided tools.
    You are currently viewing the system design canvas.

    If working on a Database Schema, use 'entity' nodes and populate 'data.columns' with an array of { name, type, isPrimaryKey, isForeignKey, isNotNull, isUnique }. Use 'group' nodes to group tables, and 'foreign-key' edges to connect tables, specifying 'sourceCardinality' and 'targetCardinality' (1 or N) in 'data'.

    When adding messaging infrastructure, choose the correct node type based on the messaging pattern:
    - Use 'sqs' for Amazon SQS message queues. Store queues in 'data.queues'. Set broker settings under 'data.sqsBroker'. Valid fields: delivery, failureHandling, and sqsBroker: { visibilityTimeout, delay, fifo: boolean }.
    - Use 'redis-pubsub' for Redis Pub/Sub channels. Store channels in 'data.channels'. Valid fields: delivery, and redisPubSubBroker.
    - Use 'kafka' for Apache Kafka messaging brokers. Store topics in 'data.topics'. Set broker configuration under 'data.kafkaBroker' (partitions, replication, compression, ttl, batchSize). Valid fields: delivery, ordering, retention.
    - Use 'redis-streams' for Redis Streams messaging brokers. Store streams in 'data.streams'. Set broker configuration under 'data.redisBroker' (consumerGroup). Valid fields: delivery, ordering, retention.
    NEVER mix implementation fields across node types.

    Current Canvas State:
    ${canvasStateContext}

    Be concise in your textual responses. Prefer using tools to update the canvas to match the user's intent.`;
}
