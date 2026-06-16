/**
 * Schema del Lightning Type para el LWC orderSummaryAgentforce.
 * Agentforce Builder usa esta clase para generar el tipo c__OrderSummaryInput.
 */
public class OrderSummaryInput {
    /** Id del Order cuyo resumen se mostrará */
    @AuraEnabled public String recordId;

    /**
     * Modo de operación del componente. Valores aceptados (case-insensitive):
     *   - Confirm / Confirmar → mostrar resumen y permitir activar el pedido (por defecto).
     *   - Modify  / Modificar → permitir modificar cantidades sin activar el pedido.
     * Si no se pasa o no encaja, el LWC asume Confirm.
     */
    @AuraEnabled public String mode;
}