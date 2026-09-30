import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2];
if (!['dev', 'release'].includes(mode)) throw new Error('Expected dev or release build channel');
const args = ['build'];
if (mode === 'dev') args.push('--config', 'src-tauri/tauri.dev.conf.json');
const env = { ...process.env };
// Prevent the development build from replacing release executables or installers.
env.CARGO_TARGET_DIR = path.join(root, 'src-tauri', mode === 'dev' ? 'target-dev' : 'target');
const toolsRoot = path.resolve(root, '../..', '.tools');
const localCargo = path.join(toolsRoot, 'cargo');
const localRustup = path.join(toolsRoot, 'rustup');
const localCargoBin = path.join(localCargo, 'bin');
if (!env.CARGO_HOME && existsSync(path.join(localCargoBin, 'cargo.exe'))) env.CARGO_HOME = localCargo;
if (!env.RUSTUP_HOME && existsSync(path.join(localRustup, 'toolchains'))) env.RUSTUP_HOME = localRustup;
if (env.CARGO_HOME === localCargo && existsSync(localCargoBin)) {
  env.PATH = `${localCargoBin}${path.delimiter}${env.PATH ?? ''}`;
}
const child = spawn(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...args], { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
