import { readConfig } from './config.mjs';
import { createProviders } from './providers.mjs';
import { diagnoseProviders, formatReport } from './diagnostics.mjs';

// Uso: node --env-file-if-exists=.env src/diagnose.mjs
// Sale con código 1 si algún proveedor configurado no está operativo.
const config = readConfig();
const report = await diagnoseProviders({ config, providers: createProviders(config) });
console.log(formatReport(report));
process.exit(report.ok ? 0 : 1);
