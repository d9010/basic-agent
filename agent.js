import fs from "node:fs/promises";
import path from "node:path";

class Agent {
  constructor({
    url,
    model,
    workspace = "./workspace",
    apiKey = "",
    maxTurns = 10
  }) {
    this.url = url;
    this.model = model;
    this.workspace = path.resolve(workspace);
    this.apiKey = apiKey;
    this.maxTurns = maxTurns;

    this.systemPrompt = `
You are a very small educational file agent.

You have only two software tools:

1. read_file
   Read an entire UTF-8 text file.
   Request:
   {"type":"tool","tool":"read_file","path":"relative/path.txt"}

2. write_file
   Replace an entire UTF-8 text file.
   Request:
   {"type":"tool","tool":"write_file","path":"relative/path.txt","content":"full file content"}

When the task is finished:
{"type":"final","content":"your answer to the user"}

Rules:
- Output EXACTLY one valid JSON object and nothing else.\n- Inside JSON strings, escape newlines as \\n and tabs as \\t; never place raw line breaks inside a quoted JSON string.
- Use only the two tools above.
- Paths are relative to the workspace.
- Do not claim you read a file until read_file returns its contents.
- Do not claim you wrote a file until write_file confirms it.
- If you need more information, request another tool.
- Keep the final answer concise.
`.trim();

    this.context = [];
  }

  print(title, value) {
    console.log("\n" + "=".repeat(80));
    console.log(title);
    console.log("=".repeat(80));
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }

  safePath(relativePath) {
    const fullPath = path.resolve(this.workspace, relativePath);
    const prefix = this.workspace + path.sep;

    if (fullPath !== this.workspace && !fullPath.startsWith(prefix)) {
      throw new Error(`Path is outside workspace: ${relativePath}`);
    }

    return fullPath;
  }

  async readFile(relativePath) {
    return await fs.readFile(this.safePath(relativePath), "utf8");
  }

  async writeFile(relativePath, content) {
    const fullPath = this.safePath(relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
    return `Wrote ${content.length} characters to ${relativePath}`;
  }

  parseAction(text) {
    const value = text.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    // First try strict JSON.
    try {
      return JSON.parse(value);
    } catch (firstError) {
      // Small local models sometimes put literal newlines/tabs inside a JSON
      // string instead of escaping them as \n / \t. That is invalid JSON even
      // though the intended action is obvious. Repair only control characters
      // that occur *inside quoted JSON strings*, then parse again.
      let fixed = "";
      let inString = false;
      let escaped = false;

      for (const ch of value) {
        if (!inString) {
          fixed += ch;
          if (ch === '"') inString = true;
          continue;
        }

        if (escaped) {
          fixed += ch;
          escaped = false;
          continue;
        }

        if (ch === "\\") {
          fixed += ch;
          escaped = true;
          continue;
        }

        if (ch === '"') {
          fixed += ch;
          inString = false;
          continue;
        }

        const code = ch.charCodeAt(0);
        if (code < 0x20) {
          if (ch === "\n") fixed += "\\n";
          else if (ch === "\r") fixed += "\\r";
          else if (ch === "\t") fixed += "\\t";
          else if (ch === "\b") fixed += "\\b";
          else if (ch === "\f") fixed += "\\f";
          else fixed += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
          fixed += ch;
        }
      }

      try {
        console.log("\n[parser] Repaired unescaped control characters in LLM JSON.");
        return JSON.parse(fixed);
      } catch {
        throw firstError;
      }
    }
  }

  async callLLM() {
    const request = {
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        ...this.context
      ],
      temperature: 0,
      stream: false
    };

    this.print("SYSTEM PROMPT", this.systemPrompt);
    this.print("STORED CONTEXT BEFORE THIS LLM TURN", this.context);
    this.print("EXACT REQUEST SENT TO LLM", request);

    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(request)
    });

    const rawText = await response.text();
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}\n${rawText}`);

    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch {
      throw new Error(`LLM did not return JSON HTTP data:\n${rawText}`);
    }

    this.print("RAW HTTP RESPONSE FROM LLM SERVER", raw);

    const content = raw?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("Expected choices[0].message.content from an OpenAI-compatible chat completion.");
    }

    this.print("EXACT ASSISTANT CONTENT RETURNED BY LLM", content);

    this.context.push({ role: "assistant", content });
    return this.parseAction(content);
  }

  async executeTool(action) {
    this.print("HARNESS PARSED THIS ACTION", action);

    let result;
    if (action.tool === "read_file") {
      result = await this.readFile(action.path);
    } else if (action.tool === "write_file") {
      result = await this.writeFile(action.path, action.content ?? "");
    } else {
      throw new Error(`Unknown tool: ${action.tool}`);
    }

    const toolResult = {
      type: "tool_result",
      tool: action.tool,
      path: action.path,
      result
    };

    this.print("ORDINARY NODE.JS TOOL RESULT", toolResult);

    this.context.push({
      role: "user",
      content: JSON.stringify(toolResult)
    });

    this.print("UPDATED STORED CONTEXT", this.context);
  }

  async run(userRequest) {
    this.context = [{ role: "user", content: userRequest }];
    this.print("USER REQUEST", userRequest);

    for (let turn = 1; turn <= this.maxTurns; turn++) {
      this.print(`AGENT LOOP — TURN ${turn}`, "Calling the LLM...");

      const action = await this.callLLM();

      if (action.type === "final") {
        this.print("NO TOOL CALL — FINAL RESPONSE TO USER", action.content);
        return action.content;
      }

      if (action.type !== "tool") {
        throw new Error('Expected action.type to be "tool" or "final".');
      }

      await this.executeTool(action);
      console.log("\n↻ Tool finished. The loop now sends the UPDATED context to the LLM again.");
    }

    throw new Error(`Stopped after ${this.maxTurns} turns.`);
  }
}

const url = process.env.LLM_URL || "http://localhost:1234/v1/chat/completions";
const model = process.env.LLM_MODEL || "REPLACE_WITH_YOUR_LOADED_MODEL_ID";

const question = process.argv.slice(2).join(" ") || `Read project.txt and team.txt.
Decide whether the project is ready to launch.
Write launch-status.txt with:
- Ready: yes/no
- Blocker
- Next action
- Owner
Then tell me what you wrote.`;

if (model === "REPLACE_WITH_YOUR_LOADED_MODEL_ID") {
  console.error(`
Set LLM_MODEL to the model identifier loaded in LM Studio.

Example:
  LLM_MODEL="your-model-id" node agent.js
`);
  process.exit(1);
}

const agent = new Agent({
  url,
  model,
  workspace: "./workspace",
  apiKey: process.env.LLM_API_KEY || ""
});

agent.run(question).catch(error => {
  console.error("\nAGENT ERROR\n", error);
  process.exitCode = 1;
});
