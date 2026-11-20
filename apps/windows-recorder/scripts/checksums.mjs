import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function packageFiles(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error('PACKAGE_SYMLINK_REJECTED');
    if (entry.isDirectory()) result.push(...await packageFiles(root, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error('PACKAGE_FILE_TYPE_REJECTED');
  }
  return result.sort();
}
export async function writeChecksums(root) {
  const rows = [];
  for (const file of await packageFiles(root)) {
    if (file === 'CHECKSUMS.sha256') continue;
    rows.push(createHash('sha256').update(await readFile(join(root, file))).digest('hex') + '  ' + file);
  }
  await writeFile(join(root, 'CHECKSUMS.sha256'), rows.join('\n') + '\n');
}
