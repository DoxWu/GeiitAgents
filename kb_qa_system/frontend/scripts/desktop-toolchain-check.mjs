import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareDesktopToolchain } from './desktop-toolchain.mjs';

const delimiter = path.delimiter;
const cargoName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const local = prepareDesktopToolchain({ CARGO_HOME: path.join(os.tmpdir(), 'missing-geiit-cargo'), RUSTUP_HOME: path.join(os.tmpdir(), 'missing-geiit-rustup'), PATH: 'system-path' });
assert.equal(local.cargoExecutable.includes('.tools'), true, 'invalid user homes should use the repository toolchain');
assert.equal(local.env.PATH.split(delimiter).some(part => part.includes(path.join('.tools', 'cargo', 'bin'))), true);
assert.equal(local.env.CARGO, local.cargoExecutable, 'workspace builds should invoke the installed Cargo directly');
assert.equal(local.env.RUSTC.includes(path.join('.tools', 'rustup', 'toolchains')), true);

const customRoot = mkdtempSync(path.join(os.tmpdir(), 'geiit-cargo-'));
const customBin = path.join(customRoot, 'bin');
mkdirSync(customBin, { recursive: true });
writeFileSync(path.join(customBin, cargoName), 'fixture');
const custom = prepareDesktopToolchain({ CARGO_HOME: customRoot, RUSTUP_HOME: path.join(os.tmpdir(), 'missing-geiit-rustup'), CARGO: 'cargo', PATH: 'system-path' });
assert.equal(custom.cargoExecutable, 'cargo');
assert.equal(custom.env.PATH.split(delimiter)[0], customBin);
assert.equal(existsSync(path.join(custom.env.CARGO_HOME, 'bin', cargoName)), true);
const explicit = prepareDesktopToolchain({ CARGO: path.join(customBin, cargoName), PATH: 'system-path' });
assert.equal(explicit.cargoExecutable, path.join(customBin, cargoName), 'an explicit Cargo executable remains authoritative');
const overridden = prepareDesktopToolchain({ RUSTUP_TOOLCHAIN: 'custom-toolchain', PATH: 'system-path' });
assert.equal(overridden.cargoExecutable.includes(path.join('cargo', 'bin')), true, 'explicit toolchain selection must use the Rustup shim');
assert.equal(overridden.env.RUSTC, undefined);
console.log('desktop toolchain fallback checks passed');
