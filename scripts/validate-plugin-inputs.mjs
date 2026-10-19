import { appendFileSync } from 'node:fs';
import { readCatalog, selectPlugins } from './plugin-catalog.mjs';
import { imageMetadata } from './image-metadata.mjs';

const selected = selectPlugins(process.env.SELECTED_PLUGINS, readCatalog());
const selection = selected.map(p => `${p.source}/${p.id}`).join(',');
// Validate tags before downloading game art; the real source SHA is resolved in the metadata step.
imageMetadata({ ...process.env, SELECTED_PLUGINS: selection, UPSTREAM_SHA: '0'.repeat(40) });
appendFileSync(process.env.GITHUB_OUTPUT, `selection=${selection}\n`);
