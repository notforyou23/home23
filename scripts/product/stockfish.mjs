/** Pinned native engine shipped beside product Node, independent of developer PATH. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const stockfishMacARM = Object.freeze({
  version: '17.1',
  url: 'https://github.com/official-stockfish/Stockfish/releases/download/sf_17.1/stockfish-macos-m1-apple-silicon.tar',
  sha256: '4e23165eb8f353c221ff7ab6716f0a160c3993dadf90d0c0ad982a7ade4091c9',
  binary: 'stockfish-macos-m1-apple-silicon',
  binarySHA256: '9345c44970093cabed9757be86a9ca86809a5b6ca1bdc654cf51a5eed7568858',
  sourceCommit: '03e27488f3d21d8ff4dbf3065603afa21dbd0ef3',
});
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function bundleStockfish({ outputPath, cachePath, platform, arch }) {
  // Other platform releases retain their existing operator-supplied UCI engine.
  if (platform !== 'darwin' || arch !== 'arm64') return false;
  const spec = stockfishMacARM;
  const cache = path.join(cachePath, 'stockfish');
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, `${spec.sha256}.tar`);
  if (!fs.existsSync(archive)) {
    const partial = archive + `.partial-${process.pid}`;
    try {
      execFileSync('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
        '--retry', '2', '--max-time', '180', '--output', partial, spec.url], { stdio: 'inherit', timeout: 200_000 });
      if (sha256(partial) !== spec.sha256) throw new Error('Stockfish archive checksum mismatch');
      fs.renameSync(partial, archive);
    } finally { fs.rmSync(partial, { force: true }); }
  }
  if (sha256(archive) !== spec.sha256) throw new Error('Cached Stockfish archive checksum mismatch');
  const stage = fs.mkdtempSync(path.join(cache, 'extract-'));
  try {
    execFileSync('/usr/bin/tar', ['-xf', archive, '-C', stage]);
    const upstream = path.join(stage, 'stockfish');
    const binary = path.join(upstream, spec.binary);
    if (sha256(binary) !== spec.binarySHA256) throw new Error('Stockfish binary checksum mismatch');
    const destination = path.join(outputPath, 'bin', 'stockfish');
    fs.copyFileSync(binary, destination); fs.chmodSync(destination, 0o755);
    // The official distribution includes corresponding source and build scripts.
    // Keep them and the GPL together, without a second unsigned executable.
    const notices = path.join(outputPath, 'notices', 'Stockfish');
    fs.cpSync(upstream, notices, { recursive: true, filter: file => file !== binary });
    fs.writeFileSync(path.join(notices, 'HOME23-DISTRIBUTION.json'), JSON.stringify({
      ...spec, modifications: 'None. The executable is signed by the Home23 publisher.',
      license: 'GPL-3.0; see Copying.txt. Corresponding source and build scripts are in this directory.',
    }, null, 2) + '\n');
    const probe = execFileSync(destination, [], { input: 'uci\nisready\nquit\n', encoding: 'utf8', timeout: 15_000 });
    if (!probe.includes('uciok') || !probe.includes('readyok')) throw new Error('Packaged Stockfish did not answer UCI');
    return true;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
