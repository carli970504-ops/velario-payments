import { createHash, createHmac, timingSafeEqual, createSign } from 'node:crypto';
import fs from 'node:fs';
import { PRODUCT_ID } from './config.mjs';

export class PaymentError extends Error { constructor(message, status = 502) { super(message); this.status = status; } }
const unavailable = () => { throw new PaymentError('Este método de pago todavía no está configurado.', 503); };
const future = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now();
const idOf = value => typeof value === 'string' ? value : value?.id;
const checkoutId = account => createHash('sha256').update(`velario:${account}:${Math.floor(Date.now()/1_800_000)}`).digest('hex').slice(0,36);
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  let body; try { body = await response.json(); } catch { throw new PaymentError('Respuesta inválida del proveedor.'); }
  if (!response.ok) {
    // El detalle del proveedor se registra en el servidor para diagnosticar claves o precios
    // inválidos; al cliente solo le llega el mensaje genérico.
    const detail = body?.error ? [body.error.type, body.error.code, body.error.message].filter(Boolean).join(' | ') : `HTTP ${response.status}`;
    throw Object.assign(new PaymentError('No se pudo verificar la operación con el proveedor.'), { providerStatus: response.status, providerDetail: detail });
  }
  return body;
}
export function verifyStripeSignature(raw, signature, secret, now = Date.now()) {
  if (!secret || typeof signature !== 'string') return false;
  const parts = signature.split(',').map(v => v.split('='));
  const timestamp = parts.find(([k]) => k === 't')?.[1];
  if (!/^\d+$/.test(timestamp || '') || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const digest = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest();
  return parts.filter(([k,v]) => k === 'v1' && /^[\da-f]{64}$/i.test(v || '')).some(([,v]) => timingSafeEqual(digest, Buffer.from(v, 'hex')));
}
export function stripeEntitlement(subscription, account, priceId, revokedAt = 0) {
  const items = subscription.items?.data || [];
  const item = items.find(v => idOf(v.price) === priceId);
  const expiry = Number(item?.current_period_end || subscription.current_period_end || 0);
  const expiresAt = expiry ? new Date(expiry * 1000).toISOString() : null;
  const invoice = subscription.latest_invoice;
  const paid = invoice && typeof invoice === 'object' && invoice.paymentVerified === true && (invoice.paid === true || invoice.status === 'paid')
    && Number(invoice.created || 0) * 1000 > revokedAt;
  const active = subscription.metadata?.account_id === account && items.length === 1 && item?.quantity === 1
    && subscription.status === 'active' && paid && future(expiresAt);
  return { active: Boolean(active), expiresAt, status: active ? 'active' : (revokedAt ? 'revoked' : subscription.status || 'inactive') };
}

class StripeProvider {
  constructor(config) { this.config = config; this.settings = config.stripe; }
  get configured() { return Boolean(this.settings.key && this.settings.priceId && this.settings.webhookSecret && this.config.publicBaseUrl); }
  call(path, method = 'GET', data, requestId) {
    return api(`https://api.stripe.com/v1/${path}`, { method, headers: {
      Authorization: `Bearer ${this.settings.key}`, 'Stripe-Version': '2026-10-28.endive',
      ...(requestId ? { 'Idempotency-Key':requestId } : {}),
      ...(data ? { 'Content-Type':'application/x-www-form-urlencoded' } : {})
    }, ...(data ? { body: new URLSearchParams(data) } : {}) });
  }
  async validatePrice() {
    if (!this.configured) unavailable();
    const p = await this.call(`prices/${encodeURIComponent(this.settings.priceId)}`);
    if (!p.active || p.currency !== 'usd' || p.unit_amount !== 200 || p.recurring?.interval !== 'week'
      || p.recurring?.interval_count !== 1 || p.type !== 'recurring') throw new PaymentError('El precio debe ser 2 USD cada semana.', 503);
  }
  async create(account, method) {
    await this.validatePrice();
    const result = await this.call('checkout/sessions', 'POST', {
      mode: 'subscription', 'line_items[0][price]': this.settings.priceId, 'line_items[0][quantity]':'1',
      expires_at:String((Math.floor(Date.now()/1_800_000)+2)*1800),
      // Managed Payments (Stripe como comerciante) exige tax_code en el producto y no admite
      // texto propio; se desactiva por sesion para conservar el modelo de comerciante actual.
      'managed_payments[enabled]':'false',
      // Payment methods dinamicos: Stripe ya no admite payment_method_types en Checkout.
      // Los metodos habilitados se gestionan en el Dashboard de Stripe.
      client_reference_id:account, 'metadata[account_id]':account,
      'subscription_data[metadata][account_id]':account,
      success_url:`${this.config.publicBaseUrl}/return/success`, cancel_url:`${this.config.publicBaseUrl}/return/cancel`,
    }, checkoutId(account));
    if (Boolean(result.livemode) !== (this.config.mode === 'live') || !/^cs_/.test(result.id || '')
      || new URL(result.url).hostname !== 'checkout.stripe.com') throw new PaymentError('Checkout no válido.');
    return { reference:result.id, kind:'checkout', url:result.url,
      message:method === 'applepay' ? 'Apple Pay aparece si Stripe y tu dispositivo son compatibles.' : undefined };
  }
  async inspect(reference, account, kind, row = {}) {
    await this.validatePrice();
    let sub;
    if (kind === 'checkout') {
      const session = await this.call(`checkout/sessions/${encodeURIComponent(reference)}?expand[]=subscription.latest_invoice`);
      if (session.client_reference_id !== account || session.metadata?.account_id !== account) throw new PaymentError('La compra no corresponde a esta cuenta.', 403);
      if (!session.subscription) return { active:false,
        expiresAt:session.expires_at ? new Date(session.expires_at*1000).toISOString() : null,
        status:session.status === 'expired' ? 'expired' : 'pending' };
      sub = typeof session.subscription === 'object' ? session.subscription : await this.subscription(session.subscription);
    } else sub = await this.subscription(reference);
    if (Boolean(sub.livemode) !== (this.config.mode === 'live')) throw new PaymentError('Entorno de compra incorrecto.', 403);
    if (sub.latest_invoice && typeof sub.latest_invoice === 'object') {
      sub.latest_invoice.paymentVerified = await this.paymentVerified(sub.latest_invoice.id);
    }
    return stripeEntitlement(sub, account, this.settings.priceId, row.revoked_at);
  }
  subscription(id) { return this.call(`subscriptions/${encodeURIComponent(id)}?expand[]=latest_invoice`); }
  // Reconstruye el vinculo cuenta -> suscripcion sin depender de la base local:
  // la cuenta viaja firmada en el token y la verdad esta en los metadatos de Stripe.
  async findByAccount(account, maxPages = 20) {
    if (!this.configured) unavailable();
    const found = [];
    let after = null;
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams({ limit: '100', status: 'all' });
      if (after) query.set('starting_after', after);
      const result = await this.call(`subscriptions?${query}`);
      const data = Array.isArray(result.data) ? result.data : [];
      for (const sub of data) if (sub.metadata?.account_id === account) found.push(sub.id);
      if (!result.has_more || data.length === 0) break;
      after = data[data.length - 1].id;
    }
    return found;
  }
  async paymentVerified(invoiceId) {
    if (!invoiceId) return false;
    const payments = await this.call(`invoice_payments?invoice=${encodeURIComponent(invoiceId)}&status=paid&limit=100&expand[]=data.payment.payment_intent.latest_charge`);
    return (payments.data || []).some(payment => {
      const intent = payment.payment?.payment_intent, charge = intent?.latest_charge;
      return payment.currency === 'usd' && payment.amount_paid >= 200 && intent && typeof intent === 'object'
        && intent.status === 'succeeded' && charge && typeof charge === 'object' && charge.paid === true
        && charge.refunded === false && Number(charge.amount_refunded || 0) === 0 && charge.disputed === false;
    });
  }
  async verifyWebhook(raw, headers) {
    if (!this.configured) unavailable();
    if (!verifyStripeSignature(raw, headers['stripe-signature'], this.settings.webhookSecret)) throw new PaymentError('Firma Stripe inválida.', 400);
    const event = JSON.parse(raw);
    if (Boolean(event.livemode) !== (this.config.mode === 'live')) throw new PaymentError('Entorno incorrecto.',400);
    const object = event.data?.object;
    let subId;
    if (event.type === 'checkout.session.completed') subId = idOf(object?.subscription);
    else if (event.type.startsWith('customer.subscription.')) subId = object?.id;
    else if (event.type.startsWith('invoice.')) subId = idOf(object?.subscription || object?.parent?.subscription_details?.subscription);
    else if (['charge.refunded','charge.dispute.created'].includes(event.type)) {
      const charge = event.type === 'charge.refunded' ? object : await this.call(`charges/${encodeURIComponent(idOf(object.charge))}`);
      if (charge.invoice) {
        const invoice = await this.call(`invoices/${encodeURIComponent(idOf(charge.invoice))}`);
        subId = idOf(invoice.subscription || invoice.parent?.subscription_details?.subscription);
      } else if (charge.payment_intent) {
        const query = new URLSearchParams({'payment[type]':'payment_intent','payment[payment_intent]':idOf(charge.payment_intent),'limit':'100','expand[]':'data.invoice'});
        const payments = await this.call(`invoice_payments?${query}`);
        const invoice = payments.data?.find(v => v.invoice && typeof v.invoice === 'object')?.invoice;
        subId = idOf(invoice?.subscription || invoice?.parent?.subscription_details?.subscription);
      }
    }
    if (!subId) return { id:event.id, updates:[] };
    const subscription = await this.subscription(subId);
    const account = subscription.metadata?.account_id;
    // The current invoice's charge is inspected on every refresh. Refunding an
    // older invoice must not revoke a later, independently paid renewal.
    return { id:event.id, updates:[{ account, reference:subId, kind:'subscription', revokedAt:0 }] };
  }
  async manage(row) {
    let subId = row.reference;
    if (row.kind === 'checkout') {
      const session = await this.call(`checkout/sessions/${encodeURIComponent(row.reference)}`);
      subId = idOf(session.subscription);
      // Un checkout abierto y no pagado no tiene suscripcion: no es un error del proveedor.
      if (!subId) throw new PaymentError('Todavia no hay una suscripcion que gestionar. Completa el pago primero.', 404);
    }
    const subscription = await this.subscription(subId);
    const result = await this.call('billing_portal/sessions','POST', { customer:idOf(subscription.customer), return_url:`${this.config.publicBaseUrl}/return/success` });
    if (new URL(result.url).hostname !== 'billing.stripe.com') throw new PaymentError('Portal inválido.');
    return { url:result.url };
  }
}

export function paypalEntitlement(subscription, account, plan, revokedAt = 0) {
  const payment = subscription.billing_info?.last_payment;
  const paymentTime = Date.parse(payment?.time || '');
  const paidUntil = Number.isFinite(paymentTime) ? new Date(paymentTime + 7*86400000).toISOString() : null;
  // A canceled weekly subscription keeps the already-paid week. Suspended,
  // expired or reversed payments do not acquire a new period.
  const expiresAt = subscription.status === 'CANCELLED' ? paidUntil : subscription.billing_info?.next_billing_time || null;
  const active = subscription.custom_id === account && subscription.plan_id === plan && ['ACTIVE','CANCELLED'].includes(subscription.status)
    && payment?.amount?.currency_code === 'USD' && Number(payment.amount.value) === 2
    && Number.isFinite(paymentTime) && paymentTime > revokedAt && future(expiresAt);
  const status = ['APPROVAL_PENDING','APPROVED'].includes(subscription.status) ? 'pending' : subscription.status?.toLowerCase() || 'inactive';
  return { active:Boolean(active), expiresAt, status:active ? 'active' : (revokedAt ? 'revoked' : status) };
}
class PaypalProvider {
  constructor(config) { this.config = config; this.settings = config.paypal; this.base = config.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }
  get configured() { return Boolean(this.settings.clientId && this.settings.secret && this.settings.planId && this.settings.webhookId && this.config.publicBaseUrl); }
  async token() {
    if (this.accessToken && this.accessTokenExpires > Date.now()) return this.accessToken;
    const result = await api(`${this.base}/v1/oauth2/token`, { method:'POST', headers:{
      Authorization:`Basic ${Buffer.from(`${this.settings.clientId}:${this.settings.secret}`).toString('base64')}`,
      'Content-Type':'application/x-www-form-urlencoded' }, body:'grant_type=client_credentials' });
    this.accessToken = result.access_token; this.accessTokenExpires = Date.now() + (Number(result.expires_in) - 60)*1000;
    return this.accessToken;
  }
  async call(path, method='GET', body, requestId) {
    return api(`${this.base}/${path}`, { method, headers:{ Authorization:`Bearer ${await this.token()}`, 'Content-Type':'application/json',
      ...(requestId ? { 'PayPal-Request-Id':requestId } : {}) },
      ...(body ? { body:JSON.stringify(body) } : {}) });
  }
  async validatePrice() {
    if (!this.configured) unavailable();
    const plan = await this.call(`v1/billing/plans/${encodeURIComponent(this.settings.planId)}`);
    const cycles = plan.billing_cycles || [], cycle = cycles[0];
    if (plan.status !== 'ACTIVE' || cycles.length !== 1 || cycle.tenure_type !== 'REGULAR' || cycle.frequency?.interval_unit !== 'WEEK'
      || cycle.frequency?.interval_count !== 1 || cycle.total_cycles !== 0 || cycle.pricing_scheme?.fixed_price?.currency_code !== 'USD'
      || Number(cycle.pricing_scheme?.fixed_price?.value) !== 2 || Number(plan.payment_preferences?.setup_fee?.value || 0) !== 0) {
      throw new PaymentError('El plan PayPal debe ser 2 USD cada semana sin cuota inicial ni prueba.',503);
    }
  }
  async create(account) {
    await this.validatePrice();
    const result = await this.call('v1/billing/subscriptions','POST', { plan_id:this.settings.planId, custom_id:account,
      application_context:{ brand_name:'Velario', user_action:'SUBSCRIBE_NOW',
        return_url:`${this.config.publicBaseUrl}/return/success`, cancel_url:`${this.config.publicBaseUrl}/return/cancel` } },checkoutId(account));
    const url = result.links?.find(v => v.rel === 'approve')?.href;
    const host = new URL(url).hostname;
    if (!(this.config.mode === 'live' ? host === 'www.paypal.com' : host === 'www.sandbox.paypal.com')) throw new PaymentError('Checkout PayPal inválido.');
    return { reference:result.id, kind:'subscription', url };
  }
  async inspect(reference, account, kind, row={}) {
    await this.validatePrice();
    const sub = await this.call(`v1/billing/subscriptions/${encodeURIComponent(reference)}`);
    return paypalEntitlement(sub, account, this.settings.planId, row.revoked_at);
  }
  async verifyWebhook(raw, headers) {
    if (!this.configured) unavailable();
    const event = JSON.parse(raw);
    const payload = { auth_algo:headers['paypal-auth-algo'], cert_url:headers['paypal-cert-url'], transmission_id:headers['paypal-transmission-id'],
      transmission_sig:headers['paypal-transmission-sig'], transmission_time:headers['paypal-transmission-time'], webhook_id:this.settings.webhookId, webhook_event:event };
    if (Object.values(payload).some(v => !v)) throw new PaymentError('Cabeceras PayPal incompletas.',400);
    const verified = await this.call('v1/notifications/verify-webhook-signature','POST',payload);
    if (verified.verification_status !== 'SUCCESS') throw new PaymentError('Firma PayPal inválida.',400);
    const ref = event.event_type?.startsWith('BILLING.SUBSCRIPTION.') ? event.resource?.id : event.resource?.billing_agreement_id;
    if (!ref) return { id:event.id, updates:[] };
    const sub = await this.call(`v1/billing/subscriptions/${encodeURIComponent(ref)}`);
    return { id:event.id, updates:[{ account:sub.custom_id, reference:ref, kind:'subscription',
      revokedAt:['PAYMENT.SALE.REFUNDED','PAYMENT.SALE.REVERSED'].includes(event.event_type) ? Date.parse(event.create_time) : 0 }] };
  }
  async manage() { return { url:this.config.mode === 'live' ? 'https://www.paypal.com/myaccount/autopay/' : 'https://www.sandbox.paypal.com/myaccount/autopay/' }; }
}

export function googleEntitlement(purchase, account, basePlanId, allowTest) {
  const item = purchase.lineItems?.find(v => v.productId === PRODUCT_ID && v.offerDetails?.basePlanId === basePlanId);
  const allowed = ['SUBSCRIPTION_STATE_ACTIVE','SUBSCRIPTION_STATE_IN_GRACE_PERIOD','SUBSCRIPTION_STATE_CANCELED'];
  const active = purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId === account && allowed.includes(purchase.subscriptionState)
    && future(item?.expiryTime) && (allowTest || !purchase.testPurchase);
  return { active:Boolean(active), expiresAt:item?.expiryTime || null,
    status:active ? 'active' : purchase.subscriptionState?.toLowerCase().replace('subscription_state_','') || 'inactive' };
}
class GoogleProvider {
  constructor(config) { this.config = config; this.settings = config.google; }
  get configured() { return Boolean(this.settings.file && fs.existsSync(this.settings.file) && this.settings.packageName && this.settings.basePlanId); }
  async token() {
    if (this.accessToken && this.accessTokenExpires > Date.now()) return this.accessToken;
    const service = JSON.parse(fs.readFileSync(this.settings.file,'utf8'));
    const now = Math.floor(Date.now()/1000), b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${b64({alg:'RS256',typ:'JWT'})}.${b64({iss:service.client_email,scope:'https://www.googleapis.com/auth/androidpublisher',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(service.private_key).toString('base64url');
    const result = await api('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${unsigned}.${signature}`}) });
    this.accessToken = result.access_token; this.accessTokenExpires = Date.now()+(Number(result.expires_in)-60)*1000;
    return this.accessToken;
  }
  async call(path, method='GET', body) {
    return api(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(this.settings.packageName)}/${path}`, {
      method, headers:{Authorization:`Bearer ${await this.token()}`,'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}) });
  }
  async validatePlan() {
    const product = await this.call(`subscriptions/${encodeURIComponent(PRODUCT_ID)}`);
    const plan = product.basePlans?.find(v => v.basePlanId === this.settings.basePlanId);
    const us = plan?.regionalConfigs?.find(v => v.regionCode === 'US');
    if (plan?.state !== 'ACTIVE' || plan.autoRenewingBasePlanType?.billingPeriodDuration !== 'P1W'
      || us?.price?.currencyCode !== 'USD' || Number(us.price.units) !== 2 || Number(us.price.nanos || 0) !== 0) {
      throw new PaymentError('El producto Google Play debe incluir un plan semanal de 2 USD en EE.UU.',503);
    }
  }
  async ready() {
    if (!this.configured) unavailable();
    await this.validatePlan();
    return { ready:true, productId:PRODUCT_ID, basePlanId:this.settings.basePlanId };
  }
  async inspect(reference, account) {
    if (!this.configured) unavailable();
    await this.validatePlan();
    const path = `purchases/subscriptionsv2/tokens/${encodeURIComponent(reference)}`;
    const purchase = await this.call(path);
    const entitlement = googleEntitlement(purchase, account, this.settings.basePlanId, this.config.mode === 'test');
    if (purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId !== account) throw new PaymentError('La compra no corresponde a esta cuenta.',403);
    if (entitlement.active && purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
      await this.call(`purchases/subscriptions/${encodeURIComponent(PRODUCT_ID)}/tokens/${encodeURIComponent(reference)}:acknowledge`,'POST',{});
    }
    return entitlement;
  }
  async manage() { return { url:`https://play.google.com/store/account/subscriptions?sku=${encodeURIComponent(PRODUCT_ID)}&package=${encodeURIComponent(this.settings.packageName)}` }; }
}
export function createProviders(config) {
  return { stripe:new StripeProvider(config), paypal:new PaypalProvider(config), play:new GoogleProvider(config) };
}
