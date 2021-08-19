import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import fs from "fs";
import yargs from "yargs";
import type { HeadData, ParaId } from "@polkadot/types/interfaces";
import type { Option, Vec } from "@polkadot/types";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import {
  clearAuthorities,
  addAuthorities,
  addAuthoritiesFromFile,
} from "./spec";

interface RegisterParachainsConfig {
  parachains: ParachainConfig[];
}

interface ParachainConfig {
  genesis_path: string;
  wasm_path: string;
  id: string;
}

function loadTypeDef(types: string): object {
  try {
    const rawdata = fs.readFileSync(types, { encoding: "utf-8" });
    return JSON.parse(rawdata);
  } catch {
    console.error("failed to load parachain typedef file");
    process.exit(1);
  }
}

async function createApi(types_path: string, url: string) {
  const provider = new WsProvider(url);

  let types = {};
  if (types_path != "") {
    types = loadTypeDef(types_path);
  }

  const apiRequest = await Promise.race([
    ApiPromise.create({
      provider,
      types,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 3000)
    ),
  ]).catch(function (err) {
    console.log("API creation error");
    throw Error(`Timeout error: ` + err.toString());
  });
  return apiRequest as ApiPromise;
}

async function register_parachains(
  config_path: string,
  ws_url: string
): Promise<void> {
  await cryptoWaitReady();

  const config_contents = fs.readFileSync(config_path, "utf8");
  const config: RegisterParachainsConfig = JSON.parse(config_contents);

  const keyring = new Keyring({ type: "sr25519" });
  const alice = keyring.addFromUri("//Alice");
  const api = await createApi("", ws_url);
  let nonce = (await api.query.system.account(alice.address)).nonce.toNumber();

  for (const parachain of config.parachains) {
    const wasm_data = read_genesis_wasm(parachain.wasm_path);
    const genesis_state = read_genesis_state(parachain.genesis_path);

    await register_parachain(
      api,
      parachain.id,
      wasm_data,
      genesis_state,
      nonce
    );

    nonce += 1;
  }

  await api.disconnect();
}

function read_genesis_wasm(wasm_path: string): string {
  let wasm_data;

  try {
    wasm_data = fs.readFileSync(wasm_path, "utf8");
  } catch (err) {
    throw Error("Cannot read wasm data from file: " + err);
  }

  return wasm_data.trim();
}

function read_genesis_state(genesis_path: string): string {
  let genesis_state;

  try {
    genesis_state = fs.readFileSync(genesis_path, "utf8");
  } catch (err) {
    throw Error("Cannot read genesis state from file: " + err);
  }
  return genesis_state.trim();
}

async function register_parachain(
  api: ApiPromise,
  id: string,
  wasm: string,
  header: string,
  nonce: number,
  finalization = false
) {
  return new Promise<void>(async (resolvePromise, reject) => {
    await cryptoWaitReady();

    const keyring = new Keyring({ type: "sr25519" });
    const alice = keyring.addFromUri("//Alice");

    const paraGenesisArgs = {
      genesis_head: header,
      validation_code: wasm,
      parachain: true,
    };
    const genesis = api.createType("ParaGenesisArgs", paraGenesisArgs);

    console.log(
      `Submitting extrinsic to register parachain ${id}. nonce: ${nonce}`
    );

    const unsub = await api.tx.sudo
      .sudo(api.tx.parasSudoWrapper.sudoScheduleParaInitialize(id, genesis))
      .signAndSend(alice, { nonce: nonce, era: 0 }, (result) => {
        console.log(`Current status is ${result.status}`);
        if (result.status.isInBlock) {
          console.log(
            `Transaction included at blockhash ${result.status.asInBlock}`
          );
          if (finalization) {
            console.log("Waiting for finalization...");
          } else {
            unsub();
            resolvePromise();
          }
        } else if (result.status.isFinalized) {
          console.log(
            `Transaction finalized at blockHash ${result.status.asFinalized}`
          );
          unsub();
          resolvePromise();
        } else if (result.isError) {
          console.log(`Transaction error`);
          reject(`Transaction error`);
        }
      });
  });
}

async function test_registration(
  api: ApiPromise,
  para_id: number
): Promise<boolean> {
  const parachains = await api.query.paras.parachains<Vec<ParaId>>();
  if (!parachains.find((id) => id.toString() == para_id.toString())) {
    return false;
  }
  return true;
}

async function check_registration(
  ws_url: string,
  para_id: number
): Promise<void> {
  const api = await createApi("", ws_url);
  if (!(await test_registration(api, para_id))) {
    const err_str = `Parachain with id ${para_id} is not registered}`;
    throw Error(err_str);
  }
  console.log("Parachain is registered");
  await api.disconnect();
}

async function retrieveLastBlock(
  ws_url: string,
  filename: string
): Promise<void> {
  const api = await createApi("", ws_url);

  var signedBlock = await api.rpc.chain.getBlock();
  console.log(`Latest block is ${signedBlock.toString()}`);
  const data = signedBlock.block.header.number.toString();
  fs.writeFileSync(filename, data);

  await api.disconnect();
}

async function test_parachain(
  parachain_types: string,
  ws_url: string,
  para_id: number,
  height_limit: number
): Promise<void> {
  const api = await createApi(parachain_types, ws_url);

  let break_condition = false;
  let attempt = 0;
  while (!break_condition) {
    //check registration every 2 seconds
    await new Promise((r) => setTimeout(r, 2000));

    if (!(await test_registration(api, para_id))) {
      if (attempt == 100) {
        // time limit reached
        break_condition = true;
        const err_str = `Timeout for parachain registration reached, ${para_id} is not registered}`;
        throw Error(err_str);
      } else {
        attempt++;
      }
    } else {
      break_condition = true;
    }
  }
  console.log("Parachain registered, wait a bit and check its height");
  await new Promise((r) => setTimeout(r, 60000));

  const optHeadData = await api.query.paras.heads<Option<HeadData>>(para_id);

  if (optHeadData.isSome) {
    const header = api.createType("Header", optHeadData.unwrap().toHex());
    console.log(`HeadData for chain ${para_id}`);
    const header_str = JSON.stringify(header.toHuman(), null, 2);
    console.log(header_str);

    const header_obj = JSON.parse(header_str);
    const blockNumber = parseInt(header_obj["number"].replace(",", ""));
    console.log(`Current blockNumber is ${blockNumber}`);

    if (blockNumber < height_limit) {
      const err_str = `Block height ${height_limit} is not reached for chain: ${para_id}, current block ${blockNumber}`;
      throw Error(err_str);
    }
  } else {
    throw Error(`Cannot retrieve HeadData for chain: ` + para_id.toString());
  }
  await api.disconnect();
}
function run() {
  const parser = yargs(process.argv.slice(2))
    .command({
      command: "register_parachains <config_path> [ws_url]",
      describe: "Register parachains with a given config",
      builder: (yargs) =>
        yargs
          .positional("config_path", {
            type: "string",
            describe: "path to config which parachains to launch",
          })
          .positional("ws_url", {
            type: "string",
            describe: "path to websocket api point",
            default: "ws://localhost:8080",
          }),
      handler: async (
        args: yargs.Arguments<{
          config_path: string;
          ws_url: string;
        }>
      ): Promise<void> => register_parachains(args.config_path, args.ws_url),
    })
    .command({
      command:
        "register_parachain <wasm_path> <header_data> <para_id> [is_parachain] [ws_url]",
      describe:
        "Register a parachain with given paths to wasm code and head data",
      builder: (yargs) =>
        yargs
          .positional("wasm_path", {
            type: "string",
            describe: "path to wasm code of the parachain",
          })
          .positional("header_data", {
            type: "string",
            describe: "path to genesis head of parachain",
          })
          .positional("para_id", {
            type: "number",
            describe: "Id of the para to register with",
          })
          .positional("is_parachain", {
            type: "boolean",
            describe: "if this is a parachain",
            default: true,
          })
          .positional("ws_url", {
            type: "string",
            describe: "path to websocket api point",
            default: "ws://localhost:8080",
          }),
      handler: async (
        args: yargs.Arguments<{
          wasm_path: string;
          header_data: string;
          para_id: number;
          is_parachain: boolean;
          ws_url: string;
        }>
      ): Promise<void> => {
        await cryptoWaitReady();

        const keyring = new Keyring({ type: "sr25519" });
        const alice = keyring.addFromUri("//Alice");
        const api = await createApi("", args.ws_url);
        const nonce = (
          await api.query.system.account(alice.address)
        ).nonce.toNumber();
        const wasm_data = read_genesis_wasm(args.wasm_path);
        const genesis_state = read_genesis_state(args.header_data);

        await register_parachain(
          api,
          String(args.para_id),
          wasm_data,
          genesis_state,
          nonce
        );

        await api.disconnect();
      },
    })
    .command({
      command:
        "test_parachain [parachain_types] [ws_url] [para_id] [height_limit]",
      describe: "Test a parachain",
      builder: (yargs) =>
        yargs
          .positional("parachain_types", {
            type: "string",
            describe: "path to custom types of the parachain",
            default: "",
          })
          .positional("ws_url", {
            type: "string",
            describe: "path to websocket api point",
            default: "ws://localhost:8080",
          })
          .positional("para_id", {
            type: "number",
            describe: "Id of the para to test",
          })
          .positional("height_limit", {
            type: "number",
            describe: "how many blocks to wait for the test",
            default: 100,
          }),
      handler: async (
        args: yargs.Arguments<{
          parachain_types: string;
          ws_url: string;
          para_id: number;
          height_limit: number;
        }>
      ): Promise<void> => {
        test_parachain(
          args.parachain_types,
          args.ws_url,
          args.para_id,
          args.height_limit
        );
      },
    })
    .command({
      command: "check_registration [ws_url] [para_id]",
      describe: "Check if the parachain is registered",
      builder: (yargs) =>
        yargs
          .positional("ws_url", {
            type: "string",
            describe: "path to websocket api point",
            default: "ws://localhost:8080",
          })
          .positional("para_id", {
            type: "number",
            describe: "Id of the para to test",
          }),
      handler: async (
        args: yargs.Arguments<{
          ws_url: string;
          para_id: number;
        }>
      ): Promise<void> => check_registration(args.ws_url, args.para_id),
    })
    .command({
      command: "clear_authorities <spec_file>",
      describe: "Remove all authorities from the chainspec file",
      builder: (yargs) =>
        yargs.positional("spec_file", {
          type: "string",
          describe: "path to chainspec file",
        }),
      handler: async (args: yargs.Arguments<{ spec_file: string }>) => {
        await clearAuthorities(args.spec_file);
      },
    })
    .command({
      command: "add_authority <spec_file> <authority>",
      describe: "Add an authority to the chainspec file",
      builder: (yargs) =>
        yargs
          .positional("spec_file", {
            type: "string",
            describe: "path to chainspec file",
          })
          .positional("authority", {
            type: "string",
            describe: "seed of the authority identity to add",
          }),
      handler: async (
        args: yargs.Arguments<{ spec_file: string; authority: string }>
      ): Promise<void> => {
        addAuthorities(args.spec_file, [args.authority]);
      },
    })
    .command({
      command: "add_authorities_from_file <spec_file> <authorities_file>",
      describe:
        "Clear existing authorities from chainspec and add authorities with seeds from file",
      builder: (yargs) =>
        yargs
          .positional("spec_file", {
            type: "string",
            describe: "path to chainspec file",
          })
          .positional("authorities_file", {
            type: "string",
            describe: "path to file with authority key seeds",
          }),
      handler: async (
        args: yargs.Arguments<{ spec_file: string; authorities_file: string }>
      ): Promise<void> => {
        addAuthoritiesFromFile(args.spec_file, args.authorities_file);
      },
    })
    .command({
      command: "retrieve_best_block [ws_url] [filename]",
      describe: "Retrieve last finalized block from the chain and store it in system variable",
      builder: (yargs) =>
        yargs
          .positional("ws_url", {
            type: "string",
            describe: "path to websocket api point",
            default: "ws://localhost:8080",
          })
          .positional("filename", {
            type: "string",
            describe: "File where to save the retrieved value",
          }),
      handler: async (
        args: yargs.Arguments<{
          ws_url: string;
          filename: string;
        }>
      ): Promise<void> => retrieveLastBlock(args.ws_url, args.filename),
    })

    .parserConfiguration({
      "parse-numbers": false,
      "parse-positional-numbers": false,
    })
    .demandCommand(1, "Choose a command from the above list")
    .strict()
    .help().argv;
}

try {
  run();
} catch (err) {
  console.error(err);
  process.exit(1);
}
