import { spawn } from 'node:child_process';
import path from 'node:path';
import { frontendRoot as root, prepareDesktopToolchain } from './desktop-toolchain.mjs';
const mode = process.argv[2];
if (!['dev', 'release'].includes(mode)) throw new Error('Expected dev or release build channel');
const args = ['build'];
if (mode === 'dev') args.push('--config', 'src-tauri/tauri.dev.conf.json');
const { env } = prepareDesktopToolchain();
// Prevent the development build from replacing release executables or installers.
env.CARGO_TARGET_DIR = path.join(root, 'src-tauri', mode === 'dev' ? 'target-dev' : 'target');
const child = spawn(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...args], { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
