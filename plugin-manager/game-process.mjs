import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [app, plugins] = process.argv.slice(2);
process.chdir(app);
const { startServer } = await import(pathToFileURL(path.join(app, 'server/index.js')));
const { runMain } = await import(pathToFileURL(path.join(app, 'server/http/boot.js')));
// Use upstream's supported directory option and boot/shutdown lifecycle, without patching its files.
await runMain(options => startServer({ ...options, pluginsDir: plugins }));
