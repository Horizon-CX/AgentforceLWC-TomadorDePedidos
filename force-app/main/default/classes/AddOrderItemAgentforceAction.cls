/**
 * Invocable Action para Agentforce que lanza el LWC addOrderItemAgentforce.
 *
 * Patrón: el método devuelve un objeto del Lightning Type (AddOrderItemInput).
 * Agentforce detecta el tipo de retorno, busca su renderer configurado en el
 * Lightning Type y renderiza el LWC en el chat automáticamente.
 *
 * Esta clase no hace lógica de negocio — solo empaqueta los parámetros de entrada
 * en el objeto del Lightning Type para que el LWC los reciba via @api value.
 */
public class AddOrderItemAgentforceAction {

    public class Request {
        @InvocableVariable(label='Record Id' required=true description='Id del Order al que se añadirán los productos.')
        public String recordId;

        @InvocableVariable(label='Query' required=true description='Nombre del producto que quiere buscar el usuario.')
        public String query;
    }

    /**
     * Wrapper de salida con un único @InvocableVariable que apunta al Lightning Type.
     * Esto hace que Agentforce vea un solo output "result" de tipo c__AddOrderItemInput
     * (renderizado como LWC) en lugar de campos sueltos.
     */
    public class Result {
        @InvocableVariable(description='Renderizar como LWC.') public AddOrderItemInput result;
    }

    @InvocableMethod(label='Add Order Item' description='Muestra el selector de productos en el chat para añadir un OrderItem al pedido indicado.'
    )
    public static List<Result> execute(List<Request> requests) {
        List<Result> results = new List<Result>();
        for (Request req : requests) {
            AddOrderItemInput output = new AddOrderItemInput();
            output.recordId = req.recordId;
            output.query    = req.query;
            Result res = new Result();
            res.result = output;
            results.add(res);
        }
        return results;
    }
}