import fs from 'node:fs';
import { catalogPath, readCatalog } from '../scripts/plugin-catalog.mjs';

// Build-time selection grants access to repositories, never installs their plugins.
const catalog = readCatalog();
const sources = [...new Set((process.argv[2] || '').split(',').filter(Boolean))];
for (const source of sources) if (!Object.hasOwn(catalog.sources, source)) throw new Error(`Unknown source: ${source}`);
catalog.sources = Object.fromEntries(sources.map(key => [key, catalog.sources[key]]));
catalog.plugins = catalog.plugins.filter(plugin => sources.includes(plugin.source));
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
