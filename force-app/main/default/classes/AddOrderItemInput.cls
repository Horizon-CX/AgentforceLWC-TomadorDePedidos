/**
 * Schema del Lightning Type para el LWC addOrderItemAgentforce.
 * Agentforce Builder usa esta clase para generar el tipo c__AddOrderItemInput.
 * El agente rellenará estos campos antes de renderizar el LWC.
 */
public class AddOrderItemInput {
    /** Id del Order al que se añadirán los productos */
    @AuraEnabled public String recordId;

    /** Término de búsqueda que describió el usuario (puede tener erratas) */
    @AuraEnabled public String query;
}