import { readConfig } from './config.mjs';
import { Store } from './store.mjs';
import { createProviders } from './providers.mjs';
import { createApp } from './app.mjs';
import { createAccounts, readAccountSecret } from './account.mjs';

const config=readConfig();
const {secret,source}=readAccountSecret();
if(source==='stripe') console.warn('ACCOUNT_SECRET no definido: se deriva de STRIPE_SECRET_KEY. Define ACCOUNT_SECRET para desacoplarlo.');
if(source==='random') console.warn('ACCOUNT_SECRET no definido: las sesiones no sobreviviran a un reinicio.');
const accounts=createAccounts(secret);
const store=new Store(config.databasePath);
const {server}=createApp({config,store,providers:createProviders(config),accounts});
server.listen(config.port,config.host,()=>console.log(`Velario payments server listening on ${config.host}:${config.port}; mode=${config.mode}`));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>{store.close();process.exit(0);}));
