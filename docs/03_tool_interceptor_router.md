# 03. O Roteador Interceptador de Ferramentas (`ollama-router.js`)

Este documento documenta a arquitetura, as razões de projeto e os algoritmos do **Ollama Tool Interceptor Proxy**, uma das peças mais críticas desenvolvidas para viabilizar agentes autônomos com LLMs locais.

---

## 1. O Problema: Chamada de Ferramentas (Tool Calling) em Modelos Locais

Modelos como `qwen2.5-coder:32b` estão entre os melhores modelos de código abertos do mundo. No entanto, sua capacidade de chamada de ferramentas (Function Calling) difere substancialmente dos modelos proprietários da OpenAI (GPT-4o) ou Anthropic (Claude 3.5 Sonnet):

1. **Variação de Sintaxe sob Pressão de Contexto**:
   Quando submetido a longos históricos de conversa, instruções complexas de sistema e dezenas de esquemas JSON de ferramentas, o modelo frequentemente **não preenche o campo estruturado nativo `tool_calls`** da API OpenAI. Em vez disso, ele "conversa" e cospe a chamada no próprio texto da mensagem (`message.content`), em múltiplos formatos diferentes:
   - Formato pseudo-CLI: `bash command="paperclip-helper done ..."`
   - Tags XML: `<tool_call>{"name": "bash", "arguments": {...}}</tool_call>` ou `<tools>...</tools>`
   - Blocos de código Markdown: ````bash paperclip-helper done ... ````
   - Blocos JSON de código: ````json {"name": "read_file", "path": "..."} ````
   - Invocação estilo C/Rust: `todowrite { "todos": [...] }` ou `write { "filePath": "...", "content": "..." }`
   - Linhas avulsas de JSON.

2. **A Reação do OpenCode e Paperclip**:
   Ao receber uma resposta onde `tool_calls` está vazio (`null` ou `[]`), o OpenCode assume que o modelo apenas "falou" com o usuário. A ferramenta não é executada, o arquivo não é gravado, a tarefa não é criada, e o agente entra em um loop infinito achando que já executou o comando.

3. **Tentativa de Escrita no Diretório Raiz (`/`)**:
   Quando o modelo decide invocar uma ferramenta de escrita de arquivo, é comum ele fornecer caminhos absolutos baseados na raiz do projeto fictício (por exemplo: `"/src/routes/+page.svelte"` ou `"/ARCHITECTURE.md"`). No Linux, isso resolve para a raiz absoluta do sistema operacional (`/`), resultando em falhas de permissão (`EACCES: permission denied`) ou poluição de diretórios do sistema.

---

## 2. A Solução: Arquitetura do `ollama-router`

O `ollama-router.js` é um proxy HTTP reverso desenvolvido em Node.js que se posiciona entre os clientes (`OpenCode` / `Paperclip`) na porta `11434` e o Ollama na porta `11435`.

### Diagrama de Fluxo de Dados:

```
Requisição do Cliente (OpenCode) [POST /v1/chat/completions]
 │
 ├── 1. Identificação: A requisição contém ferramentas (`tools: [...]`)?
 │      ├── NÃO ──> Pass-through transparente (streaming direto).
 │      └── SIM ──> Força `stream: false` no backend Ollama.
 │
 ├── 2. O Ollama processa a inferência e retorna a resposta completa (JSON).
 │
 ├── 3. Inspeção do Payload:
 │      ├── O campo `tool_calls` veio preenchido nativamente?
 │      │    └── SIM ──> Mantém as chamadas.
 │      └── NÃO ──> Executa o analisador multi-estratégia no `message.content`.
 │
 ├── 4. Sanitização Profunda de Caminhos (`deepSanitizePaths`):
 │      └── Percorre todos os argumentos e converte caminhos absolutos
 │          como `"/arquivo.txt"` em caminhos relativos `"arquivo.txt"`.
 │
 └── 5. Síntese de Resposta:
        ├── O cliente original solicitou streaming (`stream: true`)?
        │    ├── SIM ──> Sintetiza eventos SSE (`text/event-stream`)
        │    │          com os `tool_calls` identificados e envia `[DONE]`.
        │    └── NÃO ──> Retorna JSON OpenAI formatado com `tool_calls`.
```

---

## 3. As 8 Estratégias Heurísticas de Extração

A função `extractToolCalls(text)` no roteador aplica oito estratégias em cascata para capturar qualquer chamada de ferramenta não estruturada:

1. **Tags `<tool_call>` e `<tools>`**: Captura blocos delimitados por XML gerados pelo tokenizer interno de chat do Qwen.
2. **Blocos de Código Markdown ````json ... ````**: Extrai JSONs aninhados em blocos de formatação.
3. **JSONs de Linha Única**: Varre linha por linha procurando objetos JSON delimitados por `{` e `}`.
4. **JSON Integral**: Analisa se a mensagem inteira consiste em um único objeto JSON válido com propriedades `name` e `arguments`.
5. **Comandos Pseudo-CLI `bash command="..."` ou `bash(command=...)`**: Trata o vício comum dos modelos de emitir chamadas de terminal em sintaxe simplificada sem escapar aspas internas.
6. **Blocos de Código Markdown ````bash ... ````**: Converte blocos de script em invocações da ferramenta de execução de comando `bash`.
7. **Linhas Avulsas de Utilitários (`paperclip-helper ...`)**: Identifica comandos de automação do Paperclip emitidos pelo agente sem prefixo.
8. **Invocação com Chaves Balanceadas (`tool_name { ... }`)**:
   Implementa um parser com contagem de profundidade de chaves (`extractBalancedBraces`), ignorando palavras reservadas de linguagens (`if`, `for`, `while`, `function`), permitindo extrair chamadas arbitrárias como:
   ```
   write { "filePath": "src/index.js", "content": "console.log('ok')" }
   ```

---

## 4. Sanitização de Caminhos contra Vazamento de Raiz

A função `deepSanitizePaths` realiza uma busca recursiva em todos os campos do objeto de argumentos da ferramenta:

```javascript
function sanitizePathValue(val) {
  if (typeof val === 'string' && val.startsWith('/') && 
      !val.startsWith('/home') && 
      !val.startsWith('/tmp') && 
      !val.startsWith('/run') && 
      !val.startsWith('/var')) {
    return val.replace(/^\/+/, '');
  }
  return val;
}
```

Isso garante que um comando emitido pelo modelo como `write(path="/docs/API.md")` seja automaticamente transformado em `write(path="docs/API.md")`. Como o processo do OpenCode roda no diretório do projeto, o arquivo é gravado com sucesso na pasta do workspace da empresa.

---

## 5. Configuração de Timeouts para Inferência Pesada

Modelos de 32 bilhões de parâmetros processando contextos próximos a 32.000 tokens podem levar de 30 a 90 segundos para gerar o primeiro token (fase de prefill). Se o servidor HTTP ou o proxy mantiver os timeouts padrões do Node.js (120 segundos), conexões lentas ou requisições encadeadas podem sofrer interrupção prematura.

O `ollama-router.js` desativa explicitamente todos os timeouts de socket:

```javascript
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 600000; // 10 minutos para reaproveitamento de conexão TCP
```

---

## 6. Serviço de Execução: `ollama-router.service`

Instalado em `~/.config/systemd/user/ollama-router.service`:

```ini
[Unit]
Description=Ollama 32B Dual-GPU Tool Proxy (Port 11434 -> Backend 11435)
After=network.target ollama.service
Requires=ollama.service

[Service]
Type=simple
ExecStart=/home/user/.local/bin/node /home/user/.local/bin/ollama-router.js
Restart=always
RestartSec=2
Environment="PATH=/home/user/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

[Install]
WantedBy=default.target
```
