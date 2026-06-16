/**
 * Controlador Apex para el LWC addOrderItemAgentforce.
 *
 * Responsabilidades:
 *  1. Buscar productos activos del pricebook del pedido usando búsqueda fuzzy
 *     (LIKE por tokens + SOSL como fallback).
 *  2. Crear o actualizar un OrderItem en el pedido (upsert por producto).
 */
public without sharing class AddOrderItemAgentforceController {

    private static final Integer MAX_PRODUCTS    = 8;
    private static final Integer MIN_TOKEN_LENGTH = 3;

    // Estado del pedido que permite añadir/modificar líneas. Salesforce bloquea
    // cambios sobre OrderItems cuando el Order está en Activated u otros estados
    // cerrados, así que solo permitimos operar si está en Draft.
    private static final String EDITABLE_STATUS = 'Draft';


    // ─────────────────────────────────────────────────────────────────────────
    // MÉTODO PRINCIPAL: BÚSQUEDA DE PRODUCTOS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Busca productos activos del pricebook del pedido indicado.
     *
     * Estrategia en dos fases:
     *  - Fase 1 (LIKE): tokens del query contra nombre, código, familia y nombre en español.
     *  - Fase 2 (SOSL): fallback full-text para erratas y variaciones.
     *
     * @param orderId  Id del Order cuyo Pricebook2Id se usará como filtro.
     * @param query    Texto libre del usuario (puede tener erratas o estar en español).
     * @return Map con:
     *           - items:         Lista de hasta MAX_PRODUCTS productos.
     *           - orderStatus:   Estado actual del pedido (Draft, Activated, …).
     *           - canAddItems:   true si el pedido está en estado editable (Draft).
     *           - pricebookName: Nombre del pricebook asociado al pedido.
     */
    @AuraEnabled(cacheable=false)
    public static Map<String, Object> searchProducts(String orderId, String query) {

        System.debug(LoggingLevel.INFO, '[AddOrderItem][searchProducts] === ENTRADA === orderId=' + orderId + ' | query=' + query);

        if (String.isBlank(orderId)) {
            System.debug(LoggingLevel.WARN, '[AddOrderItem][searchProducts] orderId vacío → AuraHandledException');
            throw new AuraHandledException('Se requiere el Id del pedido para buscar productos.');
        }

        Order ord = getOrder(orderId);
        System.debug(LoggingLevel.INFO, '[AddOrderItem][searchProducts] Order recuperado: Id=' + ord.Id + ' | Status=' + ord.Status + ' | Pricebook2Id=' + ord.Pricebook2Id);

        if (ord.Pricebook2Id == null) {
            System.debug(LoggingLevel.WARN, '[AddOrderItem][searchProducts] El pedido no tiene Pricebook asignado → AuraHandledException');
            throw new AuraHandledException('El pedido no tiene Pricebook asignado.');
        }

        Boolean canAddItems = (ord.Status == EDITABLE_STATUS);
        String  pbName      = getPricebookName(ord.Pricebook2Id);
        System.debug(LoggingLevel.INFO, '[AddOrderItem][searchProducts] canAddItems=' + canAddItems + ' | pricebookName=' + pbName);

        List<ProductSuggestionItem> items = new List<ProductSuggestionItem>();
        // Si el pedido no es editable, no merece la pena buscar productos.
        if (canAddItems) {
            List<PricebookEntry> entries = findEntries(ord.Pricebook2Id, query);
            System.debug(LoggingLevel.INFO, '[AddOrderItem][searchProducts] findEntries devolvió ' + entries.size() + ' PricebookEntry(s)');
            for (PricebookEntry pbe : entries) {
                ProductSuggestionItem item = new ProductSuggestionItem();
                item.pricebookEntryId = pbe.Id;
                item.product2Id       = pbe.Product2Id;
                item.productName      = pbe.Product2.Name;
                item.productNameEs    = pbe.Product2.Spanish_Name_TXT__c;
                item.productCode      = pbe.Product2.ProductCode;
                item.family           = pbe.Product2.Family;
                item.unitPrice        = pbe.UnitPrice;
                item.imageUrl         = pbe.Product2.Image_URL__c;
                item.pricebookId      = ord.Pricebook2Id;
                item.pricebookName    = pbName;
                items.add(item);
            }
        } else {
            System.debug(LoggingLevel.INFO, '[AddOrderItem][searchProducts] Pedido NO editable (Status=' + ord.Status + '), no se buscan productos');
        }

        Map<String, Object> response = new Map<String, Object>{
            'items'         => items,
            'orderStatus'   => ord.Status,
            'canAddItems'   => canAddItems,
            'pricebookName' => pbName
        };
        System.debug(LoggingLevel.INFO, '[AddOrderItem][searchProducts] === SALIDA === items=' + items.size() + ' | orderStatus=' + ord.Status + ' | canAddItems=' + canAddItems);
        return response;
    }


    // ─────────────────────────────────────────────────────────────────────────
    // MÉTODO PRINCIPAL: AÑADIR PRODUCTO AL PEDIDO
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Crea o actualiza un OrderItem en el pedido.
     * Si el producto ya existe en el pedido, incrementa la cantidad; si no, lo crea.
     *
     * @param orderId          Id del Order al que se añade el item.
     * @param pricebookEntryId Id del PricebookEntry seleccionado por el usuario.
     * @param quantity         Número de unidades (debe ser > 0).
     */
    @AuraEnabled(cacheable=false)
    public static Map<String, Object> addOrderItem(String orderId, String pricebookEntryId, Decimal quantity) {

        System.debug(LoggingLevel.INFO, '[AddOrderItem][addOrderItem] === ENTRADA === orderId=' + orderId + ' | pricebookEntryId=' + pricebookEntryId + ' | quantity=' + quantity);

        if (String.isBlank(orderId)) {
            System.debug(LoggingLevel.WARN, '[AddOrderItem][addOrderItem] orderId vacío → AuraHandledException');
            throw new AuraHandledException('Se requiere el Id del pedido.');
        }
        if (String.isBlank(pricebookEntryId)) {
            System.debug(LoggingLevel.WARN, '[AddOrderItem][addOrderItem] pricebookEntryId vacío → AuraHandledException');
            throw new AuraHandledException('Se requiere el Id del PricebookEntry.');
        }
        if (quantity == null || quantity <= 0) {
            System.debug(LoggingLevel.WARN, '[AddOrderItem][addOrderItem] quantity inválida=' + quantity + ' → AuraHandledException');
            throw new AuraHandledException('La cantidad debe ser mayor que cero.');
        }

        // Solo se pueden añadir productos a un pedido en Draft.
        Order ord = getOrder(orderId);
        System.debug(LoggingLevel.INFO, '[AddOrderItem][addOrderItem] Order recuperado: Id=' + ord.Id + ' | Status=' + ord.Status);

        if (ord.Status != EDITABLE_STATUS) {
            System.debug(LoggingLevel.WARN, '[AddOrderItem][addOrderItem] Pedido no editable (Status=' + ord.Status + ') → AuraHandledException');
            throw new AuraHandledException('No se pueden añadir productos: el pedido debe estar en estado Draft (actual: ' + ord.Status + ').');
        }

        try {
            PricebookEntry pbe = [
                SELECT Id, UnitPrice, Product2.Name
                FROM PricebookEntry
                WHERE Id = :pricebookEntryId
                  AND IsActive = true
                LIMIT 1
            ];
            System.debug(LoggingLevel.INFO, '[AddOrderItem][addOrderItem] PricebookEntry encontrado: Id=' + pbe.Id + ' | Product2.Name=' + pbe.Product2.Name + ' | UnitPrice=' + pbe.UnitPrice);

            List<OrderItem> existing = [
                SELECT Id, Quantity
                FROM OrderItem
                WHERE OrderId = :orderId
                  AND PricebookEntryId = :pricebookEntryId
                LIMIT 1
            ];
            System.debug(LoggingLevel.INFO, '[AddOrderItem][addOrderItem] OrderItem existente: ' + (existing.isEmpty() ? 'NO existe — se creará nuevo' : 'SÍ existe Id=' + existing[0].Id + ' Quantity=' + existing[0].Quantity));

            String actionDone;
            Id orderItemId;

            if (!existing.isEmpty()) {
                OrderItem oi = existing[0];
                Decimal previousQty = oi.Quantity;
                oi.Quantity += quantity;
                update oi;
                actionDone  = 'actualizado';
                orderItemId = oi.Id;
                System.debug(LoggingLevel.INFO, '[AddOrderItem][addOrderItem] UPDATE OrderItem Id=' + oi.Id + ' | Quantity ' + previousQty + ' → ' + oi.Quantity);
            } else {
                OrderItem oi        = new OrderItem();
                oi.OrderId          = (Id) orderId;
                oi.PricebookEntryId = pbe.Id;
                oi.Quantity         = quantity;
                oi.UnitPrice        = pbe.UnitPrice;
                insert oi;
                actionDone  = 'añadido';
                orderItemId = oi.Id;
                System.debug(LoggingLevel.INFO, '[AddOrderItem][addOrderItem] INSERT OrderItem Id=' + oi.Id + ' | Quantity=' + quantity + ' | UnitPrice=' + pbe.UnitPrice);
            }

            Map<String, Object> response = new Map<String, Object>{
                'success'     => true,
                'message'     => pbe.Product2.Name + ' ' + actionDone + ' al pedido correctamente.',
                'orderItemId' => orderItemId
            };
            System.debug(LoggingLevel.INFO, '[AddOrderItem][addOrderItem] === SALIDA === actionDone=' + actionDone + ' | orderItemId=' + orderItemId);
            return response;

        } catch (QueryException qe) {
            System.debug(LoggingLevel.ERROR, '[AddOrderItem][addOrderItem] QueryException: ' + qe.getMessage() + '\n' + qe.getStackTraceString());
            throw new AuraHandledException('El producto seleccionado no está disponible en el pricebook: ' + qe.getMessage());
        } catch (DmlException dme) {
            System.debug(LoggingLevel.ERROR, '[AddOrderItem][addOrderItem] DmlException: ' + dme.getDmlMessage(0) + '\n' + dme.getStackTraceString());
            throw new AuraHandledException('No se pudo añadir el producto al pedido: ' + dme.getDmlMessage(0));
        }
    }


    // ─────────────────────────────────────────────────────────────────────────
    // MÉTODO: total acumulado del pedido (para refrescar el subtotal en el LWC)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Devuelve la suma de TotalPrice de todos los OrderItem del pedido.
     * Lo usa el LWC para mostrar el total parcial en la barra inferior
     * y refrescarlo cada vez que se añade un producto.
     */
    @AuraEnabled(cacheable=false)
    public static Decimal getOrderTotal(String orderId) {
        if (String.isBlank(orderId)) return 0;
        System.debug(LoggingLevel.INFO, '[AddOrderItem][getOrderTotal] orderId=' + orderId);
        AggregateResult[] rs = [
            SELECT SUM(TotalPrice) total
            FROM OrderItem
            WHERE OrderId = :orderId
        ];
        Decimal total = (rs == null || rs.isEmpty()) ? 0 : (Decimal) rs[0].get('total');
        if (total == null) total = 0;
        System.debug(LoggingLevel.INFO, '[AddOrderItem][getOrderTotal] total=' + total);
        return total;
    }


    // ─────────────────────────────────────────────────────────────────────────
    // MÉTODOS PRIVADOS DE SOPORTE
    // ─────────────────────────────────────────────────────────────────────────

    // Devuelve el Order con los campos necesarios para validar y para construir
    // la respuesta (Pricebook + Status). Lanza error si no existe.
    private static Order getOrder(String orderId) {
        System.debug(LoggingLevel.INFO, '[AddOrderItem][getOrder] Buscando Order Id=' + orderId);
        try {
            Order ord = [SELECT Id, Pricebook2Id, Status FROM Order WHERE Id = :orderId LIMIT 1];
            System.debug(LoggingLevel.INFO, '[AddOrderItem][getOrder] Encontrado: Status=' + ord.Status + ' | Pricebook2Id=' + ord.Pricebook2Id);
            return ord;
        } catch (QueryException qe) {
            System.debug(LoggingLevel.ERROR, '[AddOrderItem][getOrder] No encontrado. QueryException=' + qe.getMessage());
            throw new AuraHandledException('No se encontró el pedido con Id: ' + orderId);
        }
    }

    private static String getPricebookName(Id pricebookId) {
        try {
            Pricebook2 pb = [SELECT Name FROM Pricebook2 WHERE Id = :pricebookId LIMIT 1];
            return pb.Name;
        } catch (Exception e) {
            return '';
        }
    }

    private static List<PricebookEntry> findEntries(Id pricebookId, String query) {
        String term = query == null ? '' : query.trim();
        System.debug(LoggingLevel.INFO, '[AddOrderItem][findEntries] pricebookId=' + pricebookId + ' | term="' + term + '"');

        if (String.isBlank(term)) {
            System.debug(LoggingLevel.INFO, '[AddOrderItem][findEntries] Sin término → consulta sin filtro');
            List<PricebookEntry> defaults = [
                SELECT Id, UnitPrice,
                       Product2.Name, Product2.ProductCode, Product2.Family,
                       Product2.Image_URL__c, Product2.Spanish_Name_TXT__c
                FROM PricebookEntry
                WHERE Pricebook2Id = :pricebookId
                  AND IsActive = true
                  AND Product2.IsActive = true
                ORDER BY Product2.Name
                LIMIT :MAX_PRODUCTS
            ];
            System.debug(LoggingLevel.INFO, '[AddOrderItem][findEntries] Sin término → ' + defaults.size() + ' resultados');
            return defaults;
        }

        Set<String> tokens = extractTokens(term);
        System.debug(LoggingLevel.INFO, '[AddOrderItem][findEntries] Tokens extraídos: ' + tokens);

        List<PricebookEntry> phase1 = queryByLike(pricebookId, tokens);
        System.debug(LoggingLevel.INFO, '[AddOrderItem][findEntries] Fase 1 (LIKE) → ' + phase1.size() + ' resultados');
        if (phase1.size() >= MAX_PRODUCTS) {
            System.debug(LoggingLevel.INFO, '[AddOrderItem][findEntries] Suficientes con LIKE, sin fallback SOSL');
            return phase1;
        }

        Integer remaining = MAX_PRODUCTS - phase1.size();
        Set<Id> foundIds = new Set<Id>();
        for (PricebookEntry pbe : phase1) foundIds.add(pbe.Id);

        List<PricebookEntry> combined = new List<PricebookEntry>(phase1);
        List<PricebookEntry> phase2 = queryBySOSL(pricebookId, term, foundIds, remaining);
        System.debug(LoggingLevel.INFO, '[AddOrderItem][findEntries] Fase 2 (SOSL) → ' + phase2.size() + ' resultados adicionales');
        combined.addAll(phase2);
        System.debug(LoggingLevel.INFO, '[AddOrderItem][findEntries] TOTAL combinado=' + combined.size());
        return combined;
    }

    private static Set<String> extractTokens(String term) {
        Set<String> tokens = new Set<String>();
        for (String t : term.split('\\s+')) {
            if (t.trim().length() >= MIN_TOKEN_LENGTH) tokens.add(t.trim());
        }
        if (tokens.isEmpty()) tokens.add(term.trim());
        return tokens;
    }

    private static List<PricebookEntry> queryByLike(Id pricebookId, Set<String> tokens) {
        List<PricebookEntry> results = new List<PricebookEntry>();
        Set<Id> seen = new Set<Id>();

        for (String token : tokens) {
            String pattern = '%' + String.escapeSingleQuotes(token) + '%';
            for (PricebookEntry pbe : [
                SELECT Id, UnitPrice,
                       Product2.Name, Product2.ProductCode, Product2.Family,
                       Product2.Image_URL__c, Product2.Spanish_Name_TXT__c
                FROM PricebookEntry
                WHERE Pricebook2Id = :pricebookId
                  AND IsActive = true
                  AND Product2.IsActive = true
                  AND (
                      Product2.Name LIKE :pattern
                   OR Product2.ProductCode LIKE :pattern
                   OR Product2.Family LIKE :pattern
                   OR Product2.Spanish_Name_TXT__c LIKE :pattern
                  )
                ORDER BY Product2.Name
                LIMIT :MAX_PRODUCTS
            ]) {
                if (!seen.contains(pbe.Id)) {
                    seen.add(pbe.Id);
                    results.add(pbe);
                    if (results.size() >= MAX_PRODUCTS) return results;
                }
            }
        }
        return results;
    }

    private static List<PricebookEntry> queryBySOSL(Id pricebookId, String term, Set<Id> foundIds, Integer remaining) {
        List<PricebookEntry> results = new List<PricebookEntry>();
        try {
            String soslTerm = String.escapeSingleQuotes(term) + '*';
            List<List<SObject>> soslResults = Search.query(
                'FIND \'' + soslTerm + '\' IN ALL FIELDS RETURNING Product2(Id) LIMIT 20'
            );
            if (soslResults == null || soslResults.isEmpty() || soslResults[0].isEmpty()) return results;

            Set<Id> product2Ids = new Set<Id>();
            for (SObject so : soslResults[0]) product2Ids.add((Id) so.get('Id'));

            for (PricebookEntry pbe : [
                SELECT Id, UnitPrice,
                       Product2.Name, Product2.ProductCode, Product2.Family,
                       Product2.Image_URL__c, Product2.Spanish_Name_TXT__c
                FROM PricebookEntry
                WHERE Pricebook2Id = :pricebookId
                  AND IsActive = true
                  AND Product2.IsActive = true
                  AND Product2Id IN :product2Ids
                  AND Id NOT IN :foundIds
                ORDER BY Product2.Name
                LIMIT :remaining
            ]) {
                results.add(pbe);
            }
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, '[AddOrderItem][queryBySOSL] Excepción capturada: ' + e.getMessage() + '\n' + e.getStackTraceString());
        }
        System.debug(LoggingLevel.INFO, '[AddOrderItem][queryBySOSL] Resultados encontrados=' + results.size());
        return results;
    }
}