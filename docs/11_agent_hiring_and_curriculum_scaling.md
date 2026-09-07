# 11. Contratação de Agentes Especialistas & Escala de Entregáveis no Paperclip

Este guia documenta o protocolo corporativo para contratação e provisionamento de novos agentes especialistas no Paperclip AI, evitando armadilhas de delegação fantasma e falsas conclusões (*faux-done*).

---

## 1. O Problema da Delegação Fantasma (*Ghost Delegation*)

### O que ocorreu (Antipattern)
Quando uma demanda de alto volume ou especialização é solicitada (ex: *"Contratar um Technical Writer para desenvolver 365 aulas de MicroPython"*):
1. O CEO ou CTO tenta delegar a tarefa para uma entidade fictícia inexistente (ex: `assigneeAgentId: "HR"`).
2. A API rejeita a requisição com HTTP 400 (`Invalid GUID`).
3. O modelo, operando em turnos paralelos sem guardrails, fecha a tarefa original com `paperclip-helper done` acreditando que delegou.
4. **Resultado**: A tarefa é marcada como `done` no dashboard, mas nenhum agente foi contratado e nenhum entregável foi produzido.

---

## 2. Protocolo Oficial de Contratação de Agentes no Paperclip

Para provisionar um novo agente autônomo de forma legítima, siga o fluxo de governança:

### Passo 1: Cadastro via API Administrativa (`POST /api/companies/:id/agents`)
A partir do ambiente confiável (`local_trusted`), envie o payload de criação:

```json
{
  "name": "Technical Writer",
  "title": "Technical Writer & Curriculum Specialist",
  "role": "engineer",
  "reportsTo": "<UUID_DO_CTO>",
  "capabilities": "Elaboração de currículos didáticos de MicroPython, documentação técnica embarcada para hardware ESP32-S3, criação de tutoriais progressivos e códigos de exemplo comentados.",
  "adapterType": "opencode_local",
  "adapterConfig": {
    "cwd": "/home/user/devboost-workspace",
    "model": "ollama/qwen2.5-coder:7b",
    "extraArgs": ["--auto"],
    "dangerouslySkipPermissions": true
  },
  "runtimeConfig": {
    "heartbeat": {
      "enabled": true,
      "intervalSec": 300,
      "wakeOnDemand": true,
      "maxConcurrentRuns": 1,
      "skipTimerWhenNoActionableWork": true
    }
  }
}
```

### Passo 2: Alocação Inteligente de GPU
- Agentes de liderança/planejamento (CEO, CTO): `qwen2.5-coder:32b` (GPU #1).
- Agentes de execução/redação (Frontend, Firmware, QA, Technical Writer): `qwen2.5-coder:7b` (GPU #2).
- Essa distribuição garante zero concorrência de VRAM e resposta ultra-rápida.

### Passo 3: Configuração das Instruções (`AGENTS.md`)
O arquivo de instruções do agente provisionado deve ser salvo em:
`/home/user/.paperclip/instances/default/companies/<company_id>/agents/<agent_id>/instructions/AGENTS.md`
Contendo:
- Escopo técnico e educacional.
- Estrutura obrigatória das entregas.
- Guardrails anti-chatbot e uso de `paperclip-helper`.

### Passo 4: Registro no `KNOWN_AGENTS`
Atualizar o dicionário `KNOWN_AGENTS` no CLI `paperclip-helper` para mapear aliases:
```javascript
const KNOWN_AGENTS = {
  'ceo': '53a70b86-e1d9-4360-b783-d6891cae086e',
  'cto': '03fd3b00-89a1-458f-834d-fdcb4a513fb8',
  'writer': '84f51613-5970-459d-af6c-abc6d0a515a6',
  'technical_writer': '84f51613-5970-459d-af6c-abc6d0a515a6'
};
```

---

## 3. Gestão de Entregáveis de Grande Escala (365 Aulas)

Projetos extensos não podem ser concluídos com lições de mentira ou resumos vagos:
1. **Decomposição em Módulos Hierárquicos**: A iniciativa principal (DEV-21) atua como pai (`parentId`), e cada módulo (Módulos 1 a 9) recebe uma tarefa dedicada atribuída ao especialista.
2. **Motor de Compilação Curricular**: O agente utiliza scripts dedicados (`curriculum_compiler.py`) para gerar os artefatos com conteúdo didático robusto, esquemáticos e código funcional.
3. **Validação Contínua**: Cada script de exemplo é compilado (`py_compile`), e a suíte de testes automatizados (`run_all_tests.sh`) audita a contagem exata de lições (365/365).
