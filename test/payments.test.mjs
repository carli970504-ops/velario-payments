import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { createApp } from '../src/app.mjs';
import { readConfig, PRODUCT_ID } from '../src/config.mjs';
import { createProviders, PaymentError, verifyStripeSignature, stripeEntitlement, paypalEntitlement, googleEntitlement } from '../src/providers.mjs';

const expiry=()=>new Date(Date.now()+86400000).toISOString();
function mockProviders() {
  let checked=0;
  const provider={ configured:true, creates:0,
    async create(account) { this.creates++; return { reference:'cs_test_'+this.creates, kind:'checkout',url:'https://checkout.stripe.com/test/'+this.creates }; },
    async inspect() { checked++; return {active:false,expiresAt:null,status:'pending'}; },
    async verifyWebhook() { throw new PaymentError('Firma inválida',400); },
    async manage() {return {url:'https://billing.stripe.com/test'};}
  };
  return {stripe:{...provider},paypal:{...provider},play:{...provider},get checked(){return checked;}};
}
async function fixture(t, providers=mockProviders()) {
  const store=new Store(':memory:'), config=readConfig({});
  const app=createApp({config,store,providers,log:{error(){}}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));store.close();});
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(route,token,body,extra={})=>{
    const response=await fetch(url+route,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`} :{}),'Content-Type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  return {...app,store,providers,request};
}

test('unconfigured server exposes no usable payment method and never grants Pro',async t=>{
  const config=readConfig({}), f=await fixture(t,createProviders(config));
  const session=(await f.request('/api/session',null,{})).body;
  const cfg=(await f.request('/api/config')).body;
  assert.deepEqual(cfg.methods,{card:false,applepay:false,googlepay:false,link:false,paypal:false,play:false});
  assert.equal((await f.request('/api/entitlement',session.token)).body.active,false);
  assert.equal((await f.request('/api/checkout',session.token,{method:'card'})).status,503);
  assert.equal((await f.request('/api/play/verify',session.token,{purchaseToken:'fake-local-pro'})).status,503);
  assert.equal((await f.request('/api/play/ready',session.token)).status,503);
  assert.equal(f.store.rows(session.accountId).length,0);
});

test('local Pro flags, missing token, forged receipt and hostile browser origin do not grant access',async t=>{
  const f=await fixture(t), session=(await f.request('/api/session',null,{})).body;
  assert.equal((await f.request('/api/entitlement')).status,401);
  assert.equal((await f.request('/api/checkout',session.token,{method:'pro',active:true,pro:true})).status,400);
  assert.equal((await f.request('/api/entitlement',session.token,undefined,{Origin:'https://evil.example'})).status,403);
  assert.equal((await f.request('/api/entitlement',session.token)).body.active,false);
});

test('creating a checkout does not unlock and duplicate clicks reuse pending checkout',async t=>{
  const f=await fixture(t), session=(await f.request('/api/session',null,{})).body;
  const first=await f.request('/api/checkout',session.token,{method:'card'});
  const second=await f.request('/api/checkout',session.token,{method:'card'});
  assert.equal(first.status,200); assert.equal(second.body.url,first.body.url);
  assert.equal(f.providers.stripe.creates,1);
  assert.equal((await f.request('/api/entitlement',session.token)).body.active,false);
});

test('current provider verification drives activation, expiry, cancellation, and failure closure',async t=>{
  const f=await fixture(t), session=(await f.request('/api/session',null,{})).body;
  f.store.bind('stripe','sub_test',session.accountId,'subscription');
  f.providers.stripe.inspect=async()=>({active:true,expiresAt:expiry(),status:'active'});
  let value=await f.request('/api/entitlement',session.token);
  assert.equal(value.body.active,true); assert.equal(value.body.productId,PRODUCT_ID);
  assert.equal((await f.request('/api/checkout',session.token,{method:'paypal'})).status,409);
  f.providers.stripe.inspect=async()=>({active:true,expiresAt:'2020-01-01T00:00:00Z',status:'active'});
  assert.equal((await f.request('/api/entitlement',session.token)).body.active,false);
  f.providers.stripe.inspect=async()=>({active:false,expiresAt:null,status:'canceled'});
  assert.equal((await f.request('/api/entitlement',session.token)).body.active,false);
  f.providers.stripe.inspect=async()=>{throw new Error('network');};
  assert.equal((await f.request('/api/entitlement',session.token)).body.status,'verification_unavailable');
});

test('forged webhook rejected, verified webhook is idempotent and refund invalidates duplicate purchase views',async t=>{
  const f=await fixture(t), session=(await f.request('/api/session',null,{})).body;
  assert.equal((await f.request('/webhooks/stripe',null,{id:'evt_forged'})).status,400);
  f.store.bind('stripe','cs_checkout',session.accountId,'checkout');
  let checks=0;
  f.providers.stripe.inspect=async(ref,account,kind,row)=>{checks++;return {active:!row.revoked_at,expiresAt:expiry(),status:row.revoked_at?'revoked':'active'};};
  f.providers.stripe.verifyWebhook=async()=>({id:'evt_verified',updates:[{account:session.accountId,reference:'sub_paid',kind:'subscription'}]});
  const one=await f.request('/webhooks/stripe',null,{id:'opaque'}), two=await f.request('/webhooks/stripe',null,{id:'opaque'});
  assert.equal(one.body.duplicate,false); assert.equal(two.body.duplicate,true); assert.equal(checks,1);
  assert.equal((await f.request('/api/entitlement',session.token)).body.active,true);
  f.providers.stripe.verifyWebhook=async()=>({id:'evt_refund',updates:[{account:session.accountId,reference:'sub_paid',kind:'subscription',revokedAt:Date.now()}]});
  await f.request('/webhooks/stripe',null,{});
  assert.equal((await f.request('/api/entitlement',session.token)).body.active,false);
});

test('receipt cannot be rebound to another account and query credentials are not accepted',async t=>{
  const f=await fixture(t), a=(await f.request('/api/session',null,{})).body, b=(await f.request('/api/session',null,{})).body;
  f.providers.play.inspect=async()=>({active:true,expiresAt:expiry(),status:'active'});
  assert.equal((await f.request('/api/play/verify',a.token,{purchaseToken:'receipt'})).body.active,true);
  assert.equal((await f.request('/api/play/verify',b.token,{purchaseToken:'receipt'})).status,409);
  assert.equal((await f.request('/api/entitlement?token='+a.token)).status,401);
});

test('Stripe raw-body signature supports rotation, rejects tampering and old replay',()=>{
  const raw=Buffer.from('{"id":"evt_signed"}'), secret='whsec_test', seconds=Math.floor(Date.now()/1000);
  const signature=createHmac('sha256',secret).update(`${seconds}.`).update(raw).digest('hex');
  assert.equal(verifyStripeSignature(raw,`t=${seconds},v1=${'0'.repeat(64)},v1=${signature}`,secret),true);
  assert.equal(verifyStripeSignature(Buffer.from('{}'),`t=${seconds},v1=${signature}`,secret),false);
  assert.equal(verifyStripeSignature(raw,`t=${seconds},v1=${signature}`,secret,(seconds+301)*1000),false);
});

test('provider snapshots require owner, expected product, current payment and future expiry',()=>{
  const end=Math.floor(Date.now()/1000)+3600, account='owner';
  const stripe={metadata:{account_id:account},items:{data:[{price:'price_weekly',quantity:1,current_period_end:end}]},status:'active',latest_invoice:{status:'paid',paymentVerified:true,created:Math.floor(Date.now()/1000)}};
  assert.equal(stripeEntitlement(stripe,account,'price_weekly').active,true);
  assert.equal(stripeEntitlement(stripe,'other','price_weekly').active,false);
  assert.equal(stripeEntitlement(stripe,account,'price_wrong').active,false);
  assert.equal(stripeEntitlement({...stripe,latest_invoice:{status:'open'}},account,'price_weekly').active,false);
  const paypal={custom_id:account,plan_id:'plan',status:'ACTIVE',billing_info:{next_billing_time:expiry(),last_payment:{time:new Date().toISOString(),amount:{currency_code:'USD',value:'2.00'}}}};
  assert.equal(paypalEntitlement(paypal,account,'plan').active,true);
  assert.equal(paypalEntitlement({...paypal,status:'SUSPENDED'},account,'plan').active,false);
  assert.equal(paypalEntitlement({...paypal,status:'APPROVAL_PENDING'},account,'plan').status,'pending');
  assert.equal(paypalEntitlement({...paypal,status:'CANCELLED'},account,'plan').active,true);
  assert.equal(paypalEntitlement({...paypal,status:'CANCELLED',billing_info:{...paypal.billing_info,last_payment:{...paypal.billing_info.last_payment,time:'2020-01-01T00:00:00Z'}}},account,'plan').active,false);
  const play={externalAccountIdentifiers:{obfuscatedExternalAccountId:account},subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',lineItems:[{productId:PRODUCT_ID,offerDetails:{basePlanId:'weekly'},expiryTime:expiry()}]};
  assert.equal(googleEntitlement(play,account,'weekly',false).active,true);
  assert.equal(googleEntitlement({...play,testPurchase:{}},account,'weekly',false).active,false);
  assert.equal(googleEntitlement({...play,subscriptionState:'SUBSCRIPTION_STATE_PENDING'},account,'weekly',true).active,false);
});

test('Stripe adapter verifies invoice payment and charge, including refund without webhook delivery',async()=>{
  const config=readConfig({PUBLIC_BASE_URL:'https://payments.example.com',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_PRICE_ID:'price_weekly',STRIPE_WEBHOOK_SECRET:'whsec_fixture'});
  const stripe=createProviders(config).stripe, account='owner';
  let refunded=false;
  stripe.call=async(path)=>{
    if(path.startsWith('prices/')) return {active:true,type:'recurring',currency:'usd',unit_amount:200,recurring:{interval:'week',interval_count:1}};
    if(path.startsWith('subscriptions/')) return {livemode:false,metadata:{account_id:account},status:'active',items:{data:[{quantity:1,price:'price_weekly',current_period_end:Math.floor(Date.now()/1000)+86400}]},latest_invoice:{id:'in_paid',status:'paid',created:Math.floor(Date.now()/1000)}};
    if(path.startsWith('invoice_payments?')) return {data:[{currency:'usd',amount_paid:200,payment:{payment_intent:{status:'succeeded',latest_charge:{paid:true,refunded,amount_refunded:refunded?200:0,disputed:false}}}}]};
    throw new Error('Unexpected API route '+path);
  };
  assert.equal((await stripe.inspect('sub_paid',account,'subscription')).active,true);
  refunded=true;
  assert.equal((await stripe.inspect('sub_paid',account,'subscription')).active,false);
});

test('Google adapter checks weekly base plan and acknowledges only verified owner after provider read',async()=>{
  const config=readConfig({GOOGLE_SERVICE_ACCOUNT_FILE:import.meta.filename,GOOGLE_PACKAGE_NAME:'com.velario.app',GOOGLE_BASE_PLAN_ID:'weekly'});
  const google=createProviders(config).play, account='owner', calls=[];
  let owner=account;
  google.call=async(path,method)=>{
    calls.push([path,method]);
    if(path.startsWith('subscriptions/')) return {basePlans:[{basePlanId:'weekly',state:'ACTIVE',autoRenewingBasePlanType:{billingPeriodDuration:'P1W'},regionalConfigs:[{regionCode:'US',price:{currencyCode:'USD',units:'2',nanos:0}}]}]};
    if(path.startsWith('purchases/subscriptionsv2/')) return {externalAccountIdentifiers:{obfuscatedExternalAccountId:owner},subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',acknowledgementState:'ACKNOWLEDGEMENT_STATE_PENDING',lineItems:[{productId:PRODUCT_ID,offerDetails:{basePlanId:'weekly'},expiryTime:expiry()}]};
    if(path.endsWith(':acknowledge')) return {};
    throw new Error('Unexpected route');
  };
  assert.equal((await google.ready()).ready,true);
  assert.equal((await google.inspect('receipt',account)).active,true);
  assert.equal(calls.filter(v=>v[0].endsWith(':acknowledge')).length,1);
  owner='attacker'; calls.length=0;
  await assert.rejects(()=>google.inspect('receipt',account),/no corresponde/);
  assert.equal(calls.filter(v=>v[0].endsWith(':acknowledge')).length,0);
});

test('wrong Stripe price, PayPal interval and Google plan fail before payment initiation',async()=>{
  const config=readConfig({PUBLIC_BASE_URL:'https://payments.example.com',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_PRICE_ID:'price_weekly',STRIPE_WEBHOOK_SECRET:'whsec_fixture',PAYPAL_CLIENT_ID:'fixture',PAYPAL_CLIENT_SECRET:'fixture',PAYPAL_PLAN_ID:'plan_weekly',PAYPAL_WEBHOOK_ID:'hook',GOOGLE_SERVICE_ACCOUNT_FILE:import.meta.filename});
  const providers=createProviders(config);
  let writes=0;
  providers.stripe.call=async(path,method)=>{if(method==='POST')writes++;return {active:true,type:'recurring',currency:'usd',unit_amount:2000,recurring:{interval:'week',interval_count:1}};};
  await assert.rejects(()=>providers.stripe.create('account','card'),/2 USD/);
  providers.paypal.call=async(path,method)=>{if(method==='POST')writes++;return {status:'ACTIVE',billing_cycles:[{tenure_type:'REGULAR',frequency:{interval_unit:'MONTH',interval_count:1},total_cycles:0,pricing_scheme:{fixed_price:{currency_code:'USD',value:'2'}}}]};};
  await assert.rejects(()=>providers.paypal.create('account'),/2 USD/);
  providers.play.call=async(path,method)=>{if(method==='POST')writes++;return {basePlans:[{basePlanId:'weekly',state:'ACTIVE',autoRenewingBasePlanType:{billingPeriodDuration:'P1M'},regionalConfigs:[{regionCode:'US',price:{currencyCode:'USD',units:'2',nanos:0}}]}]};};
  await assert.rejects(()=>providers.play.ready(),/semanal/);
  assert.equal(writes,0);
});

test('gestionar un checkout abierto y sin pagar responde 404 claro, no 502 generico', async () => {
  const config = readConfig({PUBLIC_BASE_URL:'https://payments.example.com',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_PRICE_ID:'price_weekly',STRIPE_WEBHOOK_SECRET:'whsec_fixture'});
  const stripe = createProviders(config).stripe;
  stripe.call = async path => path.startsWith('prices/')
    ? {active:true,type:'recurring',currency:'usd',unit_amount:200,recurring:{interval:'week',interval_count:1}}
    : {id:'cs_open',subscription:null};
  await assert.rejects(() => stripe.manage({reference:'cs_open',kind:'checkout'}), /Completa el pago/);
});
