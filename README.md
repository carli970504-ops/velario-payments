# Servidor de pagos de Velario

La app gratuita funciona sin este servidor. Pro solo se activa tras una respuesta verificada de este servicio por HTTPS; ni una bandera guardada en el dispositivo ni la página de retorno de un pago activan Pro.

Este servicio está implementado y probado localmente con adaptadores aislados. **No se ha desplegado ni conectado a cuentas comerciales y no se han realizado cobros.** Sin configuración, todos los métodos figuran deshabilitados. Los secretos de este directorio nunca deben introducirse en el APK, el EXE ni en sus archivos públicos.

## Arranque local

Requiere Node.js 24 o posterior. No necesita paquetes externos. Desde esta carpeta:

```powershell
node --test test/*.test.mjs
node --env-file-if-exists=.env src/index.mjs
```

El proceso escucha en `127.0.0.1:8787` por defecto. `node:sqlite` puede emitir una advertencia según la versión de Node. Los datos se guardan en `data/velario.sqlite`. La base contiene tokens de compra: restringir sus permisos a la cuenta del servicio, cifrar el disco/copia de seguridad y excluirla de entregas y repositorios.

Copiar `.env.example` a `.env` y rellenar únicamente en el servidor. Usar HTTPS con un proxy inverso y `PUBLIC_BASE_URL` real. No publicar el puerto de desarrollo directamente. Respaldar SQLite con un mecanismo compatible con WAL.

## Contrato para las apps

| Operación | Solicitud | Respuesta |
|---|---|---|
| Estado de configuración | `GET /api/config` | Producto, precio, modo y métodos configurados |
| Sesión de instalación | `POST /api/session` | `accountId`, `token` aleatorio de 256 bits |
| Consultar/restaurar Pro | `GET /api/entitlement` | `active`, `productId`, `expiresAt`, `status`, `verifiedAt`, `methods` |
| Checkout en proveedor | `POST /api/checkout`, `{method: card\|applepay\|googlepay\|link\|paypal}` | URL HTTPS del proveedor |
| Verificar recibo Play | `POST /api/play/verify`, `{purchaseToken}` | Estado Pro verificado |
| Comprobar Play antes de comprar | `GET /api/play/ready` | `ready:true`, producto y base plan tras consulta Google |
| Gestionar/cancelar | `POST /api/manage` | URL del portal de suscripción |

Las operaciones de usuario requieren `Authorization: Bearer <token>`. El cliente nativo conserva ese token; no lo introduce en HTML, localStorage, URL o registros. Los endpoints no usan cookies ni CORS. El estado se consulta de nuevo en los proveedores en cada restauración. Si el proveedor no responde, no se concede Pro con un dato obsoleto.

`accountId` es un UUID sin información personal. Android debe enviarlo en `BillingFlowParams.setObfuscatedAccountId(accountId)` antes de comprar. El servidor verifica su coincidencia con `externalAccountIdentifiers.obfuscatedExternalAccountId`.

Antes de abrir Play Billing, el cliente consulta `/api/play/ready`: este endpoint comprueba las credenciales y el plan semanal en Google. Una URL de servidor configurada no basta para habilitar un cobro. Además, el cliente comprueba el precio/periodo que muestra Play y el estado Pro actual.

## Configuración comercial pendiente

1. **Stripe**: crear un precio activo de `200` centavos `USD`, intervalo `week`, cantidad `1`. Configurar la clave secreta, `STRIPE_PRICE_ID` y el secreto de webhook. Activar el portal de cliente con cancelación. Suscribir `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`. Endpoint: `/webhooks/stripe`.
2. **PayPal**: una app REST, plan activo con un único ciclo regular de `2.00 USD` cada semana, sin prueba ni cuota inicial; duración indefinida. Claves, ID del plan e ID del webhook en `.env`. Eventos `BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.REFUNDED` y `PAYMENT.SALE.REVERSED`. Endpoint: `/webhooks/paypal`.
3. **Google Play**: producto `velario.pro.weekly`, base plan `weekly`, duración `P1W`, precio estadounidense `2 USD`. Cuenta de servicio con acceso a la app en Play Console y permisos de compras/suscripciones; su JSON permanece en el servidor. Se verifica con `purchases.subscriptionsv2.get` y se reconoce únicamente tras la validación de producto, plan, identidad y fecha. Las pruebas reales de Play requieren una versión publicada en un track de prueba y un tester autorizado.

`PAYMENTS_MODE=test` usa Stripe test y PayPal sandbox, y admite compras de prueba de Play. El modo `live` rechaza claves Stripe de test y compras de prueba Google. La aplicación no crea productos, cuentas comerciales, claves ni cobros automáticamente.

Tarjetas de débito/crédito y Apple Pay se procesan con Checkout de Stripe. **Apple Pay se ofrece solo cuando el proveedor, el país, la cuenta y el dispositivo/navegador del cliente lo admiten**. El backend no promete Apple Pay nativo en Windows. En Android distribuido por Google Play, usar Play Billing para el contenido digital; los métodos externos no se presentan como una alternativa que eluda las reglas de la tienda.

## Persistencia, revocación y límites comprobados

- SQLite guarda hash del token de sesión, vínculo de compra a su propietario y eventos procesados. Una compra no puede reasignarse a otra instalación mediante otra llamada al endpoint.
- Los clientes nativos deben vincular la cuenta guardada con la URL HTTPS del servidor original. Un cambio de servidor no autoriza transmitir el token previo a la dirección nueva.
- Stripe verifica la firma HMAC del cuerpo original con tolerancia de cinco minutos. PayPal valida la firma con el endpoint oficial. Un evento repetido responde con éxito sin repetir efectos.
- Tras un webhook se consulta el estado autoritativo; no se confía en una redirección de éxito ni en JSON del cliente. El precio esperado se verifica antes de iniciar el checkout.
- Expiración, suspensión, impago, revocación y ausencia de verificación conservan el nivel gratuito. Stripe inspecciona además la factura y su cargo actual para detectar reembolsos/disputas incluso si el webhook se demora. La restauración Play vuelve a consultar Google, sin depender de notificaciones push.
- Las sesiones actuales son **por instalación**. El token nativo permite restaurar en la misma instalación. La recuperación tras pérdida del dispositivo/reinstalación y la compra multiplataforma con una cuenta única requieren un flujo de identidad y recuperación de cuenta antes de publicar comercialmente; no se ha inventado ese acceso ni se ha afirmado que ya exista.
- El contenido educativo se incluye localmente para uso sin conexión. El control de acceso de la app evita desbloqueos accidentales o una bandera Pro heredada; no es DRM frente a un APK/EXE modificado por terceros.

## Diagnóstico de proveedores

Antes de culpar a la app, este comando dice qué proveedor está operativo y qué variable, permiso o precio falta, sin imprimir ninguna clave:

```powershell
node --env-file-if-exists=.env src/diagnose.mjs
```

Sale con código 1 si algún proveedor configurado falla. Distingue clave rechazada (401), precio o plan inexistente (404), clave sin permiso (403), precio/periodo incorrecto (503) y error de API. Con `DIAGNOSTICS_TOKEN` definido en el servidor, el mismo informe está en `GET /api/diagnostics` con `Authorization: Bearer <token>`; sin ese token la ruta responde 404 y con un token incorrecto 401. El token debe tener 24 caracteres o más.

## Pruebas incluidas

Las pruebas locales cubren métodos sin configurar, credenciales omitidas, banderas Pro manipuladas, checkout que no concede acceso, clics duplicados, vencimiento/cancelación, error del proveedor, webhook falso/repetido, revocación de filas duplicadas, recibos reutilizados por otra cuenta, firma Stripe adulterada/caducada, reembolso sin webhook, reconocimiento Google solo tras validar al propietario y rechazo de precios/periodos incorrectos antes de iniciar un pago. Los adaptadores de prueba no realizan llamadas ni cobros externos. No sustituyen pruebas sandbox con cuentas del comerciante.

## Documentación oficial consultada

- [Stripe Checkout Sessions](https://docs.stripe.com/api/checkout/sessions/create)
- [Stripe verificación y entrega de webhooks](https://docs.stripe.com/events/manage-webhook-endpoints)
- [Stripe Invoice Payments](https://docs.stripe.com/api/invoice-payment/list)
- [Stripe Apple Pay](https://docs.stripe.com/apple-pay)
- [PayPal verificación de webhooks](https://developer.paypal.com/api/rest/webhooks/rest/)
- [PayPal eventos de suscripciones](https://developer.paypal.com/subscriptions/webhooks)
- [Google subscriptionsv2.get](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get)
- [Google lectura del producto/base plan](https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.subscriptions/get)
- [Google ciclo de vida y reconocimiento](https://developer.android.com/google/play/billing/lifecycle/subscriptions)
