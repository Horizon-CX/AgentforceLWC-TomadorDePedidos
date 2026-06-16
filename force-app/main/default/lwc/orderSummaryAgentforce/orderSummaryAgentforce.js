import { LightningElement, api } from 'lwc';
import { NavigationMixin }      from 'lightning/navigation';
import getOrderSummary   from '@salesforce/apex/OrderSummaryController.getOrderSummary';
import finalizeOrder     from '@salesforce/apex/OrderSummaryController.finalizeOrder';
import updateOrderItems  from '@salesforce/apex/OrderSummaryController.updateOrderItems';

// ─── Textos de UI ────────────────────────────────────────────────────────────
const LABELS = Object.freeze({
    CardTitle:           'Resumen del pedido',
    TotalLabel:          'Total',
    // Modo Confirm
    FinalizeButton:      'Finalizar pedido',
    FinalizingButton:    'Finalizando…',
    FinalizedMessage:    'Pedido finalizado correctamente.',
    DoneChatMessage:     'He finalizado mi pedido.',
    // Modo Modify
    SaveButton:          'Guardar cambios',
    SavingButton:        'Guardando…',
    SavedMessage:        'Cambios guardados correctamente.',
    ModifiedChatMessage: 'He modificado mi pedido.',
    // Botón secundario común
    AddMoreButton:       'Quiero añadir más productos',
    AddMoreChatMessage:  'Quiero añadir más productos',
    // Comunes
    OrderLabel:          'Pedido',
    AccountLabel:        'Cliente',
    ErrorMissingConfig:  'Configuración incompleta. Falta el Id del pedido.',
    ErrorGeneric:        'Algo salió mal. Por favor, inténtalo de nuevo.',
    EmptyOrder:          'Este pedido no tiene productos.'
});

// Mapa de iconos SLDS por Product Family. Si la familia no está aquí se usa el fallback.
const FAMILY_ICON_MAP = Object.freeze({
    'Solar Panels':      'utility:energy',
    'Batteries':         'utility:battery_full',
    'Turbines':          'utility:rotate',
    'Service':           'utility:work_order_type',
    'Services':          'utility:work_order_type',
    'Software Licenses': 'utility:apps',
    'Kits':              'utility:package',
    'Part':              'utility:tools',
    'Product':           'utility:product',
    'Home Solutions':    'utility:home',
    'Lifestyle':         'utility:lifestyle',
    'Merchandise':       'utility:shopping_bag'
});

export default class OrderSummaryAgentforce extends NavigationMixin(LightningElement) {

    // value es el objeto del Lightning Type que pasa Agentforce.
    // Estructura esperada: { recordId: '<Id del Order>', mode: 'Confirm'|'Modify'|'Confirmar'|'Modificar' }
    @api value;

    // ─── Estado interno ──────────────────────────────────────────────────────
    _items        = [];
    _summary      = null;
    _loading      = false;
    _busy         = false;     // En curso (finalizando o guardando).
    _errorMessage = null;
    _finalized    = false;     // true tras finalizar/guardar (acción principal). Muestra la tarjeta verde de éxito.
    _dismissed    = false;     // true tras "Quiero añadir más productos". Oculta el componente sin mostrar tarjeta verde.

    // ─── Getters de configuración ────────────────────────────────────────────

    get labels()    { return LABELS; }
    get orderId()   { return this.value?.recordId; }
    get hasConfig() { return !!this.orderId; }

    // Normaliza el parámetro mode a 'confirm' | 'modify'. Default: 'confirm'.
    get _mode() {
        const raw = (this.value?.mode || '').toString().toLowerCase().trim();
        if (raw === 'modify' || raw === 'modificar') return 'modify';
        return 'confirm';
    }

    get isConfirmMode() { return this._mode === 'confirm'; }
    get isModifyMode()  { return this._mode === 'modify'; }

    // ─── Getters de visibilidad de secciones ─────────────────────────────────

    get showMissingConfig() { return !this.hasConfig; }
    // El componente activo se oculta tanto al finalizar (muestra tarjeta verde)
    // como al "descartarse" (queda invisible sin tarjeta — flujo "Quiero añadir más productos").
    get showActiveLayout()  { return this.hasConfig && !this._finalized && !this._dismissed; }
    get showFinalizedCard() { return this._finalized; }
    get showEmptyMessage()  { return !this._loading && !this._errorMessage && this._items.length === 0; }
    get showItemList()      { return !this._loading && !this._errorMessage && this._items.length > 0; }

    // ─── Getters de la cabecera del pedido ───────────────────────────────────

    get orderNumber()   { return this._summary?.orderNumber  || ''; }
    get accountName()   { return this._summary?.accountName  || ''; }
    get pricebookLine() { return this._summary?.pricebookName ? `Tarifa: ${this._summary.pricebookName}` : ''; }

    // canEdit viene de Apex: false si el pedido no está en Draft.
    // Mantenemos compatibilidad con canFinalize que devolvía lo mismo.
    get canEdit() { return this._summary?.canEdit ?? this._summary?.canFinalize ?? true; }

    // Total calculado en cliente para reflejar los cambios de cantidad en vivo.
    get totalAmount() {
        const total = this._items.reduce((sum, i) => sum + (i.unitPrice * i.quantity), 0);
        return this._formatCurrency(total);
    }

    // Texto del botón principal según modo y estado.
    get actionButtonLabel() {
        if (this._busy) {
            return this.isConfirmMode ? LABELS.FinalizingButton : LABELS.SavingButton;
        }
        return this.isConfirmMode ? LABELS.FinalizeButton : LABELS.SaveButton;
    }

    get actionButtonDisabled() { return this._busy || !this.canEdit; }

    // Mensaje que se envía al chat tras un éxito.
    get _chatMessageOnSuccess() {
        return this.isConfirmMode ? LABELS.DoneChatMessage : LABELS.ModifiedChatMessage;
    }

    // Mensaje final que se muestra al usuario en la tarjeta verde tras la acción.
    // En modo Confirm: "Pedido finalizado correctamente.". En modo Modify: "Cambios guardados correctamente."
    get finalizedMessage() {
        return this.isConfirmMode ? LABELS.FinalizedMessage : LABELS.SavedMessage;
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    connectedCallback() {
        if (this.hasConfig) this._load();
    }

    // ─── Carga del resumen ───────────────────────────────────────────────────

    _load() {
        this._loading      = true;
        this._errorMessage = null;
        this._items        = [];
        this._summary      = null;

        getOrderSummary({ orderId: this.orderId })
            .then((data) => {
                this._summary = data;
                this._items   = (data.items || []).map((i) => this._toViewModel(i));
                this._loading = false;
            })
            .catch((err) => {
                this._errorMessage = err?.body?.message || LABELS.ErrorGeneric;
                this._loading      = false;
            });
    }

    // Convierte una línea de Apex a la forma mínima que necesita el componente.
    _toViewModel(line) {
        return {
            orderItemId:    line.orderItemId,
            productName:    line.productNameEs || line.productName,
            productCode:    line.productCode,
            family:         line.family,
            unitPrice:      Number(line.unitPrice) || 0,
            imageUrl:       line.imageUrl || null,
            product2Id:     line.product2Id || null,
            quantity:       Number(line.quantity) || 0,
            imageLoadError: false
        };
    }

    // ─── Handlers de UI ──────────────────────────────────────────────────────

    // Cantidad mínima permitida: 0. Si una línea se queda en 0, al guardar se borra.
    handleQuantityChange(event) {
        // event.target aquí es el <input> en sí (no tiene hijos), así que es seguro.
        const qty = Math.max(0, Math.floor(Number(event.target.value) || 0));
        this._updateQuantity(event.target.dataset.id, qty);
    }

    handleDecrement(event) {
        // currentTarget = el <button> con data-id. Usamos currentTarget en lugar de
        // target porque el click puede caer sobre un hijo del botón y target apuntaría
        // a un elemento sin data-id, perdiéndose el handler.
        const id   = event.currentTarget.dataset.id;
        const item = this._items.find((i) => i.orderItemId === id);
        if (item) this._updateQuantity(id, Math.max(0, item.quantity - 1));
    }

    handleIncrement(event) {
        const id   = event.currentTarget.dataset.id;
        const item = this._items.find((i) => i.orderItemId === id);
        if (item) this._updateQuantity(id, item.quantity + 1);
    }

    handleImageClick(event) {
        // En el chat externo (Embedded Messaging) abrimos la URL pública de la imagen
        // en otra pestaña: el cliente final no tiene acceso al registro de Salesforce,
        // así que llevarle al record no le sirve.
        if (this._isEmbeddedMessaging()) {
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

    // Detecta si el LWC se está renderizando dentro del chat externo
    // (Embedded Messaging) comprobando la presencia de su API global.
    _isEmbeddedMessaging() {
        try {
            return (
                typeof embeddedservice_configuration !== 'undefined' &&
                typeof embeddedservice_configuration?.util?.sendTextMessage === 'function'
            );
        } catch (e) {
            return false;
        }
    }

    handleImageError(event) {
        const id = event.target.dataset.id;
        this._items = this._items.map((i) =>
            i.orderItemId === id ? { ...i, imageLoadError: true } : i
        );
    }

    /*
     * Botón principal:
     *  - Modo Confirm → finaliza el pedido (activa el Order en Salesforce).
     *  - Modo Modify  → guarda los cambios sin activar.
     * En ambos casos, al éxito se muestra la tarjeta verde de finalización
     * y el componente desaparece como activo.
     */
    handleAction() {
        if (this._busy) return;

        this._busy         = true;
        this._errorMessage = null;

        const updates  = this._collectUpdates();
        const apexCall = this.isConfirmMode
            ? finalizeOrder({ orderId: this.orderId, itemUpdates: updates })
            : updateOrderItems({ orderId: this.orderId, itemUpdates: updates });

        apexCall
            .then(() => {
                this._sendChatMessage(this._chatMessageOnSuccess);
                this._finalized = true;
                this._busy      = false;
            })
            .catch((err) => {
                this._errorMessage = err?.body?.message || LABELS.ErrorGeneric;
                this._busy         = false;
            });
    }

    /*
     * Botón secundario "Quiero añadir más productos":
     *  - SIEMPRE llama a updateOrderItems (nunca finalizeOrder): no debe activar el
     *    pedido aunque estemos en modo Confirm, porque después seguimos editando.
     *  - Al éxito, marca _dismissed = true (NO _finalized): el componente desaparece
     *    sin dejar la tarjeta verde "Pedido finalizado correctamente", porque a
     *    continuación el agente renderizará el selector de productos.
     */
    handleAddMore() {
        if (this._busy) return;

        this._busy         = true;
        this._errorMessage = null;

        updateOrderItems({ orderId: this.orderId, itemUpdates: this._collectUpdates() })
            .then(() => {
                this._sendChatMessage(LABELS.AddMoreChatMessage);
                this._dismissed = true;
                this._busy      = false;
            })
            .catch((err) => {
                this._errorMessage = err?.body?.message || LABELS.ErrorGeneric;
                this._busy         = false;
            });
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /*
     * Recoge las cantidades actuales de cada línea leyendo directamente del DOM
     * (no del estado _items) para evitar problemas de timing entre el oninput
     * del stepper y el onclick del botón. Devuelve el array listo para Apex.
     */
    _collectUpdates() {
        const qtyByItem = {};
        this.template.querySelectorAll('.qty-input').forEach((input) => {
            const id = input.dataset.id;
            if (id) qtyByItem[id] = Math.max(0, Math.floor(Number(input.value) || 0));
        });
        return this._items.map((i) => ({
            orderItemId: i.orderItemId,
            quantity:    qtyByItem[i.orderItemId] ?? i.quantity
        }));
    }

    _updateQuantity(orderItemId, quantity) {
        const safe = Math.max(0, Math.floor(Number(quantity) || 0));
        this._items = this._items.map((i) =>
            i.orderItemId === orderItemId ? { ...i, quantity: safe } : i
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

    // Envía un mensaje al chat del agente. Solo funciona en Embedded Messaging
    // (chat de cliente); en Agent Desktop esta API no existe y la llamada se ignora.
    _sendChatMessage(text) {
        try {
            if (
                typeof embeddedservice_configuration !== 'undefined' &&
                typeof embeddedservice_configuration?.util?.sendTextMessage === 'function'
            ) {
                const p = embeddedservice_configuration.util.sendTextMessage(text);
                if (p && typeof p.catch === 'function') {
                    p.catch((err) => console.error('[orderSummaryAgentforce] sendTextMessage error', err));
                }
            }
        } catch (err) {
            console.error('[orderSummaryAgentforce] sendChatMessage error', err);
        }
    }

    // ─── Getter de displayItems ──────────────────────────────────────────────

    // Vista lista para renderizar: añade los campos calculados sin tocar _items.
    get displayItems() {
        return this._items.map((i) => {
            const imageOk    = !!i.imageUrl && !i.imageLoadError;
            const willDelete = i.quantity === 0;
            return {
                ...i,
                showImage:        imageOk,
                showFallbackIcon: !imageOk,
                unitPriceLabel:   this._formatCurrency(i.unitPrice),
                totalPriceLabel:  this._formatCurrency(i.unitPrice * i.quantity),
                iconName:         FAMILY_ICON_MAP[i.family] || 'utility:product',
                imageClass:       i.product2Id ? 'item-image item-image_clickable' : 'item-image',
                iconClass:        i.product2Id ? 'item-image-fallback item-image_clickable' : 'item-image-fallback',
                cardClass:        willDelete ? 'item-card item-card_to-delete' : 'item-card'
            };
        });
    }
}