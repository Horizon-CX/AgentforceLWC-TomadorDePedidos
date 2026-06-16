/**
 * Controlador Apex para el LWC orderSummaryAgentforce.
 *
 * Responsabilidades:
 *  1. Devolver el resumen de un Order (cabecera + líneas) para pintarlo en el LWC.
 *  2. Actualizar cantidades / borrar líneas (modo Modify).
 *  3. Actualizar cantidades + activar el pedido en una sola llamada (modo Confirm).
 */
public without sharing class OrderSummaryController {

    // Estado al que pasa el pedido cuando el usuario pulsa "Finalizar".
    private static final String TARGET_STATUS = 'Activated';

    // Estado en el que un pedido se considera editable. Salesforce bloquea
    // cambios sobre OrderItems cuando el Order ya no está en Draft.
    private static final String EDITABLE_STATUS = 'Draft';


    // ─────────────────────────────────────────────────────────────────────────
    // MÉTODO: resumen del pedido
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Carga cabecera + líneas del pedido para renderizar el resumen.
     *
     * @param orderId  Id del Order a consultar.
     * @return Map con la cabecera del pedido y un array `items` con sus líneas.
     */
    @AuraEnabled(cacheable=false)
    public static Map<String, Object> getOrderSummary(String orderId) {
        if (String.isBlank(orderId)) {
            throw new AuraHandledException('Se requiere el Id del pedido.');
        }

        Order ord = [
            SELECT Id, OrderNumber, Status, TotalAmount, Pricebook2.Name,
                   Account.Name, EffectiveDate
            FROM Order
            WHERE Id = :orderId
            LIMIT 1
        ];

        List<Map<String, Object>> lines = new List<Map<String, Object>>();
        for (OrderItem oi : [
            SELECT Id, Quantity, UnitPrice, TotalPrice,
                   PricebookEntry.Product2.Name,
                   PricebookEntry.Product2.Spanish_Name_TXT__c,
                   PricebookEntry.Product2.ProductCode,
                   PricebookEntry.Product2.Family,
                   PricebookEntry.Product2.Image_URL__c,
                   PricebookEntry.Product2Id
            FROM OrderItem
            WHERE OrderId = :orderId
            ORDER BY PricebookEntry.Product2.Name
        ]) {
            lines.add(new Map<String, Object>{
                'orderItemId'   => oi.Id,
                'quantity'      => oi.Quantity,
                'unitPrice'     => oi.UnitPrice,
                'totalPrice'    => oi.TotalPrice,
                'productName'   => oi.PricebookEntry.Product2.Name,
                'productNameEs' => oi.PricebookEntry.Product2.Spanish_Name_TXT__c,
                'productCode'   => oi.PricebookEntry.Product2.ProductCode,
                'family'        => oi.PricebookEntry.Product2.Family,
                'imageUrl'      => oi.PricebookEntry.Product2.Image_URL__c,
                'product2Id'    => oi.PricebookEntry.Product2Id
            });
        }

        Boolean canEdit = (ord.Status == EDITABLE_STATUS);

        return new Map<String, Object>{
            'orderId'       => ord.Id,
            'orderNumber'   => ord.OrderNumber,
            'status'        => ord.Status,
            'totalAmount'   => ord.TotalAmount,
            'pricebookName' => ord.Pricebook2?.Name,
            'accountName'   => ord.Account?.Name,
            'effectiveDate' => ord.EffectiveDate,
            'items'         => lines,
            // canEdit y canFinalize representan lo mismo (el pedido debe estar en Draft).
            // Mantenemos ambos por claridad: canFinalize lo usaba el flujo de Confirm,
            // canEdit lo usa el flujo de Modify.
            'canEdit'       => canEdit,
            'canFinalize'   => canEdit
        };
    }


    // ─────────────────────────────────────────────────────────────────────────
    // MÉTODO: solo actualizar líneas (modo Modify)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Aplica cambios de cantidad / borrados a las líneas del pedido SIN activarlo.
     * Útil para el modo Modify del LWC, donde el usuario puede ajustar el pedido
     * sin cerrarlo todavía.
     *
     * @param orderId      Id del Order.
     * @param itemUpdates  Array de objetos { orderItemId, quantity }.
     */
    @AuraEnabled(cacheable=false)
    public static Map<String, Object> updateOrderItems(String orderId, List<Map<String, Object>> itemUpdates) {
        if (String.isBlank(orderId)) {
            throw new AuraHandledException('Se requiere el Id del pedido.');
        }

        ensureEditable(orderId);

        try {
            applyItemUpdates(itemUpdates);
            return new Map<String, Object>{ 'success' => true };
        } catch (DmlException dme) {
            throw new AuraHandledException('No se pudieron guardar los cambios: ' + dme.getDmlMessage(0));
        }
    }


    // ─────────────────────────────────────────────────────────────────────────
    // MÉTODO: actualizar líneas + activar pedido (modo Confirm)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Aplica los cambios de cantidad y activa el pedido en una sola llamada.
     *
     * IMPORTANTE: primero se actualizan/borran las líneas y después se activa
     * el pedido. Si se hiciera al revés, los DML sobre OrderItem fallarían
     * porque Salesforce no permite modificar líneas de un pedido ya activado.
     *
     * @param orderId      Id del Order a finalizar.
     * @param itemUpdates  Array de objetos { orderItemId, quantity }.
     */
    @AuraEnabled(cacheable=false)
    public static Map<String, Object> finalizeOrder(String orderId, List<Map<String, Object>> itemUpdates) {
        if (String.isBlank(orderId)) {
            throw new AuraHandledException('Se requiere el Id del pedido.');
        }

        ensureEditable(orderId);

        System.debug('[finalizeOrder] orderId=' + orderId + ' itemUpdates=' + JSON.serialize(itemUpdates));

        try {
            applyItemUpdates(itemUpdates);
            update new Order(Id = (Id) orderId, Status = TARGET_STATUS);

            return new Map<String, Object>{
                'success' => true,
                'status'  => TARGET_STATUS
            };
        } catch (DmlException dme) {
            throw new AuraHandledException('No se pudo finalizar el pedido: ' + dme.getDmlMessage(0));
        }
    }


    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS PRIVADOS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Aplica las actualizaciones de cantidad a los OrderItem.
     *  - quantity > 0  → update con la nueva cantidad.
     *  - quantity <= 0 → delete del OrderItem (el usuario quitó el producto del pedido).
     *
     * Se recibe un List<Map> en vez de una inner class porque la deserialización
     * de inner classes desde LWC puede ser frágil; el Map es más tolerante.
     */
    private static void applyItemUpdates(List<Map<String, Object>> itemUpdates) {
        if (itemUpdates == null || itemUpdates.isEmpty()) return;

        List<OrderItem> toUpdate = new List<OrderItem>();
        List<Id>        toDelete = new List<Id>();

        for (Map<String, Object> upd : itemUpdates) {
            String oiId = (String) upd.get('orderItemId');
            if (String.isBlank(oiId)) continue;

            // Convertimos a Decimal de forma defensiva: el JSON puede llegar
            // como Integer, Double o String según cómo lo serialice LWC.
            Object qtyObj = upd.get('quantity');
            if (qtyObj == null) continue;
            Decimal qty;
            try {
                qty = Decimal.valueOf(String.valueOf(qtyObj));
            } catch (Exception e) {
                continue;
            }

            if (qty > 0) {
                toUpdate.add(new OrderItem(Id = (Id) oiId, Quantity = qty));
            } else {
                toDelete.add((Id) oiId);
            }
        }

        if (!toUpdate.isEmpty()) update toUpdate;
        if (!toDelete.isEmpty()) delete [SELECT Id FROM OrderItem WHERE Id IN :toDelete];
    }

    /**
     * Comprueba que el pedido está en estado editable (Draft).
     * Lanza una excepción clara si no lo está, para que el LWC pueda mostrarla.
     */
    private static void ensureEditable(String orderId) {
        Order ord;
        try {
            ord = [SELECT Id, Status FROM Order WHERE Id = :orderId LIMIT 1];
        } catch (QueryException qe) {
            throw new AuraHandledException('No se encontró el pedido con Id: ' + orderId);
        }
        if (ord.Status != EDITABLE_STATUS) {
            throw new AuraHandledException('No se puede modificar el pedido: debe estar en estado Draft (actual: ' + ord.Status + ').');
        }
    }
}