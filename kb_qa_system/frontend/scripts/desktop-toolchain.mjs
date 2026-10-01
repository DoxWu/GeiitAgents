import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
const toolsRoot = path.resolve(frontendRoot, '../..', '.tools');
const localCargoHome = path.join(toolsRoot, 'cargo');
const localRustupHome = path.join(toolsRoot, 'rustup');
const localCargoBin = path.join(localCargoHome, 'bin');
const localCargoExecutable = path.join(localCargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo');

export function prepareDesktopToolchain(baseEnv = process.env) {
  const env = { ...baseEnv };
  const hasLocalCargo = existsSync(localCargoExecutable);

  if (!env.CARGO_HOME && hasLocalCargo) env.CARGO_HOME = localCargoHome;
  if (!env.RUSTUP_HOME && existsSync(path.join(localRustupHome, 'toolchains'))) env.RUSTUP_HOME = localRustupHome;

  if (env.CARGO_HOME === localCargoHome && existsSync(localCargoBin)) {
    env.PATH = `${localCargoBin}${path.delimiter}${env.PATH ?? ''}`;
  }

  return {
    env,
    cargoExecutable: env.CARGO
      || (env.CARGO_HOME === localCargoHome && hasLocalCargo ? localCargoExecutable : 'cargo'),
  };
}

export const { env, cargoExecutable } = prepareDesktopToolchain();
