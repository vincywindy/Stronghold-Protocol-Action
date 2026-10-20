import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Only upstream's declarative importer/packer runs here, never a downloaded install script.
const [app, adapter, source, output] = process.argv.slice(2);
if (adapter === 'forge') {
  const { importForge } = await import(pathToFileURL(path.join(app, 'server/plugins/forgeImport.js')));
  const result = await importForge(source, {
    root: app, dataDir: path.join(app, 'data'), pluginsDir: output,
    officialTables: { offline: true },
  });
  process.stdout.write(JSON.stringify(result.report));
} else {
  const { packPlugin } = await import(pathToFileURL(path.join(app, 'server/plugins/pack.js')));
  const result = packPlugin(source, { dataDir: path.join(app, 'data'), where: path.basename(source) });
  process.stdout.write(JSON.stringify({ wrote: result.wrote,
    problems: [...(result.build?.problems || []), ...(result.check?.problems || [])],
    warnings: [...(result.build?.warnings || []), ...(result.check?.warnings || [])] }));
}
