import { copyFile, mkdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const viewerFiles = ['index.html', 'viewer.js', 'viewer.css'];
const contains = (parent, child) => { const value = relative(parent, child); return !value || (!value.startsWith('..') && !isAbsolute(value)); };
async function canonical(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonical(dirname(path)), path.slice(dirname(path).length + 1));
  }
}
export async function assembleShareViewer({ source = 'apps/share-viewer/dist', destination = process.env.APICC_SHARE_VIEWER_DIR ?? './share-viewer', consoleDirectory = process.env.APICC_SERVER_CONSOLEDIR ?? './console' } = {}) {
  const output = await canonical(resolve(destination)), consoleRoot = await canonical(resolve(consoleDirectory));
  if (contains(consoleRoot, output) || contains(output, consoleRoot)) throw Error('SHARE_VIEWER_CONSOLE_OVERLAP');
  const input = await canonical(resolve(source));
  for (const file of viewerFiles) {
    try { if (!(await stat(join(input, file))).isFile()) throw Error(); }
    catch { throw Error(`SHARE_VIEWER_BUILD_REQUIRED: ${file}`); }
  }
  await mkdir(output, { recursive: true });
  for (const file of viewerFiles) if (input !== output) await copyFile(join(input, file), join(output, file));
  return viewerFiles.map(file => join(output, file));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1) throw Error('Usage: node scripts/assemble-share-viewer.mjs [independent-output-directory]');
    console.log(`Share viewer installed: ${(await assembleShareViewer({ destination: args[0] })).join(', ')}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
