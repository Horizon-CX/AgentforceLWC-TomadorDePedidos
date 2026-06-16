import { LightningElement, api, track } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import searchProducts from '@salesforce/apex/AddOrderItemAgentforceController.searchProducts';
import addOrderItem   from '@salesforce/apex/AddOrderItemAgentforceController.addOrderItem';
import getOrderTotal  from '@salesforce/apex/AddOrderItemAgentforceController.getOrderTotal';

// ─── Textos de UI ────────────────────────────────────────────────────────────
const LABELS = Object.freeze({
    CardTitle:            'Productos',
    SearchingMessage:     'Buscando productos…',
    NoResultsMessage:     'No se encontraron productos para esa búsqueda. Inténtalo con otro término.',
    AddButton:            'Añadir al pedido',
    AddingButton:         'Añadiendo…',
    AddedButton:          'Añadido ✓',
    QuantityLabel:        'Cantidad',
    PricebookLabel:       'Tarifa:',
    AddMoreButton:        'Quiero añadir otro producto',
    FinishButton:         'Ver resumen del pedido',
    HavingIssuesButton:   'No encuentro el producto',
    AddMoreChatMessage:   'Quiero añadir otro producto',
    FinishChatMessage:    'Ver resumen del pedido',
    IssuesChatMessage:    'No encuentro el producto que estoy buscando',
    SubtotalLabel:        'Subtotal',
    OrderTotalLabel:      'Total parcial del pedido',
    InStockBadge:         'En stock',
    LowStockBadge:        'Pocas unidades',
    ToastAddedPrefix:     'añadido a tu pedido',
    SearchAnotherButton:  'Buscar otro producto',
    ErrorMissingConfig:   'Configuración incompleta. Falta el Id del pedido.',
    ErrorGeneric:         'Algo salió mal. Por favor, inténtalo de nuevo.',
    EmployeeInstruction:  'Cuando hayas terminado, dime si quieres añadir otro producto o revisar el pedido para finalizarlo.'
});

// Cuántos ms se mantiene visible el toast "+N <producto> añadido a tu pedido".
const TOAST_DURATION_MS = 2500;
// Cuántas tarjetas skeleton se muestran mientras se cargan los productos.
const SKELETON_CARDS = 3;
// Probabilidad (0-1) de que un producto salga con badge "Pocas unidades" (naranja)
// en lugar de "En stock" (verde). Hoy es simulación visual; cuando conectemos stock
// real esto desaparecerá y se decidirá según el valor del campo.
const LOW_STOCK_PROBABILITY = 0.5;

const FAMILY_ICON_MAP = Object.freeze({
    'Solar Panels':       'utility:energy',
    'Batteries':          'utility:battery_full',
    'Turbines':           'utility:rotate',
    'Service':            'utility:work_order_type',
    'Services':           'utility:work_order_type',
    'Software Licenses':  'utility:apps',
    'Kits':               'utility:package',
    'Part':               'utility:tools',
    'Product':            'utility:product',
    'Home Solutions':     'utility:home',
    'Lifestyle':          'utility:lifestyle',
    'Merchandise':        'utility:shopping_bag'
});

export default class AddOrderItemAgentforce extends NavigationMixin(LightningElement) {

    // value es el objeto del Lightning Type que pasa Agentforce.
    // Debe contener: { recordId, query }
    // recordId es siempre el Id del Order al que se añadirán los productos.
    @api value;

    @track _products       = [];
    @track _toasts         = [];      // Toasts "+N <producto> añadido a tu pedido"
    _loading               = false;
    _errorMessage          = null;
    _sessionDone           = false;
    _pricebookName         = '';
    _orderStatus           = '';      // Estado actual del Order (Draft, Activated, …)
    _canAddItems           = true;    // false si el pedido no está en Draft
    _orderTotal            = 0;       // Total parcial del Order (suma de TotalPrice de los OrderItems)
    _embeddedSendAvailable = null;
    _skeletonItems         = Array.from({ length: SKELETON_CARDS }, (_, i) => ({ key: 'sk-' + i }));

    get labels() { return LABELS; }

    // ─── Getters de configuración ────────────────────────────────────────────

    get orderId() { return this.value?.recordId; }
    get query()   { return this.value?.query || ''; }

    get hasConfig() {
        const oid = this.orderId;
        return oid != null && oid !== '';
    }

    // ─── Getters de visibilidad de secciones ─────────────────────────────────

    get showActiveLayout()        { return this.hasConfig && !this._sessionDone; }
    get showMissingConfig()       { return !this.hasConfig && !this._sessionDone; }
    get showSkeleton()            { return this._loading; }
    get skeletonItems()           { return this._skeletonItems; }
    get showProductList()         { return !this._loading && !this._errorMessage && this._canAddItems && this._products.length > 0; }
    get showEmptyMessage()        { return !this._loading && !this._errorMessage && this._canAddItems && this._products.length === 0; }
    get showNotEditableMessage()  { return !this._loading && !this._errorMessage && !this._canAddItems; }
    get showEmbeddedChatActions() { return this.showActiveLayout && this._canAddItems && !this.useEmployeeAgentExperience; }
    get showEmployeePanel()       { return this.showActiveLayout && this._canAddItems && this.useEmployeeAgentExperience; }
    get showOrderTotal()          { return this.showProductList && this._orderTotal > 0; }
    get hasToasts()               { return this._toasts.length > 0; }
    get orderTotalLabel()         { return this._formatCurrency(this._orderTotal); }

    get notEditableMessage() {
        return `Para añadir productos, el pedido debe estar en estado Draft. Estado actual: ${this._orderStatus || 'desconocido'}.`;
    }

    get pricebookLine() {
        return this._pricebookName ? `${LABELS.PricebookLabel} ${this._pricebookName}` : '';
    }

    // ─── Detección de Embedded Messaging ─────────────────────────────────────

    /**
     * En Embedded Messaging (chat de cliente), embeddedservice_configuration.util.sendTextMessage
     * está disponible y permite enviar mensajes al agente de forma silenciosa.
     * En Agent Desktop / Employee Experience NO está disponible, así que mostramos
     * instrucciones textuales en su lugar.
     */
    get useEmployeeAgentExperience() {
        const available = this._embeddedSendAvailable !== null
            ? this._embeddedSendAvailable
            : this._computeEmbeddedAvailable();
        return !available;
    }

    _computeEmbeddedAvailable() {
        try {
            return (
                typeof embeddedservice_configuration !== 'undefined' &&
                embeddedservice_configuration?.util?.sendTextMessage != null &&
                typeof embeddedservice_configuration.util.sendTextMessage === 'function'
            );
        } catch (e) {
            return false;
        }
    }

    _refreshEmbeddedAvailability() {
        const next = this._computeEmbeddedAvailable();
        if (this._embeddedSendAvailable !== next) this._embeddedSendAvailable = next;
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    connectedCallback() {
        // ─── DEBUG: qué llega del Lightning Type ─────────────────────────────
        // Esto sale en la consola del navegador cada vez que Atlas invoca la action.
        // Si no ves estos logs, significa que el LWC no se ha renderizado (Atlas alucinó).
        // eslint-disable-next-line no-console
        console.log('%c[addOrderItemAgentforce] connectedCallback', 'color:#0070d2;font-weight:bold');
        // eslint-disable-next-line no-console
        console.log('  value recibido =', JSON.stringify(this.value, null, 2));
        // eslint-disable-next-line no-console
        console.log('  orderId (value.recordId) =', this.orderId);
        // eslint-disable-next-line no-console
        console.log('  query   (value.query)    =', this.query);
        // eslint-disable-next-line no-console
        console.log('  hasConfig =', this.hasConfig);

        this._refreshEmbeddedAvailability();
        // Reintentos porque embeddedservice_configuration puede cargarse tarde
        [0, 100, 300, 800, 2000].forEach((ms) => {
            setTimeout(() => this._refreshEmbeddedAvailability(), ms);
        });

        if (this.hasConfig) {
            this._loadProducts();
        }
    }

    renderedCallback() {
        this._refreshEmbeddedAvailability();
    }

    // ─── Carga de productos ───────────────────────────────────────────────────

    _loadProducts() {
        this._loading      = true;
        this._errorMessage = null;
        this._products     = [];

        // eslint-disable-next-line no-console
        console.log('%c[addOrderItemAgentforce] searchProducts → llamando Apex', 'color:#0070d2', { orderId: this.orderId, query: this.query });

        searchProducts({ orderId: this.orderId, query: this.query })
            .then((data) => {
                // eslint-disable-next-line no-console
                console.log('%c[addOrderItemAgentforce] searchProducts ← respuesta', 'color:#027e46', data);
                // El controlador ahora devuelve { items, orderStatus, canAddItems, pricebookName }.
                this._orderStatus   = data?.orderStatus   || '';
                this._canAddItems   = data?.canAddItems   ?? true;
                this._pricebookName = data?.pricebookName || '';
                this._products      = (data?.items || []).map((p) => this._toViewModel(p));
                this._loading       = false;
                // Cargamos también el total acumulado del pedido para mostrarlo en la barra inferior.
                this._refreshOrderTotal();
            })
            .catch((error) => {
                // eslint-disable-next-line no-console
                console.error('[addOrderItemAgentforce] searchProducts ← ERROR', error);
                this._errorMessage = error?.body?.message || LABELS.ErrorGeneric;
                this._loading      = false;
            });
    }

    _toViewModel(p) {
        return {
            pricebookEntryId: p.pricebookEntryId,
            productName:      p.productNameEs || p.productName,
            productCode:      p.productCode,
            family:           p.family,
            unitPrice:        Number(p.unitPrice) || 0,
            unitPriceLabel:   this._formatCurrency(p.unitPrice),
            imageUrl:         p.imageUrl || null,
            iconName:         FAMILY_ICON_MAP[p.family] || 'utility:product',
            product2Id:       p.product2Id || null,
            quantity:         1,
            adding:           false,
            added:            false,
            error:            null,
            imageLoadError:   false,
            // Estado de stock aleatorio (simulación visual). Se calcula UNA sola vez al
            // cargar el producto para que el badge sea ESTABLE durante toda la sesión:
            // si lo metiéramos en displayProducts, cambiaría en cada render (cada vez
            // que el usuario toca una cantidad) y daría sensación de bug.
            isLowStock:       Math.random() < LOW_STOCK_PROBABILITY
        };
    }

    // ─── Handlers de UI ──────────────────────────────────────────────────────


    handleImageClick(event) {
        // En el chat externo (Embedded Messaging) abrimos la URL pública de la imagen
        // en otra pestaña: el cliente final no tiene acceso al registro de Salesforce,
        // así que llevarle al record no le sirve.
        if (!this.useEmployeeAgentExperience) {
            const imageUrl = event.currentTarget.dataset.imageUrl;
            if (!imageUrl) return;
            window.open(imageUrl, '_blank', 'noopener');
            return;
        }

        // Agente interno (Employee/Agent Desktop): navegación SPA al registro Product2.
        const product2Id = event.currentTarget.dataset.product2id;
        if (!product2Id) return;
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: { recordId: product2Id, actionName: 'view' }
        });
    }

    handleImageError(event) {
        const id = event.target.dataset.id;
        this._setProductState(id, { imageLoadError: true });
    }

    handleQuantityChange(event) {
        const id  = event.target.dataset.id;
        const qty = Math.max(1, Math.floor(Number(event.target.value) || 1));
        this._setQuantity(id, qty);
    }

    handleDecrement(event) {
        // currentTarget asegura que cogemos el data-id del propio <button>, no de un hijo.
        const id   = event.currentTarget.dataset.id;
        const prod = this._products.find((p) => p.pricebookEntryId === id);
        if (prod) this._setQuantity(id, Math.max(1, prod.quantity - 1));
    }

    handleIncrement(event) {
        const id   = event.currentTarget.dataset.id;
        const prod = this._products.find((p) => p.pricebookEntryId === id);
        if (prod) this._setQuantity(id, prod.quantity + 1);
    }

    _setQuantity(pricebookEntryId, qty) {
        const safe = Math.max(1, Math.floor(Number(qty) || 1));
        this._products = this._products.map((p) =>
            p.pricebookEntryId === pricebookEntryId ? { ...p, quantity: safe } : p
        );
    }

    // Refresca el total parcial del Order llamando a Apex.
    // Se invoca tras cargar productos y tras cada "Añadir al pedido" con éxito.
    _refreshOrderTotal() {
        if (!this.orderId) return;
        getOrderTotal({ orderId: this.orderId })
            .then((total) => {
                this._orderTotal = Number(total) || 0;
            })
            .catch((err) => {
                // Si falla no rompemos la UX; simplemente no actualizamos el total.
                // eslint-disable-next-line no-console
                console.error('[addOrderItemAgentforce] getOrderTotal error', err);
            });
    }

    // Empuja un toast a la lista. Se autoelimina tras TOAST_DURATION_MS.
    _pushToast(message) {
        const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        this._toasts = [...this._toasts, { id, message }];
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => {
            this._toasts = this._toasts.filter((t) => t.id !== id);
        }, TOAST_DURATION_MS);
    }

    handleAddProduct(event) {
        // currentTarget = el <button> con data-id. Usamos esto en lugar de event.target
        // porque el target podría ser un hijo (el <span> con el texto) sin data-id, lo
        // que provocaba que el click se descartara silenciosamente y pareciera que el
        // botón necesitaba dos clicks para responder.
        const id      = event.currentTarget.dataset.id;
        const product = this._products.find((p) => p.pricebookEntryId === id);
        if (!product || product.adding || product.added) return;

        this._setProductState(id, { adding: true, error: null });

        // eslint-disable-next-line no-console
        console.log('%c[addOrderItemAgentforce] addOrderItem → llamando Apex', 'color:#0070d2', {
            orderId:          this.orderId,
            pricebookEntryId: id,
            quantity:         product.quantity,
            productName:      product.productName
        });

        addOrderItem({
            orderId:          this.orderId,
            pricebookEntryId: id,
            quantity:         product.quantity
        })
            .then(() => {
                // No enviamos mensaje al chat aquí: el usuario puede añadir varios productos
                // seguidos y solo queremos notificar al agente cuando pulse "He terminado" o
                // "Tengo un problema", para no inundar la conversación.
                this._setProductState(id, { adding: false, added: true });
                // Disparamos el toast de confirmación visual y refrescamos el total acumulado.
                this._pushToast(`+${product.quantity}  ${product.productName}  ${LABELS.ToastAddedPrefix}`);
                this._refreshOrderTotal();
            })
            .catch((error) => {
                const msg = error?.body?.message || LABELS.ErrorGeneric;
                this._setProductState(id, { adding: false, added: false, error: msg });
            });
    }

    handleAddMore() {
        this._sendChatMessage(LABELS.AddMoreChatMessage);
        this._sessionDone = true;
    }

    handleFinish() {
        this._sendChatMessage(LABELS.FinishChatMessage);
        this._sessionDone = true;
    }

    handleHavingIssues() {
        this._sendChatMessage(LABELS.IssuesChatMessage);
        this._sessionDone = true;
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    _setProductState(pricebookEntryId, patch) {
        this._products = this._products.map((p) =>
            p.pricebookEntryId === pricebookEntryId ? { ...p, ...patch } : p
        );
    }

    _formatCurrency(value) {
        const n = Number(value) || 0;
        try {
            return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
        } catch (e) {
            return `${n.toFixed(2)} €`;
        }
    }

    _sendChatMessage(text) {
        if (!this._computeEmbeddedAvailable()) return;
        try {
            const p = embeddedservice_configuration.util.sendTextMessage(text);
            if (p && typeof p.catch === 'function') {
                p.catch((err) => console.error('[addOrderItemAgentforce] sendTextMessage error', err));
            }
        } catch (err) {
            console.error('[addOrderItemAgentforce] sendChatMessage error', err);
        }
    }

    // ─── Getters de displayItems ──────────────────────────────────────────────

    get displayProducts() {
        return this._products.map((p) => {
            const imageOk      = !!p.imageUrl && !p.imageLoadError;
            const qty          = Number(p.quantity) || 0;
            const unitPrice    = Number(p.unitPrice) || 0;
            const subtotal     = unitPrice * qty;
            // Mostrar subtotal solo cuando aporta valor (qty > 1); con qty=1 es redundante con el precio unitario.
            const showSubtotal = qty > 1;
            return {
                ...p,
                showImage:         imageOk,
                showFallbackIcon:  !imageOk,
                imageClass:        p.product2Id ? 'product-image product-image_clickable' : 'product-image',
                iconClass:         p.product2Id ? 'product-image-fallback product-image_clickable' : 'product-image-fallback',
                addButtonLabel:    p.added ? LABELS.AddedButton : p.adding ? LABELS.AddingButton : LABELS.AddButton,
                addButtonClass:    p.added ? 'add-btn add-btn_added' : 'add-btn',
                addButtonDisabled: p.added || p.adding,
                subtotalLabel:     this._formatCurrency(subtotal),
                showSubtotal:      showSubtotal,
                cardClass:         p.added ? 'product-card product-card_added' : 'product-card',
                // Clase y texto del badge de stock derivados del flag estable isLowStock
                // (calculado en _toViewModel). Verde por defecto, naranja si poco stock.
                stockBadgeClass:   p.isLowStock
                    ? 'product-stock-badge product-stock-badge_low'
                    : 'product-stock-badge',
                stockLabel:        p.isLowStock ? LABELS.LowStockBadge : LABELS.InStockBadge
            };
        });
    }
}