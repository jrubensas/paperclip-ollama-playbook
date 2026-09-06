# 05. Resolução de Isolamento de Workspace e Patches no OpenCode

Um dos desafios mais complexos encontrados durante a operação foi o **desvio silencioso de diretório de trabalho**: os agentes afirmavam nos relatórios que haviam criado os arquivos do projeto, mas ao inspecionar a pasta de workspace do projeto, ela estava vazia.

Este documento detalha a causa raiz aprofundada, as ferramentas forenses utilizadas para diagnosticar o erro e os três níveis de correção aplicados.

---

## 1. O Sintoma: O "Workspace Fantasma"

Ao criar uma empresa no Paperclip, cada projeto recebe um diretório dedicado de workspace com identificadores UUID, por exemplo:
`/run/media/user/Storage/paperclip-data/instances/default/projects/a2b7cc05.../94af9ecd.../_default`

No entanto:
- O agente Frontend dizia: *"Componentes do marketplace criados em `src/routes/+page.svelte`"*.
- O agente Firmware dizia: *"Driver do ESP32 gravado em `src/main.py`"*.
- **Ao abrir o diretório do projeto**: os arquivos não existiam.
- **Ao inspecionar a home do usuário (`/home/user`)**: arquivos soltos como `+page.svelte`, `package.json` ou `firmware.bin` estavam sendo gerados na raiz do usuário do sistema operacional!

---

## 2. A Investigação Forense e a Causa Raiz

### A. Persistência de Sessão no SQLite do OpenCode
O runtime OpenCode mantém um banco de dados relacional em:
`~/.local/share/opencode/opencode.db`

Ao examinar o esquema e as tabelas com o Python:
```python
import sqlite3

conn = sqlite3.connect("/home/user/.local/share/opencode/opencode.db")
c = conn.cursor()
c.execute("SELECT id, title, directory FROM session")
for row in c.fetchall():
    print(row)
```

Descobriu-se que a tabela `session` possuía uma coluna `directory`:
```
('ses_f8a5e8e7affefuEP3LaBqLW3l8', 'CEO Session', '/home/user')
('ses_91ab34cd88ff912a87bc1234', 'Frontend Session', '/home/user')
```

Quando um agente executava seu primeiro heartbeat na instalação inicial, o OpenCode vinculou a sessão ao diretório padrão do usuário (`/home/user`).

### B. A Falha no Adapter `@paperclipai/adapter-opencode-local`
Ao analisar o código-fonte de execução do adapter Paperclip em:
`/run/media/user/Storage/paperclip-data/cli/installs/npm/2026.831.1/node_modules/@paperclipai/adapter-opencode-local/dist/server/execute.js`

A função `buildArgs` construía os parâmetros para a CLI do OpenCode da seguinte forma:
```javascript
// CÓDIGO ORIGINAL COM DEFEITO
const buildArgs = (resumeSessionId) => {
    const args = ["run", "--format", "json"];
    if (printLogs)
        args.push("--print-logs");
    if (resumeSessionId)
        args.push("--session", resumeSessionId);
    if (model)
        args.push("--model", model);
    if (variant)
        args.push("--variant", variant);
    if (extraArgs.length > 0)
        args.push(...extraArgs);
    return args;
};
```

**O Comportamento Oculto do OpenCode**:
Quando a flag `--session <sessionId>` é fornecida na linha de comando **sem** a flag `--dir <caminho>`, a CLI do OpenCode **ignora completamente o `cwd` do processo do sistema operacional** e restaura o diretório gravado no banco de dados SQLite (`session.directory = '/home/user'`).

Portanto, mesmo que o Paperclip configurasse `spawn(..., { cwd: "/caminho/do/projeto" })`, as ferramentas de escrita (`write`, `bash`, `edit`) do OpenCode operavam em `/home/user`!

---

## 3. As Soluções Implementadas

Para solucionar permanentemente e garantir imunidade a futuras sessões, aplicamos três correções estruturais:

### Correção 1: Patch no Adapter do Paperclip (`execute.js`)
Editamos a biblioteca `@paperclipai/adapter-opencode-local` para sempre injetar explicitamente o parâmetro `--dir <cwd>` e a variável de ambiente `PWD`:

```javascript
// CÓDIGO CORRIGIDO
const buildArgs = (resumeSessionId) => {
    const args = ["run", "--format", "json"];
    // INJETADO: Força o OpenCode a reescrever o diretório da sessão para o workspace atual
    if (cwd)
        args.push("--dir", cwd);
    if (printLogs)
        args.push("--print-logs");
    if (resumeSessionId)
        args.push("--session", resumeSessionId);
    if (model)
        args.push("--model", model);
    if (variant)
        args.push("--variant", variant);
    if (extraArgs.length > 0)
        args.push(...extraArgs);
    return args;
};

// Na chamada do processo:
const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
    cwd,
    env: { ...preparedRuntimeConfig.env, PWD: cwd }, // INJETADO PWD
    stdin: prompt,
    ...
});
```

### Correção 2: Migração do Banco de Dados SQLite Existente
Executamos um script de saneamento no SQLite do OpenCode para atualizar todas as sessões registradas no passado para apontar para a pasta real do workspace:

```bash
python3 -c '
import sqlite3

WORKSPACE = "/run/media/user/Storage/paperclip-data/instances/default/projects/a2b7cc05-fefb-4a38-bdf4-1989be1b97fd/94af9ecd-eb4a-49a4-8bb9-dd657ce74932/_default"
conn = sqlite3.connect("/home/user/.local/share/opencode/opencode.db")
c = conn.cursor()
c.execute("UPDATE session SET directory = ?", (WORKSPACE,))
conn.commit()
print(f"Atualizadas {c.rowcount} sessões no OpenCode para o workspace correto.")
'
```

### Correção 3: Symlink Amigável no Ambiente de Desenvolvimento
Para facilitar a inspeção visual imediata por parte do desenvolvedor, criamos um link simbólico direto na home:

```bash
ln -s /run/media/user/Storage/paperclip-data/instances/default/projects/a2b7cc05-fefb-4a38-bdf4-1989be1b97fd/94af9ecd-eb4a-49a4-8bb9-dd657ce74932/_default /home/user/devboost-workspace
```

Dessa forma, qualquer inspeção via terminal ou VS Code pode ser feita diretamente em `~/devboost-workspace`.
