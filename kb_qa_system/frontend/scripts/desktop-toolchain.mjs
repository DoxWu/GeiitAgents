import { existsSync, readFileSync } from 'node:fs';
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
  // Cargo emits a useful diagnostic. Use the workspace toolchain when it exists.
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

  let directCargo;
  // Rustup shims probe the host user's HOME, which can be inaccessible in an
  // isolated build. Use the installed workspace default directly, while keeping
  // explicit executables, toolchain overrides and custom homes authoritative.
  const hasProjectOverride = ['rust-toolchain', 'rust-toolchain.toml'].some(name =>
    existsSync(path.join(frontendRoot, name)) || existsSync(path.join(frontendRoot, 'src-tauri', name)) || existsSync(path.join(toolsRoot, '..', name)));
  if (env.CARGO_HOME === localCargoHome && env.RUSTUP_HOME === localRustupHome
      && !env.RUSTUP_TOOLCHAIN && !hasProjectOverride && !(env.CARGO && path.isAbsolute(env.CARGO) && existsSync(env.CARGO))) {
    let selectedToolchain;
    try { selectedToolchain = readFileSync(path.join(localRustupHome, 'settings.toml'), 'utf8').match(/^default_toolchain\s*=\s*"([\w.-]+)"\s*$/m)?.[1]; } catch { /* Use the shim if settings are unavailable. */ }
    if (selectedToolchain) {
      const bin = path.join(localRustupToolchains, selectedToolchain, 'bin');
      const cargo = path.join(bin, cargoBinaryName), rustc = path.join(bin, process.platform === 'win32' ? 'rustc.exe' : 'rustc');
      if (existsSync(cargo) && existsSync(rustc)) {
        directCargo = cargo;
        env.CARGO = cargo;
        env.RUSTC ??= rustc;
        const rustdoc = path.join(bin, process.platform === 'win32' ? 'rustdoc.exe' : 'rustdoc');
        if (existsSync(rustdoc)) env.RUSTDOC ??= rustdoc;
        env.PATH = `${bin}${path.delimiter}${env.PATH ?? ''}`;
      }
    }
  }

  return {
    env,
    cargoExecutable: directCargo ?? (env.CARGO && (path.isAbsolute(env.CARGO) ? existsSync(env.CARGO) : hasConfiguredCargo)
      ? env.CARGO
      : (env.CARGO_HOME === localCargoHome && hasLocalCargo ? localCargoExecutable : 'cargo')),
  };
}

export const { env, cargoExecutable } = prepareDesktopToolchain();
