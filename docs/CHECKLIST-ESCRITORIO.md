# Checklist de publicación · Velario escritorio (Windows)

Estado a 15/11/2026, versión **1.2.0** (commit `e6ce82e`). `[x]` verificado con prueba,
`[ ]` pendiente, `[!]` bloqueado por algo externo.

## 1. Aplicación

- [x] Arranque limpio verificado: ventana, interfaz renderizada, consola sin errores
      (`node tools/qa/startup.mjs` → 15/15).
- [x] Instancia única: una segunda apertura enfoca la ventana existente.
- [x] Recuperación tras 0x80000003: reinicio automático sin GPU y, si repite, pantalla de
      diagnóstico con Reintentar (`desktop/error.html`).
- [x] Registro propio en `%APPDATA%\velario\velario.log`.
- [x] Sin secretos en el paquete: el asar solo contiene `desktop/` + `package.json`.
- [x] Versión en un único sitio: `work-app/package.json` (`version`).
- [x] Icono generado: `work-app/build/icon.ico` + `icon.png` (`node tools/make-icon.mjs`).
- [ ] Icono visible en la barra de tareas y en el instalador: requiere compilar.
- [ ] Actualización automática (auto-updater): **no implementada**. Sin ella, cada
      corrección exige reinstalar a mano.
- [ ] Reporte de fallos remoto: hoy solo hay registro local; no se envía nada.

## 2. Instalador y firma

- [x] Configuración NSIS con desinstalador: `work-app/electron-builder.yml`
      (`oneClick:false`, elegir carpeta, accesos directos, `deleteAppDataOnUninstall:false`
      para no borrar progreso ni cuenta de compras).
- [x] Compilado: `work-app/dist/Velario-1.2.0-setup.exe` (102 MB, NSIS x64) con
      `npm install && npm run dist`.
- [x] Icono de aplicación incluido en el ejecutable y en el instalador.
- [!] **Firma de código**: hace falta un certificado OV/EV en `.pfx`. Sin él Windows
      mostrará "editor desconocido" y SmartScreen bloqueará la primera ejecución.
      Variables: `CSC_LINK` (ruta o base64 del .pfx) y `CSC_KEY_PASSWORD`.
- [ ] Verificar firma: `signtool verify /pa /v dist\Velario-1.2.0-setup.exe`.
- [x] Instalación probada con la variante silenciosa (`dist-silencio/Velario-1.2.0-silencioso-setup.exe`):
      copia archivos, `Velario.exe` declara versión 1.2.0, crea entrada de desinstalación y
      la app arranca (`[arranque] Velario 1.2.0 · interfaz lista`).
- [!] **Desinstalación**: el desinstalador devuelve 0 pero deja archivos, accesos y
      entradas de registro, y el proceso `Un_A.exe` queda colgado. Requiere revisión
      interactiva con UAC; además quedó una entrada duplicada "Velario 1.1.0" de
      instalaciones anteriores.
- [x] Los datos del usuario (`%APPDATA%\velario`: progreso y `purchase-account.bin`)
      sobreviven a los intentos de desinstalación.
- [ ] Probar instalación, desinstalación y reinstalación en Windows 10 y 11 limpios.
- [ ] Publicar hash SHA-256 del instalador junto a la descarga.

## 3. Pagos (modo test verificado; live sin probar)

- [x] Checkout de Pro, activación al volver, restauración e idempotencia: probado contra
      servidor simulado fiel a Stripe (`tools/qa/e2e.mjs` → 17/17).
- [x] Compra de saldo ($1 → 1.000 en un modo) con acreditación única por sesión.
- [x] Comprar saldo ya **no** rompe el estado de Pro (corregido; prueba 27/27).
- [x] Webhooks: el mismo evento no se procesa dos veces.
- [x] PayPal: sin credenciales → no se anuncia y el servidor responde 503.
- [x] **Despliegue**: subido a `origin/main` y desplegado por Render en 33 s.
      `/api/credits/checkout` y `/api/rewards/daily` ya existen; la recompensa diaria
      acredita una vez y rechaza la segunda el mismo día.
- [x] Checkout real de Stripe en modo prueba desde producción (URL `cs_test_`).
- [x] Suscripción de prueba cobrada con tarjeta 4242: Pro se activa en producción,
      restaurar mantiene el acceso, con Pro activo se rechaza otro cobro (409) y al
      cancelar deja de haber Pro.
- [!] Acreditar saldo tras un pago real: el checkout alojado no se puede completar desde
      un navegador automatizado (hCaptcha invisible). Requiere un pago manual con 4242.
- [ ] Pasar a live: `PAYMENTS_MODE=live`, `STRIPE_SECRET_KEY=sk_live_…`,
      `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` (2 USD/semana) y `PUBLIC_BASE_URL` HTTPS.
- [ ] Registrar el webhook en Stripe (`/webhooks/stripe`) y probar un cobro real de 2 USD
      con tarjeta propia, reembolso y cancelación desde el portal.
- [ ] Probar el flujo de saldo con tarjeta real y verificar el abono en la app.
- [ ] Revisar política de reembolsos y disputas antes de abrir ventas.

## 4. Legal y soporte

- [ ] Publicar privacidad y términos en una URL estable y enlazarlos en la app y en la
      ficha de descarga.
- [ ] Canal de soporte real (correo o formulario) y tiempo de respuesta.
- [ ] Texto claro de que el dinero del juego es **simulado** y no se puede retirar.
- [ ] Revisar quién es el comerciante (Stripe como Merchant of Record o Velario).

## 5. Publicación

- [ ] Página de descarga con requisitos (Windows 10/11 x64), versión y hash.
- [ ] Notas de versión.
- [ ] Copia de seguridad del asar anterior antes de cada actualización
      (ya se guarda `resources/app.asar.backup-…`).
- [ ] Plan de reversión: restaurar el asar anterior es suficiente; los datos del usuario
      viven en `%APPDATA%\velario`, no en el paquete.

## Orden recomendado

1. Push de `main-deploy` y despliegue en Render.
2. Certificado de firma → compilar instalador → probar en máquina limpia.
3. Pagos live con tarjeta propia y webhook.
4. Legal, soporte y página de descarga.
