# Neurohands local model chat and LangGraph test

**Agent tools are now available in separate graphs.** Follow [the local agent guide](LOCAL_AGENT_LAB.md) for Concierge, Aria, Jarvis and the benchmark. This document describes the `neurohands_chat` comparison baseline and its installation. The prepared laptop now uses the locally installed Ollama desktop runtime on port `11434`.

This lab lets you test one AI model on your computer through LangSmith Studio. The configured primary model is `qwen3.5:4b`, run by Ollama. It can answer questions from its training and the recent messages included in your test conversation. It has no internet search, business tools, customer documents, or connection to the LINE Official Account.

```text
You type in Studio
        ↓
LangGraph on your laptop
        ↓
Ollama runs qwen3.5:4b on your laptop
        ↓
The reply appears in Studio

Separate optional check:
lab:chat:trace → one fixed synthetic model test → LangSmith record
```

LangGraph controls the workflow. Ollama runs the AI model. LangSmith records test steps when explicitly requested. Your LangSmith key is for monitoring; it is not a model key. This lab does not train a new model or change how Jarvis and Aria answer LINE messages.

## Choose the right test

| What you want to check | Use | What it does |
| --- | --- | --- |
| Talk to the local AI model | Studio → `neurohands_chat` → **Chat** | Sends your test conversation to the local Ollama model |
| Measure one repeatable model reply | `npm run lab:chat` | Runs a fixed synthetic prompt and reports its reply, token use and elapsed time |
| Check model trace recording | `npm run lab:chat:trace` | Runs that fixed synthetic model test, records it in LangSmith and checks that the record was saved |
| Check the workflow without a model | `npm run lab:check` | Runs the original deterministic echo with no model request |
| Check recording without a model | `npm run lab:trace` | Records the original fixed synthetic echo in LangSmith |

The original Studio graph `neurohands_test` only repeats the input. Select **`neurohands_chat`** for an actual model conversation.

## 1. Find the project folder

Open the Neurohands folder containing `package.json`. In Windows File Explorer, right-click an empty space in that folder and choose **Open in Terminal**. Enter the commands below in that terminal, not in LINE or a browser address bar.

The project uses Node.js 24. For a fresh checkout, install the locked project dependencies once:

```powershell
npm ci
```

Ollama and the downloaded model are separate local software, stored outside this repository. Copying the GitHub repository does not copy the model. If Ollama has not already been prepared on another computer, install it from [Ollama](https://ollama.com/download) and download the model using:

```powershell
ollama pull qwen3.5:4b
```

Downloading the model requires internet access and disk space. Running it uses your computer's memory and processing power. This local model route makes no paid model API request.

## 2. Check the private settings file

Use the existing `.env.langgraph` file in the Neurohands folder. Do not replace it if your LangSmith key is already saved there. For a fresh checkout only, create it from the empty template:

```powershell
if (-not (Test-Path -LiteralPath .env.langgraph)) {
  Copy-Item -LiteralPath .env.langgraph.example -Destination .env.langgraph
}
```

Open `.env.langgraph` in a text editor. The key belongs on the same line as `LANGSMITH_API_KEY=`, immediately after the equals sign. Keep it private. The file is plain text named exactly `.env.langgraph`, without an extra `.txt` ending.

```env
LANGSMITH_API_KEY=YOUR_PRIVATE_LANGSMITH_KEY
LANGSMITH_PROJECT=neurohands-local-test
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_WORKSPACE_ID=
LANGSMITH_TRACING=false
LAB_OLLAMA_MODEL=qwen3.5:4b
LAB_OLLAMA_BASE_URL=http://127.0.0.1:11434
LAB_OLLAMA_EXE=
```

`LAB_OLLAMA_EXE` is optional. When a local Ollama executable has been configured or found in the standard install location, the lab can start it automatically if it is not already running. A prepared setup may already contain its full path; preserve that value. This setting does not install Ollama or download a missing model.

Use the LangSmith endpoint for your workspace's region. The example is the US endpoint. A key covering multiple workspaces may also need a workspace ID. Check these in LangSmith Settings if trace verification fails.

Keep `LANGSMITH_TRACING=false`. Automatic recording is off. The separate trace commands explicitly record only their fixed synthetic tests. Do not put keys in GitHub, documents, screenshots or chat messages.

## 3. Start Studio and chat with the model

1. In the terminal opened in the Neurohands folder, enter:

   ```powershell
   npm run lab:studio
   ```

2. Leave that terminal open. It runs the local development server on `127.0.0.1:2024` and can start the configured local Ollama runtime. You do not need a second terminal to start Ollama in the prepared setup.
3. Open [LangSmith Studio for the local server](https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024).
4. Select **`neurohands_chat`** in the graph selector. Select **Chat** in Studio.
5. Send this public test message:

   ```text
   Explain in three short sentences what an AI business assistant can do.
   ```

6. Wait for the model's reply. The first reply can be slower because the model needs to load into memory. It should produce an answer, not the old `Neurohands LangGraph received:` echo.
7. Send a follow-up in the same thread, such as `Make that answer shorter.` This tests whether it can use the recent conversation provided to it.
8. Start a **new thread** to begin a separate conversation without the old thread's context.

Use fictional or public examples while testing. The model has no approved company knowledge connected yet, so a fluent answer is not proof that business facts are correct.

The lab only passes a limited amount of recent conversation to the model. This is conversation context, not permanent customer memory or new training. The local development server's thread state is not a production backup system.

Closing the server terminal or turning off your laptop stops this local chat. **Gemini takeover is not connected yet.** Press **Ctrl+C** in the terminal when you want to stop Studio's local server. The separately started Ollama runtime can stay in the background; its model unloads after five minutes of inactivity by default.

## 4. Measure a repeatable model test

Open another terminal in the same Neurohands folder and run:

```powershell
npm run lab:chat
```

The command uses one fixed synthetic prompt. Read its output for the model's reply, reported token counts and elapsed time. Tokens measure how much text the model processed or generated. Elapsed time measures how long that run took; it can include model loading and other overhead.

Run the same check again if you want to compare a first load with an already loaded model. Do not treat a single reply as proof of reasoning quality, safe tool use, CPU capacity, memory capacity or the number of customers your platform can support. Those need separate tests.

## 5. Save one model test to LangSmith

After the private LangSmith key is configured, run:

```powershell
npm run lab:chat:trace
```

This runs the fixed synthetic model test and verifies that its trace was saved. It does not take arbitrary Studio conversations or customer documents and upload them as this test's input.

Open LangSmith, select the matching workspace, and open the tracing project **`neurohands-local-test`**. Inspect the run identified by the command's report. Check the input, output and recorded steps. A reply appearing locally does not by itself prove that LangSmith saved the trace; look for the verification result.

Tracing uses LangSmith's tracing allowance even though the model runs locally. Keep the free-plan limit in mind before increasing test volume.

## 6. Understand the Studio warnings

Studio may show an API-key or tracing/server compatibility warning in this lab. Automatic tracing is intentionally disabled, and the current Studio configuration does not provide the full built-in trace view. A warning alone does not prove that the saved key is invalid.

Use `npm run lab:trace` to check the monitoring connection without a model, or `npm run lab:chat:trace` to check the synthetic model recording. These commands verify saved records separately from Studio's built-in viewer.

If trace verification fails, check the key, its expiry, region and workspace ID. If chat fails but the echo works, check that Ollama is running locally and that `qwen3.5:4b` is downloaded. If Studio is disconnected, check that the `lab:studio` terminal is still running, then reopen the local Studio link.

## Current primary-model smoke test: 18 September 2026

The private local configuration now selects `qwen3.5:4b` on the Ollama desktop
runtime at `127.0.0.1:11434`. The bounded `npm run lab:chat` path disables
thinking output, permits one model call, limits generation to 256 tokens, and
does not upload the run to LangSmith.

The fixed fictional arithmetic prompt returned the correct **120 baht** answer
in 10,947 ms. Ollama reported 144 input tokens, 21 output tokens and 165 total
tokens. The exact model digest and reservation are stored in
`artifacts/benchmarks/2026-09-18-qwen35-smoke.json`.

`llama3.2:3b` and `qwen3-embedding:0.6b` are installed, but installation alone
does not establish checker quality, retrieval quality, workflow integration or
production readiness. They remain disconnected candidates until separately
tested against an accepted baseline.

## Previous verified local-model baseline: 16 September 2026

The model was installed and tested on this Windows laptop (AMD Ryzen 7 5825U, 15.4 GiB usable RAM). The official Ollama 0.34.1 runtime runs on loopback with cloud features disabled. Its CPU-capable files were extracted from the official Windows archive, verified against archive CRC values, and its executable has a valid Ollama Inc. signature. Unneeded CUDA libraries were excluded. Runtime files and model weights are outside the repository.

- Model: `qwen3:1.7b`, Q4_K_M, manifest digest `8f68893c685c3ddff2aa3fffce2aa60a30bb2da65ca488b61fff134a4d1730e7`. Ollama verified the model download digest.
- The fixed notebook test returned **120 baht** correctly. First graph invocation: **3,727 ms**. Repeat with explicit tracing: **1,015 ms**, excluding subsequent trace verification. Each used **145 input + 22 output = 167 tokens**. These are two individual measurements, not a performance benchmark.
- LangSmith root run `30c78cee-b1e1-4381-8bd1-7b759913b427` was read back with completed output and no error. The LangSmith project page visibly showed the answer and 167 tokens.
- Studio's **Chat** view returned **120 baht** and then correctly recalled the fictional company **Mango Works** in the same thread. Thread: `01a0aac8-6334-7386-bacd-1f9daf69ea38`.
- Studio sends typed input as text blocks. The graph now accepts those text-only blocks, and a regression test covers the exact observed request format.
- A loaded-model snapshot showed CPU inference, zero GPU allocation, 4,096 context tokens, and approximately **1,901 MiB combined working set** for Ollama and its model runner. This excludes Windows, Node.js and the browser; it is not a system-wide peak measurement.
- **200 automated tests**, code checks and the website build passed. No paid inference, production deployment or live LINE test was performed.

This proves local model chat, one follow-up context check and explicit synthetic trace recording. It does not establish general reasoning quality, business accuracy, tool execution, production reliability or automatic Studio tracing.

## Previously verified: connection-only lab, 16 September 2026

These are the earlier echo-lab results, not measurements of the new model chat:

- The offline graph returned the expected echo with zero model calls and zero network requests.
- The local API returned HTTP 200 and the expected echo on `127.0.0.1:2024`.
- Two fixed synthetic connection checks were saved to `neurohands-local-test` and read back successfully. The final script used the current trace retrieval API.
- The LangSmith workspace showed the free Developer plan with unused tracing allowance before those checks. No model inference, payment, plan change or production deployment was performed during them.
- The application's then-existing 191 tests, code checks and website build passed.
- Studio startup, Ctrl+C shutdown and restart were checked on Windows. The private key file and local server state were ignored by Git.

The earlier results above concern the echo workflow. Real model results are recorded separately in the preceding section.

## What is still outside this lab

- Internet search, MCP connectors and business tool execution.
- Company-document retrieval and lasting customer memory.
- Automatic Ollama-to-Gemini fallback when the laptop is unavailable.
- LINE integration, production deployment and customer access controls for this new graph.
- Multi-agent teams, model training and automatic recovery across platforms.

The immediate test is one local model in Studio. Once its behavior is measured, the next additions can be evaluated one at a time.

## Where everything belongs

| Place | Its purpose |
| --- | --- |
| Neurohands project folder | Code and commands for this lab |
| `.env.langgraph` | Private monitoring key and local model settings; ignored by Git |
| `.env.langgraph.example` | Empty settings template safe to store on GitHub |
| `src/agent/graph.mjs` | Original deterministic echo graph |
| `src/agent/chat.mjs` | Real local-model chat graph, exported as `graph` |
| `langgraph.json` | Graph names and their code locations for Studio |
| Local Ollama installation and model store | Runs and stores the model outside this repository |
| `.langgraph_api` | Local development-server state; ignored by Git |
| LangSmith website | View the graph and explicitly recorded synthetic traces |
| GitHub | Store code and templates without real keys or model downloads |
| Railway | Existing production application; this local chat is not deployed there |

## Official references

- [LangGraph JavaScript overview](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [Run a local LangGraph server](https://docs.langchain.com/oss/javascript/langgraph/local-server)
- [LangSmith Studio and tracing](https://docs.langchain.com/oss/javascript/langgraph/studio)
- [LangSmith API keys, regional endpoints and workspaces](https://docs.langchain.com/langsmith/create-account-api-key)
- [Ollama](https://ollama.com/)
