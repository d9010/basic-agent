# Minimal Node.js File Agent

This is an intentionally small educational agent.

It has:
- one `Agent` class
- one local LLM chat-completion URL
- one in-memory conversation context
- `read_file`
- `write_file`
- a simple JSON action protocol
- verbose logging at every agent-loop boundary

There are no npm dependencies. It uses Node.js built-in `fetch`, `fs`, and `path`.

## 1. Requirements

Use Node.js 18+ and start an LM Studio local server.

The example uses LM Studio's OpenAI-compatible Chat Completions route:

    http://localhost:1234/v1/chat/completions

## 2. Configure the model

I tested using this command on MacOS with Node.js installed.

    LLM_MODEL="qwen/qwen3-coder-30b" node agent.js

Set the model ID that LM Studio expects:

    export LLM_MODEL="your-loaded-model-id"

Optionally change the completion URL:

    export LLM_URL="http://localhost:1234/v1/chat/completions"

If your LM Studio server requires a token:

    export LLM_API_KEY="your-token"

## 3. Run the included demo

From this directory:

    node agent.js

The default task asks the agent to read `project.txt` and `team.txt`, determine launch readiness, write `launch-status.txt`, and report back.

A reasonable loop is:

    user request
      ↓
    LLM asks read_file("project.txt")
      ↓
    Node reads the file
      ↓
    tool result is appended to context
      ↓
    LLM asks read_file("team.txt")
      ↓
    Node reads it
      ↓
    LLM asks write_file("launch-status.txt", ...)
      ↓
    Node writes it
      ↓
    LLM returns a final response

## 4. Ask another question

    node agent.js "Read project.txt and summarize it. Save the summary to summary.txt."

## Teaching detail

This demo intentionally does NOT rely on the provider's native tool-calling API.
The LLM simply returns JSON text such as:

    {"type":"tool","tool":"read_file","path":"project.txt"}

The Node.js harness parses that normal model response, executes ordinary software,
adds the result to the context, and calls the model again.
