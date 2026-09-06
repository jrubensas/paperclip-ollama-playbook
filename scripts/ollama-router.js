const http = require('http');

const BACKEND_PORT = 11435;
const LISTEN_PORT = 11434;

function extractToolCalls(text) {
  if (!text || typeof text !== 'string') return [];
  const calls = [];
  const trimmed = text.trim();

  function tryAddCall(raw) {
    if (!raw) return false;
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw.trim()) : raw;
      if (Array.isArray(obj)) {
        let addedAny = false;
        for (const item of obj) {
          if (item && item.name && (item.arguments !== undefined || item.parameters !== undefined)) {
            calls.push({ name: item.name, arguments: item.arguments || item.parameters || {} });
            addedAny = true;
          }
        }
        return addedAny;
      }
      if (obj && obj.name && (obj.arguments !== undefined || obj.parameters !== undefined)) {
        calls.push({ name: obj.name, arguments: obj.arguments || obj.parameters || {} });
        return true;
      }
    } catch {}
    return false;
  }

  // 1. Match <tools>...</tools> or <tool_call>...</tool_call>
  const tagMatches = [...trimmed.matchAll(/<(?:tools|tool_call)>([\s\S]*?)<\/(?:tools|tool_call)>/g)];
  for (const m of tagMatches) {
    const inner = m[1].trim();
    let lineFound = false;
    for (const line of inner.split('\n')) {
      const lt = line.trim();
      if (lt.startsWith('{') && lt.endsWith('}')) {
        if (tryAddCall(lt)) lineFound = true;
      }
    }
    if (!lineFound) {
      tryAddCall(inner);
    }
  }
  if (calls.length > 0) return calls;

  // 2. Match ```json ... ``` codeblocks
  const codeBlockMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
  for (const cb of codeBlockMatches) {
    const inner = cb[1].trim();
    let lineFound = false;
    for (const line of inner.split('\n')) {
      const lt = line.trim();
      if (lt.startsWith('{') && lt.endsWith('}')) {
        if (tryAddCall(lt)) lineFound = true;
      }
    }
    if (!lineFound) {
      tryAddCall(inner);
    }
  }
  if (calls.length > 0) return calls;

  // 3. Match individual lines of JSON
  for (const line of trimmed.split('\n')) {
    const lt = line.trim();
    if (lt.startsWith('{') && lt.endsWith('}')) {
      tryAddCall(lt);
    }
  }
  if (calls.length > 0) return calls;

  // 4. Single full JSON string
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    tryAddCall(trimmed);
  }
  if (calls.length > 0) return calls;

  // 5. Match bash command=... or bash(command=...) without truncating at unescaped inner quotes
  for (const line of trimmed.split('\n')) {
    const lt = line.trim();
    const bMatch = lt.match(/^(?:bash\s+command=|bash\(\s*command=)\s*(.*)$/);
    if (bMatch) {
      let cmd = bMatch[1].trim();
      if (cmd.endsWith(')')) cmd = cmd.slice(0, -1).trim();
      if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
        cmd = cmd.slice(1, -1).trim();
      }
      if (cmd && !calls.some(c => c.name === 'bash' && c.arguments.command === cmd)) {
        calls.push({ name: 'bash', arguments: { command: cmd } });
      }
    }
  }

  // 6. Match ```bash ... ``` codeblocks with commands
  const bashBlocks = [...trimmed.matchAll(/```bash\s*([\s\S]*?)\s*```/g)];
  for (const bb of bashBlocks) {
    const blockContent = bb[1].trim();
    if (blockContent && !calls.some(c => c.name === 'bash' && c.arguments.command === blockContent)) {
      calls.push({ name: 'bash', arguments: { command: blockContent } });
    }
  }

  // 7. Match bare paperclip-helper lines
  for (const line of trimmed.split('\n')) {
    const lt = line.trim();
    if (lt.startsWith('paperclip-helper ') && !lt.startsWith('bash ')) {
      if (!calls.some(c => c.name === 'bash' && c.arguments.command === lt)) {
        calls.push({ name: 'bash', arguments: { command: lt } });
      }
    }
  }

  // 8. Match tool_name { ...JSON... } with balanced braces (e.g. todowrite { "todos": [...] }, write { ... }, etc.)
  function extractBalancedBraces(str, startIdx) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIdx; i < str.length; i++) {
      const ch = str[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"' && !escape) {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            return { json: str.slice(startIdx, i + 1), endIdx: i };
          }
        }
      }
    }
    return null;
  }

  const headerRegex = /(?:^|\n)\s*([a-zA-Z0-9_.-]+)\s*\{/g;
  let match;
  while ((match = headerRegex.exec(trimmed)) !== null) {
    const toolName = match[1].trim();
    if (['if', 'for', 'while', 'switch', 'catch', 'function', 'const', 'let', 'var'].includes(toolName)) continue;
    const openBraceIdx = match.index + match[0].lastIndexOf('{');
    const res = extractBalancedBraces(trimmed, openBraceIdx);
    if (res) {
      try {
        const args = JSON.parse(res.json);
        if (typeof args === 'object' && args !== null) {
          calls.push({ name: toolName, arguments: args });
        }
      } catch {}
    }
  }

  return calls;
}

const server = http.createServer((req, res) => {
  const url = req.url;
  const method = req.method;

  // Simple GET pass-throughs
  if (method === 'GET') {
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: BACKEND_PORT,
      path: url,
      method: 'GET',
      headers: { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}` }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    proxyReq.end();
    return;
  }

  // Handle POST (chat completions, generate, etc.)
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const bodyStr = Buffer.concat(chunks).toString();
    let parsed = null;
    try {
      parsed = JSON.parse(bodyStr);
    } catch {}

    if (!parsed) {
      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: BACKEND_PORT,
        path: url,
        method: method,
        headers: { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}` }
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.write(bodyStr);
      proxyReq.end();
      return;
    }

    // Force model to original 32B
    parsed.model = "qwen2.5-coder:32b";
    if (!parsed.keep_alive) {
      parsed.keep_alive = "24h";
    }

    const hasTools = Boolean(parsed.tools && Array.isArray(parsed.tools) && parsed.tools.length > 0);
    const clientWantsStream = Boolean(parsed.stream);

    console.log(`[router] ${method} ${url} model: ${parsed.model} stream: ${clientWantsStream} tools: ${hasTools ? parsed.tools.length : 0}`);

    // If request has tools, execute non-streaming to backend so we can reliably inspect tool calls
    if (hasTools) {
      parsed.stream = false;
    }

    const modifiedBody = JSON.stringify(parsed);

    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: BACKEND_PORT,
      path: url,
      method: method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${BACKEND_PORT}`,
        'content-length': Buffer.byteLength(modifiedBody)
      }
    }, (proxyRes) => {
      if (!hasTools) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        return;
      }

      const respChunks = [];
      proxyRes.on('data', c => respChunks.push(c));
      proxyRes.on('end', () => {
        const respStr = Buffer.concat(respChunks).toString();
        let respObj = null;
        try {
          respObj = JSON.parse(respStr);
        } catch {}

        if (!respObj || !respObj.choices || !respObj.choices[0]) {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(respStr);
          return;
        }

        const choice = respObj.choices[0];
        const content = choice.message?.content || "";
        let toolCalls = choice.message?.tool_calls || null;

        if (!toolCalls || toolCalls.length === 0) {
          const detected = extractToolCalls(content);
          if (detected.length > 0) {
            toolCalls = detected.map((call, idx) => ({
              id: `call_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}`,
              index: idx,
              type: "function",
              function: {
                name: call.name,
                arguments: typeof call.arguments === 'string'
                  ? call.arguments
                  : JSON.stringify(call.arguments)
              }
            }));
            console.log(`[router] Intercepted ${toolCalls.length} tool calls for model ${parsed.model}: ${toolCalls.map(t => t.function.name).join(', ')}`);
          }
        }

        function sanitizePathValue(val) {
          if (typeof val === 'string' && val.startsWith('/') && !val.startsWith('/home') && !val.startsWith('/tmp') && !val.startsWith('/run') && !val.startsWith('/var')) {
            return val.replace(/^\/+/, '');
          }
          return val;
        }

        function deepSanitizePaths(obj) {
          if (!obj || typeof obj !== 'object') return false;
          let changed = false;
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string') {
              const cleaned = sanitizePathValue(v);
              if (cleaned !== v) {
                obj[k] = cleaned;
                changed = true;
              }
            } else if (typeof v === 'object' && v !== null) {
              if (deepSanitizePaths(v)) changed = true;
            }
          }
          return changed;
        }

        // Sanitize paths with leading slashes (e.g. "/ARCHITECTURE_PLAN.md" -> "ARCHITECTURE_PLAN.md")
        // forcing any absolute root path to be relative to the active workspace cwd
        if (toolCalls && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            if (!tc || !tc.function) continue;
            try {
              let args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
              if (deepSanitizePaths(args)) {
                tc.function.arguments = JSON.stringify(args);
                console.log(`[router] Deep-sanitized relative path in tool call ${tc.function.name}: ${tc.function.arguments}`);
              }
            } catch {}
          }
        }

        if (clientWantsStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          const chunkId = respObj.id || `chatcmpl-${Date.now()}`;
          const modelName = respObj.model || parsed.model;

          if (toolCalls && toolCalls.length > 0) {
            const c1 = {
              id: chunkId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: modelName,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: null,
                    tool_calls: toolCalls
                  },
                  finish_reason: null
                }
              ]
            };
            res.write(`data: ${JSON.stringify(c1)}\n\n`);

            const c2 = {
              id: chunkId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: modelName,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "tool_calls"
                }
              ]
            };
            res.write(`data: ${JSON.stringify(c2)}\n\n`);
            res.write(`data: [DONE]\n\n`);
            res.end();
          } else {
            const c1 = {
              id: chunkId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: modelName,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: content
                  },
                  finish_reason: null
                }
              ]
            };
            res.write(`data: ${JSON.stringify(c1)}\n\n`);

            const c2 = {
              id: chunkId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: modelName,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: choice.finish_reason || "stop"
                }
              ]
            };
            res.write(`data: ${JSON.stringify(c2)}\n\n`);
            res.write(`data: [DONE]\n\n`);
            res.end();
          }
        } else {
          if (toolCalls && toolCalls.length > 0) {
            choice.message.tool_calls = toolCalls;
            choice.message.content = "";
            choice.finish_reason = "tool_calls";
          }
          const out = JSON.stringify(respObj);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(out)
          });
          res.end(out);
        }
      });
    });

    proxyReq.setTimeout(0);

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    proxyReq.write(modifiedBody);
    proxyReq.end();
  });
});

// Disable server timeouts to support heavy 32B model inference and request queuing
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 600000;

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`Ollama 32B Dual-GPU Tool Proxy listening on 127.0.0.1:${LISTEN_PORT} -> backend :${BACKEND_PORT}`);
});
