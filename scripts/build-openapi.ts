import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApi } from '../src/openapi/document';

writeFileSync(resolve(__dirname, '../openapi.json'), `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
console.log('wrote openapi.json');
