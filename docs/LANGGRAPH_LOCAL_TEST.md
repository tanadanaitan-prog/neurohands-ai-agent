# Neurohands local LangGraph test

This lab checks that a small workflow runs on your computer and that LangSmith can record one synthetic test. It does not call an AI model, train a model, or change how Jarvis and Aria answer LINE messages.

```text
Your computer → LangGraph test → fixed test reply
                     ↓
          LangSmith (only when you run lab:trace)
```

LangGraph runs the workflow. LangSmith shows a record of its steps. A LangSmith key connects to that monitoring service; it is separate from a Gemini or other model key.

## Verified on 16 September 2026

- The offline graph returned its expected fictional response with zero model calls and zero network requests.
- The local API returned HTTP 200 and the expected response on `127.0.0.1:2024`.
- Two fixed synthetic connection checks were saved to `neurohands-local-test` and read back successfully. The final implementation uses the current trace retrieval API.
- The LangSmith workspace showed the free Developer plan with unused tracing allowance before these checks. No model inference, payment, plan change, or production deployment was performed.
- The application's existing 191 tests, code checks, and website build passed.
- Local Studio startup, Ctrl+C shutdown, and restart were checked on Windows. The private key file and local server state are ignored by Git.

These checks establish workflow execution and monitoring connectivity. Model reasoning, tool use, memory, automatic model fallback, and live LINE integration are not established by this lab.

## Where everything belongs

| Place | What belongs there |
| --- | --- |
| Project folder on your computer | The code and the commands below |
| `.env.langgraph` | Your private LangSmith key and local test settings; ignored by Git |
| `.env.langgraph.example` | An empty settings template that can be stored on GitHub |
| `src/agent/graph.mjs` | The small synthetic workflow |
| `langgraph.json` | The graph name and file location used by Studio |
| LangSmith website | Create the key and inspect the test trace |
| GitHub | Store code and templates, without the real key |
| Railway | Runs the existing production application; adding variables alone does not connect its agents to LangGraph |

The graph is named `neurohands_test`. Its export is `./src/agent/graph.mjs:graph`. The `.mjs` extension lets this lab use JavaScript imports while the existing application keeps its current module format.

## 1. Prepare the local settings

Use Node.js 24. Open a terminal in the Neurohands project folder, the folder containing `package.json`. If this is a fresh checkout, install its locked dependencies with `npm ci`.

Create the private settings file only if it does not already exist. In PowerShell:

```powershell
if (-not (Test-Path -LiteralPath .env.langgraph)) {
  Copy-Item -LiteralPath .env.langgraph.example -Destination .env.langgraph
}
```

Open `.env.langgraph` in a text editor. Paste the LangSmith key privately after `LANGSMITH_API_KEY=`. Keep these settings:

```env
LANGSMITH_API_KEY=YOUR_PRIVATE_LANGSMITH_KEY
LANGSMITH_PROJECT=neurohands-local-test
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_WORKSPACE_ID=
LANGSMITH_TRACING=false
```

Use the endpoint for your LangSmith region. The example above is the default US endpoint. A key covering multiple workspaces may also need your workspace ID. Both can be checked in LangSmith Settings. Do not paste the key into GitHub, this document, or a chat message.

Keep `LANGSMITH_TRACING=false`. The trace command explicitly sends its one fixed synthetic test; automatic tracing is unnecessary.

## 2. Check the workflow without an API

Run:

```powershell
npm run lab:check
```

This performs a deterministic echo check locally. It needs no API key and makes no model request. A pass confirms that the graph loads and returns the expected result. It does not measure AI reasoning or model token usage.

## 3. Verify one LangSmith trace

After entering your key, run:

```powershell
npm run lab:trace
```

This command sends one fixed synthetic test to LangSmith and verifies that its root run was saved. It does not send customer conversations, documents, or freeform prompts, and it makes no AI model request.

Open LangSmith, select the matching workspace, and open the tracing project `neurohands-local-test`. Inspect the run identified by the command's report. A successful local reply alone is not proof that the trace was saved; use the verification result.

If verification fails, check the key, its expiry, the regional endpoint, and the workspace ID. Correct the setting before running the command again. A LangSmith trace uses that service's tracing allowance even though this test makes no paid LLM call.

## 4. Open the workflow in Studio

Run:

```powershell
npm run lab:studio
```

The development server listens locally on `127.0.0.1:2024`, with automatic tracing forced off. Open [LangSmith Studio for this local server](https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024), select `neurohands_test`, and try a made-up message:

```json
{
  "messages": [
    { "role": "user", "content": "Hello Neurohands test" }
  ]
}
```

Keep the terminal running while using Studio. Press **Ctrl+C** in that terminal to stop the server. This local development server is for testing and is not the Railway production server. Its local state is kept out of Git in `.langgraph_api`.

## What comes next

This lab prepares the workflow and monitoring foundation. It does not connect the production LINE route to the graph, enable automatic production traces, or establish persistent customer memory.

The next separate milestone is to connect one real model and measure a small set of tasks. Ollama/Gemini selection, timeouts, fallback rules, approved tools, and LINE integration need their own implementation and tests. Do not treat this synthetic echo as evidence that those features work.

## Official references

- [LangGraph JavaScript overview and graph example](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [Run a local LangGraph server](https://docs.langchain.com/oss/javascript/langgraph/local-server)
- [LangSmith Studio and disabling automatic tracing](https://docs.langchain.com/oss/javascript/langgraph/studio)
- [LangSmith API keys, regional endpoints, and workspaces](https://docs.langchain.com/langsmith/create-account-api-key)
- [LangSmith tracing configuration](https://docs.langchain.com/langsmith/trace-with-langchain)
