// A deterministic connection check, not an LLM or a business agent.
// No production imports, tools, credentials, or external requests belong here.
import { StateSchema, MessagesValue, StateGraph, START, END } from "@langchain/langgraph";

const State = new StateSchema({ messages: MessagesValue });

async function testAgent(state) {
  const lastMessage = state.messages.at(-1);
  const input = typeof lastMessage?.content === "string" ? lastMessage.content : "test message";
  return {
    messages: [{ role: "ai", content: `Neurohands LangGraph received: ${input}` }],
  };
}

export const graph = new StateGraph(State)
  .addNode("test_agent", testAgent)
  .addEdge(START, "test_agent")
  .addEdge("test_agent", END)
  .compile();
