# Velario en móvil: qué falta de verdad

Velario de escritorio es **Electron**: un Chromium empaquetado con Node. Eso no se puede
publicar en App Store ni en Google Play. No es un trámite de empaquetado: hay que rehacer
la capa de aplicación y la de cobro.

## Lo que sí se reutiliza

- La lógica educativa y de mercado del renderer (`index.html` + la mesa) es JavaScript
  estándar: se puede mover a módulos y montar en una WebView nativa.
- El servidor (`src/`) ya valida suscripciones, saldo, recompensa diaria e idempotencia.
  Sirve igual para móvil; solo cambia el proveedor de cobro.
- La identidad de cuenta es un token firmado, sin contraseñas: encaja bien en móvil.

## Lo que hay que cambiar

1. **Contenedor**. Opciones reales:
   - *Capacitor + WebView*: reutiliza casi toda la interfaz. Riesgo alto de rechazo en
     Apple por la regla 4.2 (mínima funcionalidad) si se nota que es una web envuelta.
   - *React Native / Flutter*: reescritura de pantallas; más trabajo, mucha mejor
     aceptación y rendimiento.
   Recomendación: Capacitor solo para validar con usuarios en Android; React Native para
   publicar en las dos tiendas.
2. **Puente nativo**. Hoy el renderer habla con `window.velarioNative` (IPC de Electron)
   para precios, compras y saldo. En móvil hace falta el mismo contrato implementado con
   HTTP directo o un plugin nativo. Es la pieza que menos cambia de forma.
3. **Datos de mercado**. En escritorio el proceso principal consulta Yahoo porque la CSP
   del renderer bloquea la red (`connect-src 'none'`). En móvil hay que exponer un
   `/api/market` en el servidor (con caché y límite por cuenta); no conviene abrir la CSP
   del cliente a internet.
4. **Cobro dentro de la app**. Apple (3.1.1) y Google exigen su propio sistema de compra
   para suscripciones digitales:
   - Google Play Billing: el proveedor `play` ya existe en `src/providers.mjs`
     (verifica recibo, plan semanal 2 USD y acknowledge), pero **nunca se ha probado**
     contra Play Console.
   - Apple StoreKit 2: **no implementado**. Hay que añadir proveedor, verificación de
     recibos y gestión de renovaciones/revocaciones.
   - Stripe y PayPal **no se pueden usar** para desbloquear Pro dentro de la app en iOS.
5. **Progreso local**. `localStorage` → SQLite (o almacenamiento del framework) con
   migración y copia de seguridad.
6. **Cuentas**. Si se añaden cuentas reales (correo/Apple/Google), Apple exige borrado de
   cuenta desde la app (5.1.1(v)) y declarar datos en las fichas de privacidad.
7. **Interfaz**. Áreas seguras, gestos, teclado, tipografías del sistema, modo oscuro,
   rendimiento en equipos de gama media y funcionamiento sin conexión.
8. **Publicación**. Cuentas de desarrollador (Apple 99 USD/año; Google 25 USD único),
   identificadores de bundle, iconos y capturas por tamaño, clasificación por edad,
   formularios de privacidad/seguridad de datos, build de pruebas (TestFlight / pista
   interna), notas de revisión y una demo para el revisor.

## Riesgo de contenido

Velario enseña patrones con dinero simulado. En las tiendas hay que evitar que parezca un
producto de inversión real o de azar: sin promesas de rentabilidad, sin dinero real
retirable, con aviso visible de simulación y sin lenguaje de apuestas. La compra de saldo
debe presentarse como contenido del juego, no como saldo monetario.

## Fases sugeridas

| Fase | Entrega | Depende de |
| --- | --- | --- |
| 0 | Módulos JS + contrato de puente + `/api/market` en el servidor | servidor desplegado |
| 1 | App Android con Capacitor, sin cobro, para probar interfaz | cuentas Play |
| 2 | Google Play Billing probado en pista interna | Play Console + producto creado |
| 3 | App iOS con StoreKit 2 y revisión | cuenta Apple + Mac |
| 4 | Notificaciones, sin conexión, accesibilidad | fases 1–3 |

Nada de esto está hecho: hoy solo existe la app de escritorio y el servidor.
