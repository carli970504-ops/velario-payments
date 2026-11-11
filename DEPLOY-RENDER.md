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
| ACCOUNT_SECRET | opcional, 32 caracteres o mas; si falta se deriva de la clave de Stripe |

Build Command: `npm install`   Start Command: `npm start`   Health Check Path: `/health`

## 2. Publicar el codigo

### Si el servicio ya esta conectado a un repositorio
1. Sube el contenido de esta carpeta a ese repositorio (misma rama que usa el servicio).
2. Render reconstruye solo al detectar el push (Auto-Deploy).

Aviso: el Auto-Deploy solo existe si el servicio esta conectado por **Git Provider** (Settings -> Source -> pestana Git Provider, con la app de Render instalada en GitHub). Si el origen es una **URL de repositorio publico**, Render no recibe avisos de GitHub y hay que desplegar a mano con *Manual Deploy -> Deploy latest commit*.

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

## 5. Durabilidad de las sesiones

El token de cada instalacion va firmado (HMAC) con `ACCOUNT_SECRET` (o, si no existe, con una clave
derivada de `STRIPE_SECRET_KEY`), asi que no depende de ninguna fila de la base. Si Render borra el
disco, el cliente sigue autenticando con el mismo token y el servidor reconstruye su suscripcion
preguntando a Stripe por `metadata.account_id` (`StripeProvider.findByAccount`).

La base local queda como cache: acelera las consultas y guarda los checkouts pendientes, pero ya no
es la unica copia de nada importante.

Ojo: los tokens emitidos antes de este cambio son aleatorios y no se pueden reconstruir. Un cliente
antiguo tiene que abrir la app y empezar de cero.

IMPORTANTE: define `ACCOUNT_SECRET` **antes** de vender y no lo cambies despues. Al cambiarlo,
todos los tokens emitidos dejan de valer y esos clientes pierden el vinculo con su compra.
Si falta, el servidor lo deriva de `STRIPE_SECRET_KEY` (funciona, pero rotar esa clave cortaria
las sesiones de todo el mundo).

## 6. PayPal (opcional)

PayPal se activa solo cuando existen estas cuatro variables en Render -> Environment:

| Variable | De donde se saca |
| --- | --- |
| `PAYPAL_CLIENT_ID` | developer.paypal.com -> Apps & Credentials -> tu app (Live para cobrar, Sandbox para probar) |
| `PAYPAL_CLIENT_SECRET` | el "Secret" de esa misma app |
| `PAYPAL_PLAN_ID` | plan de suscripcion de 2 USD por semana -> el id `P-...` |
| `PAYPAL_WEBHOOK_ID` | webhook apuntando a https://velario-payments.onrender.com/webhooks/paypal |

Mientras falte alguna, `/api/config` devuelve `paypal:false`, el checkout responde 503
"Este metodo de pago todavia no esta configurado" y el resto de metodos (tarjeta, Apple Pay,
Google Pay, Link) funciona con normalidad. No hace falta tocar codigo ni redesplegar nada
mas que guardar las variables.
