import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const filePath = resolve(process.cwd(), 'packages/provider/.provider-metadata.json');
const contents = readFileSync(filePath, 'utf8');
console.log(contents);
