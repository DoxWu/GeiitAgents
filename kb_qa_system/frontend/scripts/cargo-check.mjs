import { spawn } from 'node:child_process';
import path from 'node:path';
import { cargoExecutable, env, frontendRoot } from './desktop-toolchain.mjs';

const child = spawn(cargoExecutable, ['check', '--manifest-path', path.join('src-tauri', 'Cargo.toml')], {
  cwd: frontendRoot,
  env,
  stdio: 'inherit',
});

child.on('error', error => {
  console.error(`Cargo check could not start: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', code => {
  process.exitCode = code ?? 1;
});
