# Guia de Governança de Interações e Prevenção de Loops no Paperclip

## 1. Contexto e Desafio Identificado

Durante a orquestração autônoma de agentes (como CEO, CTO, etc.) com Paperclip e modelos LLM locais (Ollama), um comportamento anômalo de repetição cíclica pode ocorrer:
- O agente emite sucessivas chamadas de escalonamento para o Board (`paperclip-helper ask-board`) em turnos consecutivos.
- Comentários repetidos são postados no ticket a cada minuto.
- A tarefa acumula churn elevado, disparando automaticamente a criação de tickets do tipo `productivityReview` (ex: `Review productivity for DEV-66`).

## 2. Diagnóstico da Causa Raiz

A análise minuciosa dos logs em formato NDJSON (`data/run-logs/...`) revelou uma cadeia de 4 fatores interdependentes:

1. **Incompatibilidade de Schema na API de Interações (`/api/issues/:id/interactions`):**
   - O Paperclip exige que interações do tipo `ask_user_questions` contenham a estrutura estrita:
     ```json
     {
       "kind": "ask_user_questions",
       "continuationPolicy": "wake_assignee",
       "payload": {
         "version": 1,
         "questions": [
           {
             "id": "q1",
             "prompt": "Pergunta clara (min 1, max 500)",
             "selectionMode": "single",
             "options": [
               { "id": "opt1", "label": "Opção 1" },
               { "id": "opt2", "label": "Opção 2", "freeText": true }
             ]
           }
         ]
       }
     }
     ```
   - Uma chamada com schema incorreto (ex: `{ question, type: "text" }`) resulta em erro HTTP 400 (`Validation error`).

2. **Regra de Disposição de Tarefas no Paperclip (`invalid_issue_disposition` - HTTP 422):**
   - Quando um agente tenta mover uma tarefa para `in_review` via `PATCH /api/issues/:id`, o Paperclip valida se há um "caminho de revisão ativo" (`review_path`).
   - Caminhos válidos: `pending_issue_thread_interaction`, `linked_pending_approval`, `human_assignee_user_id`, etc.
   - Se a criação da interação falhou no passo 1, o PATCH para `in_review` é rejeitado com erro HTTP 422. A tarefa permanece forçadamente em `in_progress`.

3. **Interpretação e Tentativa de Auto-Correção pelo LLM:**
   - O modelo LLM lê a saída de erro do CLI contendo os requisitos do Zod (`expected string for prompt, expected single|multi for selectionMode`).
   - O LLM tenta passar parâmetros interativos no comando seguinte:
     ```bash
     paperclip-helper ask-board --question "..." --prompt "..." --selectionMode single --options "[...]"
     ```
   - Se o parser do CLI apenas concatenar os argumentos excedentes, o texto do comentário recebe os flags vazados, sujando a governança.

4. **Loop de Turnos da Sessão OpenCode:**
   - Como a tarefa não mudou de status (permaneceu `in_progress`), o run continuou ativo e re-executou a mesma tentativa a cada turno.

---

## 3. Arquitetura da Solução Implementada

Para erradicar definitivamente qualquer possibilidade desse ciclo, implementamos quatro camadas de proteção:

### A. Sanitização Inteligente de Argumentos no `paperclip-helper`
O parser do comando `ask-board` agora reconhece `--prompt`, `--selectionMode`, `--options` e remove quaisquer flags acidentais do corpo da pergunta utilizando expressões regulares:
```javascript
let rawQuestion = questionParts.join(' ').trim();
let question = rawQuestion
  .replace(/--(prompt|selectionMode|options)\b[\s\S]*/gi, '')
  .trim();
```

### B. Guard de Idempotência
Antes de executar qualquer chamada à API, o `paperclip-helper` inspeciona o estado atual do ticket:
- Se o status já for `done`: encerra sem ação.
- Se o status já for `in_review`: detecta que o escalonamento já ocorreu e encerra com código 0, evitando comentários duplicados.

### C. Schema de Interação 100% Conforme
O payload enviado ao `/api/issues/:id/interactions` foi reestruturado de acordo com o Zod schema do Paperclip:
- `selectionMode: "single"`
- Opções canônicas de deliberação:
  - `Aprovar / Proceder com as diretrizes`
  - `Solicitar Esclarecimento / Ajuste` (com `freeText: true`)
  - `Rejeitar / Abordagem Inviável`
- `supersedeOnUserComment: false` para persistência segura até deliberação pelo Board.

### D. Diretriz de Tarefas Operacionais no `AGENTS.md` (CEO)
Esclarecimento formal de que tarefas operacionais e de revisão de sprint (ex: "Monitor Sprint Velocity", "Review Architecture Proposals") são atribuições normais do CEO:
- Devem ser avaliadas e imediatamente marcadas como `done` via `paperclip-helper done`.
- Não devem ser escaladas como dúvidas ao Board.
