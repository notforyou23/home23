/**
 * home23 evobrew update — Pull latest evobrew from GitHub
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const REPO = 'notforyou23/evobrew';
const BRANCH = 'main';

export async function runEvobrewUpdate(home23Root) {
  const evobrewDir = join(home23Root, 'evobrew');
  const tmpDir = join(home23Root, '.evobrew-update-tmp');

  console.log(`Updating evobrew from github.com/${REPO}...`);

  // Save current package.json hash for dep comparison
  const pkgPath = join(evobrewDir, 'package.json');
  const oldPkgHash = existsSync(pkgPath) ? hashFile(pkgPath) : '';

  try {
    // Clean tmp dir
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });

    // Download and extract
    console.log('  Downloading...');
    const tarballUrl = `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`;
    execSync(`curl -sL "${tarballUrl}" | tar xz -C "${tmpDir}"`, { stdio: 'pipe' });

    // Find extracted directory
    const extracted = join(tmpDir, `evobrew-${BRANCH}`);
    if (!existsSync(extracted)) {
      console.error('  Download failed — extracted directory not found');
      rmSync(tmpDir, { recursive: true });
      process.exit(1);
    }

    // Rsync new files over, preserving local state
    console.log('  Replacing files...');
    execSync(`rsync -av --delete --exclude='node_modules' --exclude='.evobrew-config.json' --exclude='.evobrew-workspaces' --exclude='conversations' --exclude='snapshots' --exclude='prisma/dev.db' --exclude='.env' "${extracted}/" "${evobrewDir}/"`, {
      stdio: 'pipe',
    });

    // Check if deps changed
    const newPkgHash = existsSync(pkgPath) ? hashFile(pkgPath) : '';
    if (oldPkgHash !== newPkgHash) {
      console.log('  package.json changed — reinstalling dependencies...');
      execSync('npm install', { cwd: evobrewDir, stdio: 'pipe' });
      console.log('  Dependencies updated');
    } else {
      console.log('  Dependencies unchanged');
    }

    // Cleanup
    rmSync(tmpDir, { recursive: true });
    console.log('  Evobrew updated successfully');
    console.log('  Restart with: home23 start');
  } catch (err) {
    console.error('  Update failed:', err.message);
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    process.exit(1);
  }
}

function hashFile(filePath) {
  return createHash('md5').update(readFileSync(filePath)).digest('hex');
}
