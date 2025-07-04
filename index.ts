import inspector from "inspector";
import z from "zod";
import {
  Annotation,
  END,
  LangGraphRunnableConfig,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

function registerInspector(port = 9222) {
  console.log(`Process running at pid ${process.pid}`);
  let inspectingEnabled = false;
  process.on("SIGUSR2", async () => {
    if (!inspectingEnabled) {
      inspector.open(port, "0.0.0.0");
      console.log(`${inspector.url()}`);
      inspectingEnabled = true;
    } else {
      inspector.close();
      inspectingEnabled = false;
    }
  });
}

export const State = Annotation.Root({
  ...MessagesAnnotation.spec,
  toolCall: Annotation<boolean>,
});

const SYS_PROMPT = `You are a skilled course creator. You must write a 10 module course outline for the given user request in markdown format.

## Instructions
- Each module should contain a primary and secondary topic.
- A module is made up of 3-5 lessons.
- The course should be 100% accurate and factually correct.
{toolAddendum}`;

async function call(
  state: typeof State.State,
  _config: LangGraphRunnableConfig,
  model: string,
  streaming: boolean
) {
  const llm = new ChatOpenAI({
    model: model,
    disableStreaming: !streaming,
  });

  const generateOutline = {
    name: "generateOutline",
    description: "generate the outline",
    schema: z
      .object({
        outline: z.string(),
      })
      .describe("The outline of the course in markdown format."),
  };

  let toolAddendum = "";
  let withTools;

  if (state.toolCall) {
    withTools = llm.bindTools([generateOutline], {
      tool_choice: generateOutline.name,
    });
    toolAddendum = `- IMPORTANT: You must use the generateOutline tool to notify the user of the outline.`;
  }

  const messages = [
    new SystemMessage(SYS_PROMPT.replace("{toolAddendum}", toolAddendum)),
    new HumanMessage(
      "I am an aspiring PokeBall technician. My first exam is next week. How do Pokeballs function?"
    ),
  ];

  const result = await (withTools ?? llm).invoke(messages);

  if (state.toolCall && !result.tool_calls?.length) {
    throw new Error("Tool call failed");
  }

  return {
    messages: [result],
  };
}

function makeGraph(model: string, streaming: boolean) {
  const graph = new StateGraph(State)
    .addNode("call", (state, config) => call(state, config, model, streaming), {
      retryPolicy: { retryOn: () => false },
    })
    .addEdge(START, "call")
    .addEdge("call", END);

  return graph.compile({
    name: `Perf Issue ${model} ${streaming ? "streaming" : "non-streaming"}`,
  });
}

registerInspector(9222);

export const nonStreamingGraph = makeGraph("o3", false);
export const streamingGraph = makeGraph("o3", true);
