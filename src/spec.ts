import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import * as fs from "fs";

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
export async function addAuthority(spec: string, name: string): Promise<void> {
  await cryptoWaitReady();

  const sr_keyring = new Keyring({ type: "sr25519" });
  const sr_account = sr_keyring.createFromUri(name);
  const sr_stash = sr_keyring.createFromUri(name);

  const ed_keyring = new Keyring({ type: "ed25519" });
  const ed_account = ed_keyring.createFromUri(name);

  const key = [
    sr_stash.address,
    sr_stash.address,
    {
      grandpa: ed_account.address,
      babe: sr_account.address,
      im_online: sr_account.address,
      parachain_validator: sr_account.address,
      authority_discovery: sr_account.address,
      para_validator: sr_account.address,
      para_assignment: sr_account.address,
    },
  ];

  const rawdata = fs.readFileSync(spec, "utf8");
  const chainSpec = JSON.parse(rawdata);

  const keys = getAuthorityKeys(chainSpec);
  if (
    keys.findIndex((element): boolean => {
      return element[0] == sr_stash.address;
    }) == -1
  ) {
    keys.push(key);
  } else {
    console.error(`Authority ${name} already exists in the chainspec ${spec}`);
    return;
  }

  const data = JSON.stringify(chainSpec, null, 2);
  fs.writeFileSync(spec, data);
  console.log(`Added Authority ${name}`);
}
