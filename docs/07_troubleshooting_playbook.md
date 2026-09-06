# 07. Playbook de Troubleshooting e Diagnóstico Rápido

Este playbook serve como manual de campo operacional para diagnosticar, mitigar e corrigir incidentes comuns na stack Paperclip AI + Ollama Dual-GPU.

---

## 1. Incidentes com Agentes e Tarefas

### Sintoma A: "Todos os agentes estão parados e nenhuma nova tarefa é criada"
- **Causa Provável**: O CEO concluiu um ciclo de planejamento anterior e aguarda que uma tarefa em andamento seja finalizada, ou a meta (`Goal`) foi considerada completa.
- **Diagnóstico**:
  1. Inspecione as tarefas ativas da empresa:
     ```bash
     curl -s http://127.0.0.1:3100/api/companies/<COMPANY_ID>/issues?status=in_progress,todo | python3 -m json.tool
     ```
  2. Verifique o log do último run do CEO:
     ```bash
     tail -n 100 /home/user/.paperclip/instances/default/logs/paperclip.log
     ```
- **Solução Imediata**:
  Dispare uma nova tarefa de sprint manualmente para acionar o time de engenharia:
  ```bash
  paperclip-helper create-task \
    --title "Sprint 2: Implementar testes automatizados de integração" \
    --assignee "QA" \
    --description "Validar endpoints Go Fiber com o simulador ESP32-S3."
  ```
  O agente de QA acordará imediatamente via `wakeOnDemand`.

---

### Sintoma B: "O agente executou o código mas a tarefa continua 'in_progress'"
- **Causa Provável**: O modelo encerrou seu raciocínio sem invocar a chamada de conclusão de tarefa.
- **Solução**:
  Finalize a tarefa pela linha de comando usando o `paperclip-helper`:
  ```bash
  # Localize o ID da issue e marque como done
  paperclip-helper done --task-id <ISSUE_UUID> "Tarefa validada e concluída com sucesso."
  ```

---

### Sintoma C: "Os arquivos gerados não aparecem como artefatos no painel web"
- **Causa Provável**: No Paperclip, criar um arquivo no disco não registra automaticamente um "Work Product" (artefato formal) na interface visual. O agente precisa associar o anexo à issue.
- **Solução**:
  Use o comando de registro de artefato do `paperclip-helper`:
  ```bash
  paperclip-helper artifact \
    --task-id <ISSUE_UUID> \
    "marketplace-frontend/src/routes/+page.svelte" \
    "Frontend Home & Marketplace View"
  ```
  Isso faz o upload do arquivo para o storage do Paperclip e registra o item na aba "Work Products" da interface web.

---

## 2. Incidentes de Infraestrutura e GPUs

### Sintoma D: "Ollama ou Router retornando erro 502 Bad Gateway"
- **Causa Provável**: O backend real do Ollama (porta 11435) caiu ou está reinicializando.
- **Diagnóstico**:
  ```bash
  # 1. Checar status do Ollama Real
  systemctl --user status ollama.service

  # 2. Checar status do Router Proxy
  systemctl --user status ollama-router.service

  # 3. Testar ping direto no Ollama
  curl -s http://127.0.0.1:11435/api/tags
  ```
- **Solução**:
  Reinicie os serviços em sequência com o pré-carregador:
  ```bash
  systemctl --user restart ollama.service
  sleep 3
  systemctl --user restart ollama-preload.service
  systemctl --user restart ollama-router.service
  ```

---

### Sintoma E: "Desbalanceamento de VRAM entre as GPUs"
- **Causa Provável**: Um processo externo alocou memória na GPU 0 (ex: navegador, desktop GUI ou script avulso), forçando o Ollama a reduzir as camadas enviadas para a GPU 0 e sobrecarregar a GPU 1.
- **Diagnóstico**:
  ```bash
  nvidia-smi
  ```
- **Solução**:
  1. Identifique processos concorrentes:
     ```bash
     fuser -v /dev/nvidia*
     ```
  2. Encerre processos não essenciais.
  3. Dispare o preload para forçar a partição 50/50 das camadas:
     ```bash
     systemctl --user restart ollama.service ollama-preload.service
     ```

---

## 3. Incidentes de Banco de Dados e Sessões

### Sintoma F: "OpenCode voltando a salvar arquivos em `/home/user`"
- **Causa Provável**: Uma nova sessão de agente foi gerada antes do patch de `--dir` ter sido compilado ou aplicado.
- **Solução**:
  Rode a correção de migração do SQLite do OpenCode:
  ```bash
  python3 -c '
  import sqlite3
  WORKSPACE = "/run/media/user/Storage/paperclip-data/instances/default/projects/a2b7cc05-fefb-4a38-bdf4-1989be1b97fd/94af9ecd-eb4a-49a4-8bb9-dd657ce74932/_default"
  conn = sqlite3.connect("/home/user/.local/share/opencode/opencode.db")
  c = conn.cursor()
  c.execute("UPDATE session SET directory = ?", (WORKSPACE,))
  conn.commit()
  print(f"Sessões migradas para o workspace: {c.rowcount}")
  '
  ```
