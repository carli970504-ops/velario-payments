# Desplegar en Render

Objetivo: que el servicio que ya existe en https://velario-payments.onrender.com ejecute el codigo
corregido (`src/providers.mjs`: Checkout API 2026-10-28 y Managed Payments).

Hoy produccion responde `/health` y `/return/success`, pero `POST /api/checkout` da 502 porque conserva
el codigo antiguo.

## 1. Variables de entorno (Render -> Environment)

| Variable | Valor |
|---|---|
| PAYMENTS_MODE | test |
| PUBLIC_BASE_URL | https://velario-payments.onrender.com |
| STRIPE_SECRET_KEY | la sk_test_ del .env local (marcar como secreta) |
| STRIPE_PRICE_ID | price_1UaYRCCTK8WWngJ0Crihf678 |
| STRIPE_WEBHOOK_SECRET | whsec_ real del endpoint "sophisticated-euphoria" |
| HOST | 0.0.0.0 |
| DATABASE_PATH | ./data/velario.sqlite |
| DIAGNOSTICS_TOKEN | opcional, 24 caracteres o mas |

Build Command: `npm install`   Start Command: `npm start`   Health Check Path: `/health`

## 2. Publicar el codigo

### Si el servicio ya esta conectado a un repositorio
1. Sube el contenido de esta carpeta a ese repositorio (misma rama que usa el servicio).
2. Render reconstruye solo al detectar el push (Auto-Deploy).

### Si no hay repositorio todavia
1. Crea un repositorio vacio en GitHub (privado vale).
2. `git remote add origin https://github.com/USUARIO/velario-payments.git`
   `git push -u origin main`
3. Render -> New -> Web Service -> conecta el repositorio -> variables de arriba.

Si creas un servicio NUEVO, cambia `PUBLIC_BASE_URL` a su direccion y actualiza la URL del webhook en Stripe.

## 3. Verificar

```
curl https://velario-payments.onrender.com/health
curl https://velario-payments.onrender.com/api/config
VELARIO_API_URL=https://velario-payments.onrender.com node tools/check_payments.mjs
```

Debe terminar con "TODAS LAS COMPROBACIONES OK" y devolver una URL https://checkout.stripe.com/...

## 4. Aviso: disco efimero en plan Free

El sistema de archivos se borra en cada despliegue y tras 15 minutos sin trafico. `data/velario.sqlite`
desaparece y con el las cuentas y compras registradas: un usuario que pago perderia Pro hasta que
vuelva a registrarse. Solucion: disco persistente (plan pago) o mover el almacen a una base gestionada.
