import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import * as fs from "fs";
import * as readline from "readline";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ChainSpec {
  name: string;
  id: string;
  chainType: string;
  bootNodes: string[];
  telemetryEndpoints: null;
  protocolId: string;
  properties: null;
  forkBlocks: null;
  badBlocks: null;
  consensusEngine: null;
  lightSyncState: null;
  genesis: {
    runtime: any; // this can change depending on the versions
    raw: {
      top: {
        [key: string]: string;
      };
    };
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

function nameCase(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

// Get authority keys from within chainSpec data
function getAuthorityKeys(chainSpec: ChainSpec) {
  // this is the most recent spec struct
  if (
    chainSpec.genesis.runtime.runtime_genesis_config &&
    chainSpec.genesis.runtime.runtime_genesis_config.palletSession
  ) {
    return chainSpec.genesis.runtime.runtime_genesis_config.palletSession.keys;
  }
  // Backward compatibility
  return chainSpec.genesis.runtime.palletSession.keys;
}

// Get balances spec from chainSpec data
function getAccountBalances(chainSpec: ChainSpec) {
  if (
    chainSpec.genesis.runtime.runtime_genesis_config &&
    chainSpec.genesis.runtime.runtime_genesis_config.palletBalances
  ) {
    return chainSpec.genesis.runtime.runtime_genesis_config.palletBalances
      .balances;
  }

  return chainSpec.genesis.runtime.palletBalances.keys;
}

// Remove all existing keys from `session.keys`
export function clearAuthorities(spec: string): void {
  const rawdata = fs.readFileSync(spec, "utf8");
  const chainSpec = JSON.parse(rawdata);

  const keys = getAuthorityKeys(chainSpec);
  keys.length = 0;

  const data = JSON.stringify(chainSpec, null, 2);
  fs.writeFileSync(spec, data);
  console.log(`Removed all authorities from ${spec} file`);
}

// Add additional authorities to chain spec in `session.keys`
export async function addAuthorities(
  spec: string,
  names: string[]
): Promise<void> {
  await cryptoWaitReady();

  const sr_keyring = new Keyring({ type: "sr25519" });
  const ed_keyring = new Keyring({ type: "ed25519" });

  const rawdata = fs.readFileSync(spec, "utf8");
  const chainSpec = JSON.parse(rawdata);

  const keys = getAuthorityKeys(chainSpec);
  const balances = getAccountBalances(chainSpec);

  for (const name of names) {
    const sr_account = sr_keyring.createFromUri(`//${nameCase(name)}`);
    const sr_stash = sr_keyring.createFromUri(`//${nameCase(name)}//stash`);
    const ed_account = ed_keyring.createFromUri(`//${nameCase(name)}`);

    const key = [
      sr_stash.address,
      sr_stash.address,
      {
        grandpa: ed_account.address,
        babe: sr_account.address,
        im_online: sr_account.address,
        authority_discovery: sr_account.address,
        para_validator: sr_account.address,
        para_assignment: sr_account.address,
      },
    ];

    if (
      keys.findIndex((element): boolean => {
        return element[0] == sr_stash.address;
      }) == -1
    ) {
      keys.push(key);
      if (
        balances.findIndex((element): boolean => {
          return element[0] == sr_stash.address;
        }) == -1
      ) {
        balances.push([sr_stash.address, 1000000000000000000]);
      }
    } else {
      console.error(
        `Authority ${name} already exists in the chainspec ${spec}`
      );
      return;
    }
  }

  const data = JSON.stringify(chainSpec, null, 2);
  fs.writeFileSync(spec, data);
}

// Add additional authorities to chain spec from file with seeds
export async function addAuthoritiesFromFile(
  spec: string,
  seeds_file: string
): Promise<void> {
  const seedStream = fs.createReadStream(seeds_file);

  const rl = readline.createInterface({
    input: seedStream,
    crlfDelay: Infinity,
  });

  const seeds: string[] = [];
  for await (const seed of rl) {
    seeds.push(seed);
  }

  clearAuthorities(spec);

  await addAuthorities(spec, seeds);
}
