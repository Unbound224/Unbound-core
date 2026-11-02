import { writeFileSync } from 'node:fs';
import { openApiJson } from '../src/http/openapi.js';

writeFileSync(new URL('../openapi/openapi.json', import.meta.url), openApiJson());
