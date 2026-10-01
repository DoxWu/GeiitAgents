import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
const toolsRoot = path.resolve(frontendRoot, '../..', '.tools');
const localCargoHome = path.join(toolsRoot, 'cargo');
const localRustupHome = path.join(toolsRoot, 'rustup');
const localCargoBin = path.join(localCargoHome, 'bin');
const localCargoExecutable = path.join(localCargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const localRustupToolchains = path.join(localRustupHome, 'toolchains');
const cargoBinaryName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';

function configuredCargoExecutable(baseEnv) {
  if (baseEnv.CARGO && path.isAbsolute(baseEnv.CARGO)) return baseEnv.CARGO;
  if (baseEnv.CARGO_HOME) return path.join(baseEnv.CARGO_HOME, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  return undefined;
}

export function prepareDesktopToolchain(baseEnv = process.env) {
  const env = { ...baseEnv };
  const hasLocalCargo = existsSync(localCargoExecutable);
  const configuredCargo = configuredCargoExecutable(env);
  const hasConfiguredCargo = configuredCargo ? existsSync(configuredCargo) : Boolean(env.CARGO);
  const hasConfiguredRustup = Boolean(env.RUSTUP_HOME && existsSync(path.join(env.RUSTUP_HOME, 'toolchains')));

  // A stale user-level CARGO_HOME/RUSTUP_HOME can make child processes fail before
  // Cargo emits a useful diagnostic. Use the checked-in toolchain when it exists.
  if (hasLocalCargo && (!env.CARGO_HOME || !hasConfiguredCargo)) env.CARGO_HOME = localCargoHome;
  if (existsSync(localRustupToolchains) && (!env.RUSTUP_HOME || !hasConfiguredRustup)) env.RUSTUP_HOME = localRustupHome;

  const selectedCargoHome = env.CARGO_HOME;
  const selectedCargoBin = selectedCargoHome ? path.join(selectedCargoHome, 'bin') : undefined;
  // Cargo's relative shim (the usual `CARGO=cargo`) is resolved by the child
  // process. Put the selected toolchain first so a valid custom home cannot
  // silently fall through to a different system installation.
  if (selectedCargoBin && existsSync(path.join(selectedCargoBin, cargoBinaryName))) {
    env.PATH = `${selectedCargoBin}${path.delimiter}${env.PATH ?? ''}`;
  }

  return {
    env,
    cargoExecutable: env.CARGO && (path.isAbsolute(env.CARGO) ? existsSync(env.CARGO) : hasConfiguredCargo)
      ? env.CARGO
      : (env.CARGO_HOME === localCargoHome && hasLocalCargo ? localCargoExecutable : 'cargo'),
  };
}

export const { env, cargoExecutable } = prepareDesktopToolchain();
