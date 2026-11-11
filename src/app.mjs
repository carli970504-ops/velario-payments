import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { PRODUCT_ID } from './config.mjs';
import { PaymentError } from './providers.mjs';
import { diagnoseProviders } from './diagnostics.mjs';
import { createAccounts, readAccountSecret } from './account.mjs';

const json = (res, status, data) => {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data));
};
const validRef = v => typeof v === 'string' && v.length > 0 && v.length <= 8192;
const validAccount = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576) throw new PaymentError('Solicitud demasiado grande.',413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function parse(raw) {
  try { const result=JSON.parse(raw); if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error(); return result; }
  catch { throw new PaymentError('JSON inválido.',400); }
}

export function createApp({ config, store, providers, log = console, accounts = createAccounts(readAccountSecret().secret) }) {
  const rates = new Map(), locks = new Map();
  // Apple Pay, Google Pay y Link los presenta Checkout de Stripe sobre el método card:
  // se anuncian disponibles cuando Stripe está configurado y el dispositivo los admite.
  const methods = () => ({card:providers.stripe.configured,applepay:providers.stripe.configured,googlepay:providers.stripe.configured,link:providers.stripe.configured,paypal:providers.paypal.configured,play:providers.play.configured});
  function rate(key, limit) {
    const now=Date.now(), window=Math.floor(now/60_000);
    const record=rates.get(key);
    const item = record?.window===window ? record : {window,count:0};
    item.count++; rates.set(key,item);
    if (rates.size>10_000) for(const [key,value] of rates) if(value.window<window) rates.delete(key);
    if (item.count>limit) throw new PaymentError('Demasiadas solicitudes; vuelve a intentarlo en un minuto.',429);
  }
  async function locked(key, work) {
    const before=locks.get(key) || Promise.resolve();
    const next=before.catch(()=>{}).then(work); locks.set(key,next);
    try {return await next;} finally {if(locks.get(key)===next) locks.delete(key);}
  }
  // Si la base local se ha borrado (disco efimero), el vinculo se reconstruye desde el
  // proveedor con el identificador de cuenta que viaja firmado en el token.
  async function recover(account) {
    let found=0;
    const stripe=providers.stripe;
    if(stripe?.configured && typeof stripe.findByAccount==='function')
      for(const id of await stripe.findByAccount(account)) {store.bind('stripe',id,account,'subscription');found++;}
    const play=providers.play;
    if(play?.configured && typeof play.findByAccount==='function')
      for(const id of await play.findByAccount(account)) {store.bind('play',id,account,'subscription');found++;}
    return found;
  }
  async function entitlement(account) {
    const entitlements=[], errors=[];
    let rows=store.rows(account);
    if(!rows.length) {
      try {if(await recover(account)) rows=store.rows(account);} catch(error) {errors.push(error);}
    }
    for (const row of rows) {
      const provider=providers[row.provider];
      try {
        const value=await provider.inspect(row.reference,account,row.kind,row);
        store.update(row.provider,row.reference,value); entitlements.push(value);
      } catch(error) {errors.push(error);}
    }
    const active=entitlements.filter(v=>v.active && Date.parse(v.expiresAt)>Date.now()).sort((a,b)=>Date.parse(b.expiresAt)-Date.parse(a.expiresAt))[0];
    return {active:Boolean(active),productId:PRODUCT_ID,expiresAt:active?.expiresAt || null,
      status:active ? 'active' : errors.length ? 'verification_unavailable' : entitlements.some(v=>v.status==='pending') ? 'pending' : 'inactive',
      verifiedAt:new Date().toISOString(), methods:methods()};
  }
  async function webhook(providerName,raw,headers) {
    const provider=providers[providerName];
    const event=await provider.verifyWebhook(raw,headers);
    if (!validRef(event.id)) throw new PaymentError('Evento sin identificador.',400);
    return locked(`event:${providerName}:${event.id}`,async()=>{
      if(store.seen(providerName,event.id)) return {received:true,duplicate:true};
      for(const update of event.updates) {
        if(!validAccount(update.account) || !validRef(update.reference)) continue;
        store.ensure(update.account);
        await locked(update.account,async()=>{
          store.bind(providerName,update.reference,update.account,update.kind);
          // A checkout and its subscription may both be bound. Revoke both views.
          if(update.revokedAt) store.revokeAccount(providerName,update.account,update.revokedAt);
          const row=store.rows(update.account).find(v=>v.provider===providerName && v.reference===update.reference);
          const value=await provider.inspect(update.reference,update.account,update.kind,row);
          store.update(providerName,update.reference,value);
        });
      }
      store.event(providerName,event.id);
      return {received:true,duplicate:false};
    });
  }
  const server=http.createServer(async(req,res)=>{
    const requestId=randomUUID();
    try {
      const url=new URL(req.url,'http://localhost');
      // Native apps make these requests. No browser CORS or cookie session is enabled.
      if(req.headers.origin) throw new PaymentError('Usa la aplicación para esta operación.',403);
      rate(`ip:${req.socket.remoteAddress}`,120);
      if(req.method==='GET' && url.pathname==='/health') return json(res,200,{ok:true});
      if(req.method==='GET' && url.pathname==='/api/config') return json(res,200,{productId:PRODUCT_ID,currency:'USD',amount:200,interval:'week',mode:config.mode,methods:methods()});
      // Diagnóstico de proveedores: solo existe si DIAGNOSTICS_TOKEN está definido en el servidor.
      // Nunca devuelve claves; indica la variable, el permiso o el precio que falla.
      if(req.method==='GET' && url.pathname==='/api/diagnostics') {
        if(!config.diagnosticsToken) throw new PaymentError('Ruta no encontrada.',404);
        const given=Buffer.from(String(req.headers.authorization||'')), expected=Buffer.from(`Bearer ${config.diagnosticsToken}`);
        if(given.length!==expected.length || !timingSafeEqual(given,expected)) throw new PaymentError('No autorizado.',401);
        rate(`diagnostics:${req.socket.remoteAddress}`,4);
        return json(res,200,await diagnoseProviders({config,providers}));
      }
      if(req.method==='GET' && ['/return/success','/return/cancel'].includes(url.pathname)) {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'",'Cache-Control':'no-store'});
        return res.end('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Velario</title><body style="font:18px system-ui;padding:3rem;max-width:38rem;margin:auto"><h1>Vuelve a Velario</h1><p>La app verificará el estado de tu suscripción al restaurar las compras. Puedes cerrar esta ventana.</p></body></html>');
      }
      if(req.method==='POST' && /^\/webhooks\/(stripe|paypal)$/.test(url.pathname)) {
        return json(res,200,await webhook(url.pathname.split('/').pop(),await body(req),req.headers));
      }
      if(req.method==='POST' && url.pathname==='/api/session') {
        rate(`session:${req.socket.remoteAddress}`,10);
        const session=accounts.issue();
        store.ensure(session.accountId);
        return json(res,201,session);
      }
      const auth=req.headers.authorization;
      let account=null;
      if(typeof auth==='string' && /^Bearer [A-Za-z0-9_.-]{20,300}$/.test(auth)) {
        const token=auth.slice(7);
        // Token firmado (sigue valido aunque se borre el disco) o, por compatibilidad, token antiguo.
        account=accounts.verify(token);
        if(account) store.ensure(account); else account=store.authenticate(token);
      }
      if(!account) throw new PaymentError('Sesión inválida.',401);
      rate(`account:${account}`,60);
      if(req.method==='GET' && url.pathname==='/api/play/ready') {
        return json(res,200,await providers.play.ready());
      }
      if(req.method==='GET' && url.pathname==='/api/entitlement') return json(res,200,await locked(account,()=>entitlement(account)));
      if(req.method==='POST' && url.pathname==='/api/checkout') {
        const input=parse(await body(req)), providerName=input.method==='paypal'?'paypal':['card','applepay','googlepay','link'].includes(input.method)?'stripe':null;
        if(!providerName) throw new PaymentError('Método no compatible.',400);
        rate(`checkout:${account}`,8);
        return json(res,200,await locked(account,async()=>{
          const status=await entitlement(account);
          if(status.active) throw new PaymentError('Tu suscripción ya está activa. Usa gestionar suscripción.',409);
          if(status.status==='verification_unavailable') throw new PaymentError('No se puede comprobar la suscripción existente.',503);
          const pending=store.rows(account).find(v=>v.provider===providerName && v.checkout_url && v.status==='pending'
            && (!v.expires_at || Date.parse(v.expires_at)>Date.now()));
          if(pending) return {url:pending.checkout_url};
          const checkout=await providers[providerName].create(account,input.method);
          store.bind(providerName,checkout.reference,account,checkout.kind,checkout.url);
          return {url:checkout.url,message:checkout.message};
        }));
      }
      if(req.method==='POST' && url.pathname==='/api/play/verify') {
        const input=parse(await body(req));
        if(!validRef(input.purchaseToken)) throw new PaymentError('Recibo inválido.',400);
        return json(res,200,await locked(account,async()=>{
          // Verify before binding, including obfuscated account and product/base plan.
          const value=await providers.play.inspect(input.purchaseToken,account,'subscription');
          store.bind('play',input.purchaseToken,account,'subscription');
          store.update('play',input.purchaseToken,value);
          return entitlement(account);
        }));
      }
      if(req.method==='POST' && url.pathname==='/api/manage') {
        let rows=store.rows(account);
        if(!rows.length) {try {if(await recover(account)) rows=store.rows(account);} catch { /* nada recuperable */ }}
        const row=rows.filter(v=>v.active).sort((a,b)=>Date.parse(b.expires_at)-Date.parse(a.expires_at))[0] || rows[0];
        if(!row) throw new PaymentError('No hay suscripción para gestionar.',404);
        return json(res,200,await providers[row.provider].manage(row));
      }
      throw new PaymentError('Ruta no encontrada.',404);
    } catch(error) {
      const status=error instanceof PaymentError || Number.isInteger(error.status) ? error.status : 500;
      if(status>=500) log.error?.({requestId,status,providerStatus:error.providerStatus,providerDetail:error.providerDetail},'Payment request unavailable');
      json(res,status,{error:status===500?'No se pudo completar la operación.':error.message,requestId});
    }
  });
  server.requestTimeout=30_000; server.headersTimeout=10_000; server.maxRequestsPerSocket=100;
  return {server,entitlement,webhook};
}
