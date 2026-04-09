/**
 * home23 cosmo23 update — Copy latest COSMO 2.3 from source
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

function loadYaml(filePath) {
  if (!existsSync(filePath)) return {};
  return yaml.load(readFileSync(filePath, 'utf8')) || {};
}

export async function runCosmo23Update(home23Root) {
  const homeConfig = loadYaml(join(home23Root, 'config', 'home.yaml'));
  const sourcePath = homeConfig.cosmo23?.source;
  if (!sourcePath) {
    console.error('cosmo23.source not set in config/home.yaml. Set it to the COSMO 2.3 repo path.');
    process.exit(1);
  }
  const cosmo23Dir = join(home23Root, 'cosmo23');

  if (!existsSync(sourcePath)) {
    console.error(`Source not found: ${sourcePath}`);
    console.error('Set cosmo23.source in config/home.yaml to the COSMO 2.3 repo path.');
    process.exit(1);
  }

  console.log(`Updating COSMO 2.3 from ${sourcePath}...`);

  const pkgPath = join(cosmo23Dir, 'package.json');
  const enginePkgPath = join(cosmo23Dir, 'engine', 'package.json');
  const oldPkgHash = existsSync(pkgPath) ? hashFile(pkgPath) : '';
  const oldEnginePkgHash = existsSync(enginePkgPath) ? hashFile(enginePkgPath) : '';

  try {
    console.log('  Syncing files...');
    execSync(`rsync -av --delete \
      --exclude='node_modules' \
      --exclude='.git' \
      --exclude='runs' \
      --exclude='runtime' \
      --exclude='investigations' \
      --exclude='.cosmo23-config' \
      --exclude='prisma/dev.db' \
      --exclude='.env' \
      "${sourcePath}/" "${cosmo23Dir}/"`, { stdio: 'pipe' });

    const newPkgHash = existsSync(pkgPath) ? hashFile(pkgPath) : '';
    const newEnginePkgHash = existsSync(enginePkgPath) ? hashFile(enginePkgPath) : '';
    const needsInstall =
      oldPkgHash !== newPkgHash ||
      oldEnginePkgHash !== newEnginePkgHash ||
      !existsSync(join(cosmo23Dir, 'node_modules')) ||
      !existsSync(join(cosmo23Dir, 'engine', 'node_modules'));

    if (needsInstall) {
      console.log('  Dependency manifests changed or installs missing — reinstalling dependencies...');
      execSync('npm install', { cwd: cosmo23Dir, stdio: 'pipe' });
      if (existsSync(enginePkgPath)) {
        execSync('npm install', { cwd: join(cosmo23Dir, 'engine'), stdio: 'pipe' });
      }
      execSync('npx prisma generate', { cwd: cosmo23Dir, stdio: 'pipe' });
      console.log('  Dependencies updated');
    } else {
      console.log('  Dependencies unchanged');
    }

    console.log('  COSMO 2.3 updated successfully');
    console.log('  Restart with: home23 start');
  } catch (err) {
    console.error('  Update failed:', err.message);
    process.exit(1);
  }
}

function hashFile(filePath) {
  return createHash('md5').update(readFileSync(filePath)).digest('hex');
}
