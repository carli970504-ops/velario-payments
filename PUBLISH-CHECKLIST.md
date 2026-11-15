# Checklist de publicacion en tiendas

Estado real a fecha de este documento. Nada de esta lista esta hecho salvo lo marcado como HECHO.

## 1. Decision previa obligatoria: por donde se cobra

La app de escritorio cobra hoy con Stripe (2 USD/semana) contra un servidor propio. Eso
funciona en PC, pero **no es aceptable tal cual en las tiendas moviles**:

- **Apple (App Store Review Guidelines 3.1.1)**: las suscripciones a contenido digital
  consumido dentro de la app deben usar In-App Purchase. Stripe o PayPal por fuera se
  rechazan (solo hay excepciones para bienes fisicos, servicios de persona a persona y
  apps "reader" como Netflix o Kindle, que no es el caso).
- **Google Play (Payments policy)**: igual, con In-App Billing para contenido digital.

Por tanto hay dos caminos, y hay que elegir uno antes de invertir en publicar:

| Camino | Que implica | Estado |
| --- | --- | --- |
| A. Solo PC (Microsoft Store o instalador propio) | Stripe valido. Falta instalador firmado y ficha de tienda. | Pendiente |
| B. Movil (App Store + Google Play) | Crear proyecto Android/iOS y mover el cobro a IAP. El servidor ya sabe verificar compras de Google Play (`GoogleProvider`), pero no existe app que las genere. | Pendiente, es trabajo nuevo |

## 2. Lo que ya esta hecho y verificado

- [x] Servidor de pagos en produccion: `https://velario-payments.onrender.com`, `/health` 200.
- [x] Stripe: producto, precio semanal de 2 USD, checkout, idempotencia, webhook firmado.
- [x] Compra real de prueba completada y cuenta vinculada (`dd4b59b2-...`, activa hasta 2026-11-18).
- [x] Restauracion de cuenta: la app consulta su estado y recibe `active:true` sin depender de la base local.
- [x] `ACCOUNT_SECRET` fijado (el vinculo compra-cuenta ya no depende de la clave de Stripe).
- [x] Despliegue automatico en cada push, comprobado.
- [x] App de escritorio: carga sin pantalla en blanco (Inicio, Aprende y Perfil con contenido), sin errores de consola, CSP correcta.

## 3. Bloqueos que dependen de ti

- [x] **PayPal (opcional)**: decidido dejarlo fuera por ahora, no bloquea nada. La app cobra con tarjeta, Apple Pay, Google Pay y Link. Si algun dia se quiere anadir, crear la app en developer.paypal.com, dejar client id + secret en `.paypal-creds` y ejecutar `node tools/paypal_setup.mjs` (ya reutiliza plan y webhook, no duplica).
- [ ] **Pasar a cobro real**: `PAYMENTS_MODE=live` con claves live (`sk_live_`), precio live y webhook live. Hoy todo es de pruebas.
- [ ] **Cuenta de desarrollador Apple** (99 USD/al año) y **Google Play** (25 USD unica vez).
- [ ] **Certificado de firma de codigo** para Windows (si es camino A).

## 4. Trabajo tecnico pendiente

### Comun
- [ ] Politica de privacidad publicada con URL estable.
- [ ] Pagina de soporte / email de contacto.
- [ ] Terminos de suscripcion (precio, periodicidad, cancelacion, reembolsos).
- [ ] Borrado de cuenta dentro de la app (obligatorio en Google Play y muy recomendado en App Store).
- [ ] Boton visible de "Restaurar compra" (el puente `restore()` existe; falta exponerlo en la UI).
- [ ] Persistencia real: el plan Free de Render borra el disco en cada reinicio; mover a plan de pago o Postgres.

### Camino A (PC)
- [ ] Configurar empaquetado (electron-builder o similar) y generar instalador.
- [ ] Firmar el ejecutable y el instalador.
- [ ] Iconos en todos los tamaños, capturas y descripcion para la ficha.
- [ ] Actualizaciones automaticas (opcional pero esperado).

### Camino B (movil)
- [ ] Crear proyecto Android (y iOS si aplica) con la misma UI.
- [ ] Integrar In-App Purchase / Google Play Billing y verificar recibos contra el servidor.
- [ ] Configurar la cuenta de servicio de Google para `GoogleProvider` (`GOOGLE_SERVICE_ACCOUNT_FILE`, `GOOGLE_PACKAGE_NAME`).
- [ ] Probar compra sandbox en ambas tiendas.

## 5. Metadatos de tienda (se pueden preparar ya)

- [ ] Nombre y subtitulo.
- [ ] Descripcion corta y larga.
- [ ] Capturas por tamano de pantalla.
- [ ] Icono de app y grafico de cabecera.
- [ ] Clasificacion por edad.
- [ ] Formulario de seguridad de datos (Play) y etiquetas de privacidad (App Store).
- [ ] Declaracion de exportacion de cifrado (App Store: usa HTTPS).
- [ ] Notas para el revisor con cuenta de prueba.

## 6. Orden recomendado

1. Decidir camino A o B.
2. Cerrar PayPal si vas a aportar credenciales.
3. Pasar a claves live y repetir una compra real de 2 USD.
4. Completar lo comun (privacidad, soporte, borrado de cuenta, restaurar compra).
5. Si camino A: empaquetado y firma. Si camino B: proyecto movil + IAP.
6. Preparar metadatos y enviar a revision.
