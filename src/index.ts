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

async function showSystemEvents(api: ApiPromise) {
  console.log(`Show system events`);
  api.query.system.events((events) => {
    console.log(`\nReceived ${events.length} events:`);

    events.forEach((record) => {
      const { event, phase } = record;
      const types = event.typeDef;

      console.log(
        `\t${event.section}:${event.method}:: (phase=${phase.toString()})`
      );
      console.log(`\t\t${event.meta.documentation.toString()}`);

      event.data.forEach((data, index) => {
        console.log(`\t\t\t${types[index].type}: ${data.toString()}`);
      });
    });
  });
}

async function createApi(url: string) {
  const provider = new WsProvider(url);

  const apiRequest = await Promise.race([
    ApiPromise.create({ provider }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 3000)
    ),
  ]).catch(function (err) {
    console.log("API creation error");
    throw Error(`Timeout error: ` + err.toString());
  });
  return apiRequest as ApiPromise;
}

async function register_parachain(
  wasm_path: string,
  header_path: string,
  para_id: number,
  is_parachain: boolean,
  ws_url: string
): Promise<void> {
  await cryptoWaitReady();
  let wasm_data = "";
  try {
    wasm_data = fs.readFileSync(wasm_path, "utf8");
  } catch (err) {
    throw Error("Cannot read wasm from file: " + err);
  }
  let header_data = "";
  try {
    header_data = fs.readFileSync(header_path, "utf8");
  } catch (err) {
    throw Error("Cannot read header from file: " + err);
  }

  const keyring = new Keyring({ type: "sr25519" });
  const alice = keyring.addFromUri("//Alice");
  const api = await createApi(ws_url);
  const aliceNonce = (
    await api.query.system.account(alice.address)
  ).nonce.toNumber();

  const paraGenesisArgs = {
    genesis_head: header_data,
    validation_code: wasm_data,
    parachain: true,
  };

  const genesis = api.createType("ParaGenesisArgs", paraGenesisArgs);

  console.log(`Submitting extrinsic to register parachain ${para_id}.`);
  const unsub = await api.tx.sudo
    .sudo(api.tx.parasSudoWrapper.sudoScheduleParaInitialize(para_id, genesis))
    .signAndSend(alice, { nonce: aliceNonce, era: 0 }, (result) => {
      console.log(`Current status is ${result.status}`);
      if (result.status.isInBlock) {
        console.log(
          `Transaction included at blockHash ${result.status.asInBlock}`
        );
      } else if (result.status.isFinalized) {
        console.log(
          `Transaction finalized at blockHash ${result.status.asFinalized}`
        );
        unsub();
      }
    });

  await showSystemEvents(api);
  await new Promise((r) => setTimeout(r, 120000));
  process.exit(0);
}

async function test_registration(
  api: ApiPromise,
  para_id: number
): Promise<boolean> {
  const parachains = await api.query.paras.parachains<Vec<ParaId>>();
  if (!parachains.find(id => id.toString() == para_id.toString())) {
    return false;
  }
  return true;
}

async function check_registration(
  ws_url: string,
  para_id: number
): Promise<void> {
  const api = await createApi(ws_url);
  if (!await test_registration(api, para_id)) {
    const err_str = `Parachain with id ${para_id} is not registered}`;
    throw Error(err_str);
  }
  console.log("Parachain is registered");
  process.exit(0);
}

async function test_parachain(
  ws_url: string,
  para_id: number,
  height_limit: number
): Promise<void> {
  const api = await createApi(ws_url);

  let break_condition = false;
  let attempt = 0;
  while (!break_condition) {
    //check registration every 2 seconds
    await new Promise(r => setTimeout(r, 2000));

    if (await test_registration(api, para_id)) {
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
  process.exit(0);
}
function run() {
  const parser = yargs(process.argv.slice(2))
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
      ): Promise<void> =>
        register_parachain(
          args.wasm_path,
          args.header_data,
          args.para_id,
          args.is_parachain,
          args.ws_url
        ),
    })
    .command({
      command: "test_parachain [ws_url] [para_id] [height_limit]",
      describe: "Test a parachain",
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
          })
          .positional("height_limit", {
            type: "number",
            describe: "how many blocks to wait for the test",
            default: 100,
          }),
      handler: async (
        args: yargs.Arguments<{
          ws_url: string;
          para_id: number;
          height_limit: number;
        }>
      ): Promise<void> => {
        test_parachain(args.ws_url, args.para_id, args.height_limit);
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
      ): Promise<void> =>
        check_registration(args.ws_url, args.para_id),
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