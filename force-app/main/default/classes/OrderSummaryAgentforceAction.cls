public class OrderSummaryAgentforceAction {

    public class Request {
        @InvocableVariable(label='Record Id' required=true description='Id del Order cuyo resumen se mostrará.')
        public String recordId;

        @InvocableVariable(label='Mode' required=false description='Confirm | Modify (también acepta Confirmar | Modificar). Por defecto Confirm.')
        public String mode;
    }

    public class Result {
        @InvocableVariable(description='Renderizar como LWC.') public OrderSummaryInput result;
    }

    @InvocableMethod(label='Order Summary' description='Muestra el resumen del pedido con sus líneas. En modo Confirm permite finalizarlo; en modo Modify permite modificar cantidades sin activarlo.')
    public static List<Result> execute(List<Request> requests) {
        List<Result> results = new List<Result>();
        for (Request req : requests) {
            OrderSummaryInput output = new OrderSummaryInput();
            output.recordId = req.recordId;
            output.mode     = req.mode;
            Result r = new Result();
            r.result = output;
            results.add(r);
        }
        return results;
    }
}