# Tomador de Pedidos — Agentforce LWC

LWC listo para usar como **Tomador de Pedidos** en Agentforce. Permite que el agente muestre una UI conversacional para añadir productos a un pedido y ver el resumen antes de confirmarlo.

[![Deploy to Salesforce](https://raw.githubusercontent.com/afawcett/githubsfdeploy/master/deploy.png)](https://githubsfdeploy.herokuapp.com/?owner=Horizon-CX&repo=AgentforceLWC-TomadorDePedidos&ref=master)

---

## Componentes incluidos

### Lightning Web Components (3)

| Componente | Descripción |
|---|---|
| `addOrderItemAgentforce` | UI para que el agente añada productos al pedido |
| `orderSummaryAgentforce` | UI para ver el resumen y confirmar el pedido |
| `orderBuilder` | Construcción de mensajes de chat (sin Apex) |

### Lightning Types (2)

Vinculan las Invocable Actions de Agentforce con los LWC que las renderizan.

| API Name | LWC que renderiza |
|---|---|
| `AddOrderItem` | `addOrderItemAgentforce` |
| `OrderSummaryInput` | `orderSummaryAgentforce` |

### Apex Classes (6)

| Clase | Tipo | Depende de |
|---|---|---|
| `AddOrderItemAgentforceController` | Controller del LWC | — |
| `OrderSummaryController` | Controller del LWC | — |
| `AddOrderItemInput` | Input wrapper | — |
| `OrderSummaryInput` | Input wrapper | — |
| `AddOrderItemAgentforceAction` | Invocable Action | `AddOrderItemInput` |
| `OrderSummaryAgentforceAction` | Invocable Action | `OrderSummaryInput` |

---

## Instalación manual (SFDX)

```bash
sf org login web -a myOrg
sf project deploy start --source-dir force-app -o myOrg
```

---

## Requisitos

- Salesforce org con **Agentforce** habilitado
- API version **62.0** o superior
