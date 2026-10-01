import { spawn } from 'node:child_process';
import path from 'node:path';
import { frontendRoot, prepareDesktopToolchain } from './desktop-toolchain.mjs';

const { env } = prepareDesktopToolchain();
env.CARGO_TARGET_DIR = path.join(frontendRoot, 'src-tauri', 'target-dev');
const child = spawn(process.execPath, [path.join(frontendRoot, 'node_modules/@tauri-apps/cli/tauri.js'), 'dev', '--config', 'src-tauri/tauri.dev.conf.json', ...process.argv.slice(2)], {
  cwd: frontendRoot, env, stdio: 'inherit',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
