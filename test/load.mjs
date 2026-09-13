import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.PI_PACKAGE_ROOT;
if (!root) throw Error('Set PI_PACKAGE_ROOT to the already installed Pi package; no dependency installation is needed.');
const require = createRequire(join(root, 'package.json'));
const { createJiti } = require('jiti');
const host = createJiti(join(root, 'package.json'));
const alias = Object.fromEntries(['typebox', 'typebox/value'].map(name => [name, fileURLToPath(host.esmResolve(name))]));
export const load = createJiti(import.meta.url, { moduleCache: false, alias }).import;
